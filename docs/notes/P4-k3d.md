# P4: production values on k3s (k3d rehearsal), 2026-10-18

Goal: prove "same charts, config change only". The three charts run on k3s
with `values-prod.yaml` (Traefik, local-path, GHCR image names) and no template
edits per environment. Mac mini and VPS runs are not executed yet (they wait for
the go and for the GHCR push).

## Setup

| Item | Value | Evidence |
|---|---|---|
| k3d | v5.9.0, sha256 checked | `k3d version` |
| k3s | v1.35.5+k3s1 | `kubectl get nodes` |
| Ingress | bundled Traefik, image `rancher/mirrored-library-traefik:3.6.13`, IngressClass `traefik` | `kubectl get ingressclass` |
| Storage | `local-path` (default) | `kubectl get storageclass` |
| Images | local images retagged to `ghcr.io/kss004/kubernetesbasedmcpgateway/<name>:<tag>` and loaded with `k3d image import`. Nothing pushed. | `docker images` |
| Ports | k3d load balancer on 8081 (http) and 8444 (https), so kind keeps 80/443 | `k3d cluster create ... -p 8081:80@loadbalancer` |
| kubeconfig | separate file (`k3d kubeconfig write`), kind stays the current context | `kubectl config current-context` → `kind-urumi` |

One command: `make prod-up`, then `make prod-check` (smoke + e2e).

## NetworkPolicy enforcement on k3s (D2)

k3s enforces NetworkPolicy with its embedded kube-router, not kindnet, so the
pair test was re-run before relying on it:

```
$ KUBECONFIG=~/.config/k3d/kubeconfig-urumi-prod.yaml bash scripts/test-netpol.sh
== baseline (no policy) ==
allowed=OK denied=OK
== with policies ==
allowed=OK denied=FAIL
ENFORCED: allowed connects, denied blocked
```

## Problems the k3s run found (all fixed in the charts)

1. **NetworkPolicies admitted only the `ingress-nginx` namespace.** On k3s, Traefik runs in
   `kube-system`, so every request would be dropped. Now `ingress.controllerNamespace` and
   `ingress.controllerPodLabels` (prod: `kube-system` + `app.kubernetes.io/name: traefik`, so only Traefik, not all of kube-system).
2. **Bootstrap Job raced the NetworkPolicy.** kube-router adds a new pod's IP to the allow-list
   1-2s after the pod starts. Measured with a throwaway pod carrying the bootstrap label, retrying
   every second: `allowed after 2s`. The Job's first `wp` call hit the DB at once and failed 4 times.
   Fix: the bootstrap retries a mysqli connection (30 tries, 2s apart, a little over 60s) before the
   first `wp` call, and exits with `database never reachable` if it never connects.
   kindnet never showed this gap.
3. **WordPress probes followed a redirect to a dead port.** WordPress redirects `/` to the
   canonical URL. With `storeUrl=http://shop.localhost:8081` the probe was sent to
   `http://<pod-ip>:8081/`: `connection refused`, liveness restarts, pod never ready.
   Fix: readiness probes `/?rest_route=/`. A REST request ends in `parse_request`, before
   `template_redirect` where the canonical and SSL redirects run; it works without pretty
   permalinks and still loads PHP + DB. Liveness is a TCP check on port 80 (a DB outage makes
   the pod not-ready, not restarted).
   A first fix used `/wp-login.php`; the validation pass caught that an `https://` storeUrl
   turns on `FORCE_SSL_ADMIN` (`wp-includes/default-constants.php:353-355`), so wp-login.php
   redirects too. Checked live on `urumi-prod2` with `storeUrl=https://shop.localhost:8445`:
   `wp-login.php 302 -> https://shop.localhost:8445/wp-admin/`, `?rest_route=/ 200`, pod ready,
   0 restarts.
4. **`helm install --wait` deadlocks the store chart.** woo-mcp needs the Secret that the
   post-install bootstrap creates, and `--wait` holds the hooks until all pods are ready.
   The store is installed without `--wait` (as `make up` already did); `make prod-up` notes why.
5. **Gateway was killed in a loop on a first install.** On a new cluster, pulling `postgres:17`
   took about 1.5 min. The gateway listens only after its migrations, which wait for Postgres,
   so liveness got `connection refused` and killed it (exit 137, 2 restarts); a smoke run in that
   window failed 8 checks. kind never showed it because the image was cached.
   Fix (gateway 0.4.2): a `startupProbe` (40 x 5s) holds liveness off until the first `/healthz`,
   and the migration wait is 60 x 3s instead of 10 x 3s.
6. **A fresh `make up` registered only woo.** mock and everything had been added by hand on kind.
   `make seed` now upserts all three.

## End-to-end on k3d

```
$ make prod-check        # smoke.sh + e2e.sh against app.localhost:8081 / shop.localhost:8081
smoke: all checks passed
PASS /mcp woo__create_product -> product 11
PASS storefront COD checkout -> order 12
PASS /mcp woo__get_order 12 shows the product
PASS e2e key revoked
PASS revoked key gets 401
e2e: all checks passed
```

The storefront loads open (not "Coming soon") on this fresh install, which also
confirms the bootstrap fix from commit 2909462.

## Upgrade and rollback rehearsal (Helm 4 flags)

```
== 1. bad upgrade (tag does not exist)
$ helm upgrade gateway ./charts/gateway -n urumi-gateway -f charts/gateway/values-prod.yaml \
    --set appHost=app.localhost --set gatewayTag=0.0.0-missing --rollback-on-failure --timeout 90s
Error: UPGRADE FAILED: release gateway failed, and has been rolled back due to rollback-on-failure being set: ...
after: users=1 servers=3 image=.../gateway:0.4.1
== 2. good upgrade
$ helm upgrade gateway ... --set gatewayTag=0.4.2-rehearsal --rollback-on-failure --timeout 3m
STATUS: deployed  REVISION: 4
after: users=1 servers=3 image=.../gateway:0.4.2-rehearsal
== 3. manual rollback
$ helm rollback gateway 1 -n urumi-gateway --wait --timeout 3m
Rollback was a success! Happy Helming!
after: users=1 servers=3 image=.../gateway:0.4.1
$ helm history gateway -n urumi-gateway
1  superseded  Install complete
2  failed      Upgrade "gateway" failed: ... not ready
3  superseded  Rollback to 1
4  superseded  Upgrade complete
5  deployed    Rollback to 1
```

During the failed upgrade the old pod kept serving (RollingUpdate: the new pod never
became ready, so the old one was never removed). Users and servers in Postgres survived
every step. smoke + e2e passed again after the rollback (product 13, order 14).

Helm 4 note: a value passed with `--set` sticks to the release and is reused by later
upgrades. After a manual `--set`, check `helm get values <release>` or upgrade with
`--reset-values`.

## Fresh one-command run

`make prod-up` on brand-new clusters (nothing cached), then `make prod-check`:

| Run | Cluster | Result |
|---|---|---|
| 1 | `urumi-prod2` (port 8082), gateway 0.4.1 | prod-up exit 0, but the first prod-check failed 8 app checks: the gateway was being killed while Postgres was still pulling (problem 5). A re-run a minute later passed. |
| 2 | `urumi-prod3` (port 8083), gateway 0.4.2 | prod-up exit 0; prod-check: smoke 10/10, e2e 5/5 on the first try; every pod `restarts=0`. |

```
$ make prod-up PROD_CLUSTER=urumi-prod3 PROD_PORT=8083 PROD_TLS_PORT=8446   # exit=0
$ make prod-check PROD_CLUSTER=urumi-prod3 PROD_PORT=8083
smoke: all checks passed
e2e: all checks passed
gateway-gateway 1/1 Running restarts=0
gateway-postgres-0 1/1 Running restarts=0
store-mariadb-0 1/1 Running restarts=0
store-woo-mcp 1/1 Running restarts=0
store-wordpress 1/1 Running restarts=0
upstreams-everything-mcp 1/1 Running restarts=0
upstreams-mock-mcp 1/1 Running restarts=0
```

kind was upgraded to the same charts and gateway 0.4.2; `make smoke` passes there too.

## Validation loop

1. After every change: `make prod-check` (smoke + e2e) on k3d and `make smoke` on kind.
2. An independent read-only subagent re-checked tests, `helm lint` (9 runs), the prod render,
   live cluster state on `urumi-prod3`, the rollback history on `urumi-prod`, the NetworkPolicy
   test and this note. All live checks passed. It found the wp-login.php https redirect (above),
   a PHP 8.1+ mysqli exception in the DB wait, an e2e key not revoked on interrupt, and unclear
   seed errors. All fixed.
3. Round 2 after the fixes: `make smoke` on kind, `make prod-check` on `urumi-prod` and
   `urumi-prod3`: all passed; gateway pods `restarts=0`.

## Not covered by this rehearsal

- arm64 (Mac mini) and a real VPS: same charts, not executed.
- GHCR push and `imagePullSecrets`: rendered and linted, not exercised (images imported locally).
- TLS: `ingress.tlsSecretName` renders a `tls:` block, but no certificate was issued (no public domain).
- Traefik streaming of the chat SSE: Traefik does not buffer responses by default; the chat
  stream was not exercised on k3d (placeholder LLM key on the fresh cluster).
