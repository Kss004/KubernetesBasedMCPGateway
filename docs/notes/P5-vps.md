# P5: production on a VPS (k3s + Let's Encrypt), 2026-10-21

Goal: run the same three charts on a real public host with HTTPS. The deploy ran on the box
itself (a Claude Code session on the VPS), not over SSH.

## Host

| Item | Value | Evidence |
|---|---|---|
| VPS | Contabo Cloud VPS 4: 4 vCPU, 8 GB RAM, 100 GB disk, amd64 | `nproc`, `free -h`, `df -h /` |
| OS | Ubuntu 24.04.5 LTS, kernel 6.8.0-147 after `apt upgrade` and a reboot | `uname -r` |
| Public IP | 169.58.78.14 | `hostname -I` |
| Hosts | `app.169-58-78-14.sslip.io`, `shop.169-58-78-14.sslip.io` (sslip.io, no DNS records) | `getent hosts` → 169.58.78.14 |
| k3s | v1.36.5+k3s1 (official installer, default flags), containerd 2.3.4-k3s1.36 | `kubectl get nodes -o wide` |
| Traefik | bundled, `rancher/mirrored-library-traefik:3.7.13`, chart 40.1.5 | `kubectl -n kube-system get deploy traefik -o jsonpath=...image` |
| Helm | v4.3.0, sha256 checked | `helm version` |
| cert-manager | v1.21.2, OCI chart `oci://quay.io/jetstack/charts/cert-manager`, `crds.enabled=true` | `helm list -n cert-manager` |
| Images | built on the box with `make images`, retagged to the GHCR names, imported with `docker save ... \| k3s ctr -n k8s.io images import -`. Nothing pushed. | `k3s crictl images` |

The rehearsal (P4) used k3s v1.35.5 and Traefik 3.6.13. This host is newer on both.

## Firewall

ufw: default deny incoming; 22/tcp LIMIT, 80/tcp and 443/tcp open; allow from `10.42.0.0/16` and
`10.43.0.0/16` (k3s pod and service CIDRs, from the k3s requirements page). 6443 stays closed:
kubectl runs on the box. SSH password login is still on until key login is confirmed.

A hand-made Docker Traefik (`/opt/traefik`) held 80/443 before k3s; it was stopped with
`docker compose stop` (not removed).

## Install sequence

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
APP=app.169-58-78-14.sslip.io SHOP=shop.169-58-78-14.sslip.io

curl -sfL https://get.k3s.io | sh -
make images     # then docker tag <img> ghcr.io/kss004/kubernetesbasedmcpgateway/<img>; docker save | k3s ctr -n k8s.io images import -

helm install cert-manager oci://quay.io/jetstack/charts/cert-manager --version v1.21.2 \
  --namespace cert-manager --create-namespace --set crds.enabled=true --wait
kubectl apply -f <ClusterIssuers + Certificates below>

for n in urumi-gateway urumi-store urumi-upstreams; do kubectl create ns $n --dry-run=client -o yaml | kubectl apply -f -; done
kubectl -n urumi-gateway create secret generic llm-opencode --from-literal=api-key=placeholder-change-me
kubectl -n urumi-gateway create secret generic llm-groq --from-literal=api-key=placeholder-change-me

helm upgrade --install store ./charts/store -n urumi-store -f charts/store/values-prod.yaml \
  --set storeHost=$SHOP --set storeUrl=https://$SHOP --set ingress.tlsSecretName=shop-tls --timeout 10m
helm upgrade --install upstreams ./charts/upstreams -n urumi-upstreams -f charts/upstreams/values-prod.yaml
helm upgrade --install gateway ./charts/gateway -n urumi-gateway -f charts/gateway/values-prod.yaml \
  --set appHost=$APP --set ingress.tlsSecretName=app-tls --wait --timeout 5m
GW_NS=urumi-gateway STORE_NS=urumi-store STORE_RELEASE=store GW_RELEASE=gateway bash scripts/seed.sh
```

`cookieSecure` stays `true` (https). The store is installed without `--wait` (P4 problem 4).

## TLS (first real exercise of the charts' `tls:` block)

cert-manager, ACME HTTP-01 through Traefik. Two ClusterIssuers (no account email):

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt-prod }   # letsencrypt-staging: acme-staging-v02 URL
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef: { name: letsencrypt-prod-account-key }
    solvers:
      - http01: { ingress: { ingressClassName: traefik } }
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: app-tls, namespace: urumi-gateway }   # shop-tls in urumi-store for $SHOP
spec:
  secretName: app-tls
  dnsNames: [app.169-58-78-14.sslip.io]
  issuerRef: { name: letsencrypt-prod, kind: ClusterIssuer }
```

Staging first (issuer `(STAGING) Ersatz Emmer YR2`), then `issuerRef` patched to prod:
issuer `Let's Encrypt YR1`, `notAfter=Jan 19 10:57:52 2027 GMT` for both hosts.

## Problems the VPS run found

1. **WooCommerce rejected every signed REST call over https (`401 Invalid signature`).**
   WooCommerce builds the OAuth base string with `get_home_url(..., is_ssl() ? 'https' : 'http')`
   (`class-wc-rest-authentication.php:581` in the running pod). woo-mcp signs with the public
   `https://shop...` URL but calls WordPress over plain in-cluster http, so `is_ssl()` was false and
   the server's base string said `http://`. The rehearsal was http-only, so it never showed.
   Fix (woo-mcp 0.1.6): when the home URL is https, send `X-Forwarded-Proto: https`; the official
   WordPress image's `wp-config.php` maps that to `HTTPS=on`. Before: e2e 2/5. After: e2e 5/5.
2. **Certificate renewal would have failed.** cert-manager answers HTTP-01 from a solver pod it
   starts in the Certificate's namespace (label `acme.cert-manager.io/http01-solver: "true"`,
   port 8089, from cert-manager v1.21.2 `pkg/issuer/acme/http/pod.go`). The charts'
   `default-deny-ingress` blocks it. The first issue only worked because the charts were not
   installed yet. Fix: `acme-solver-ingress` NetworkPolicy in the gateway and store charts, on when
   `ingress.acmeHttp01: true` (prod values), admitting only the ingress controller on 8089.
   Proof: with all policies in place, fresh staging Certificates for new names
   (`renewtest-app...`, `renewtest-shop...`) ran a real challenge (`cm-acme-http-solver-*` pods,
   events `Presented challenge using HTTP-01`) and became Ready. Repeated after problem 3's fix.
   A fresh name is needed: Let's Encrypt reuses a valid authorization, so re-issuing an already
   verified name runs no challenge and proves nothing.
3. **Every client had the same IP (`10.42.0.1`), so the login limiter's IP lock was global.**
   Captured with `tcpdump -i any -A 'tcp port 3000'`: `X-Forwarded-For: 10.42.0.1`.
   `externalTrafficPolicy: Local` did not help: the ServiceLB pod (klipper-lb v0.4.17) always adds
   `iptables -t nat -I POSTROUTING -d <node>/32 -j MASQUERADE` (its own log). Fix: Traefik binds
   80/443 with `hostPort` (CNI portmap keeps the source) and its Service is ClusterIP, so no
   ServiceLB pod. File `/var/lib/rancher/k3s/server/manifests/traefik-config.yaml`:
   ```yaml
   apiVersion: helm.cattle.io/v1
   kind: HelmChartConfig
   metadata: { name: traefik, namespace: kube-system }
   spec:
     valuesContent: |-
       service: { spec: { type: ClusterIP } }
       ports: { web: { hostPort: 80 }, websecure: { hostPort: 443 } }
       updateStrategy: { rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } }
   ```
   `maxSurge: 0`: on one node a new Traefik pod cannot bind the ports until the old one stops,
   so a Traefik update has a few seconds of downtime. After the fix a request from the box to its
   public IP arrives as `X-Forwarded-For: 169.58.78.14` (the real source; before: 10.42.0.1).
   From the user's PC (browser session, 50 requests captured): every request arrived as the
   user's own public address (`223.181.x.x`, masked here), none as 10.42.0.1.

## Verify

```
$ PROTO=https APP_HOST=$APP SHOP_HOST=$SHOP bash scripts/smoke.sh
... 13 x PASS
smoke: all checks passed
$ PROTO=https APP_HOST=$APP SHOP_HOST=$SHOP bash scripts/e2e.sh
PASS /mcp woo__create_product -> product 13
PASS storefront COD checkout -> order 14
PASS /mcp woo__get_order 14 shows the product
PASS e2e key revoked
PASS revoked key gets 401
e2e: all checks passed
$ bash scripts/test-netpol.sh
== baseline (no policy) ==
allowed=OK denied=OK
== with policies ==
allowed=OK denied=FAIL
ENFORCED: allowed connects, denied blocked
```

All pods Running, restarts 0 (cert-manager x3, gateway, postgres, mariadb, woo-mcp, wordpress,
mock-mcp, everything-mcp). smoke and e2e were run again after the Traefik change: same result.
e2e.sh needs `node` on the host; Node v24.22.0 was installed from nodejs.org (sha256 checked).

## Browser checks (user's PC, 2026-10-21)

- Logged in as A (admin) at `https://app.169-58-78-14.sslip.io`: valid Let's Encrypt
  certificate, Secure session cookie kept across pages.
- Chat with the real LLM keys: "list the products in the store" called `woo list_products`
  and answered with the store's products, over https through Traefik.
- `https://shop.169-58-78-14.sslip.io` serves the storefront (not "Coming soon");
  `/wp-admin` login as `admin` works (WordPress 7.1.3, WooCommerce live).
- Users A (admin) and B (member) created with the admin API (README section 3, step 3, with
  the https URL); passwords typed by the user at a silent prompt.

## Final run (after the LLM keys and users)

smoke 13/13, e2e 5/5 (product 16, order 17), `test-netpol.sh` ENFORCED, all pods Running with
0 restarts, `app-tls` and `shop-tls` Ready from `letsencrypt-prod`.
