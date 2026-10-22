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
kubectl apply -f <ClusterIssuers below>   # the Certificates come from the charts

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
```

The Certificates (`app-tls`, `shop-tls`) were first created by hand: staging first (issuer
`(STAGING) Ersatz Emmer YR2`), then `issuerRef` patched to prod: issuer `Let's Encrypt YR1`,
`notAfter=Jan 19 10:57:52 2027 GMT` for both hosts. They now come from the charts
(`templates/certificate.yaml`, rendered when `ingress.tlsSecretName` and `ingress.certIssuer` are
both set; `values-prod.yaml` sets `certIssuer: letsencrypt-prod`). The two hand-made objects were
adopted into the releases without a reissue (see "Review fixes, round 4").

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

4. **Plain http was served, not redirected** (found in the final browser QA). Chrome upgrades to
   https on its own, but other clients got the dashboard over http, where the `Secure` session
   cookie is dropped, so a login would silently fail. Fix: `ingress.httpsRedirect: true` (prod)
   renders a Traefik `Middleware` (`redirectScheme: https`, permanent) and attaches it to the app
   and shop Ingresses; only when `tlsSecretName` is set, so the k3d rehearsal is unchanged.
   Result: `GET http://...` -> 301, `POST http://.../mcp` -> 308 (method kept), https -> 200, one hop.
   Renewal still works: with a temporary staging ACME account (forcing a fresh authorization on
   the real names), the challenge URL answered 200 over http (no redirect: the solver Ingress is a
   separate, more specific router) and both `app.` and `shop.` showed `DomainVerified`. The temporary
   issuer and certificates were deleted afterwards. smoke 13/13, e2e 5/5, netpol ENFORCED after it.

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

## Harbor rename and restyle (gateway 0.4.15, 2026-10-21)

- Visible product name is now **Harbor**: dashboard wordmark and title, MCP `serverInfo.name`
  `harbor-gateway`, `WWW-Authenticate: Bearer realm="harbor"`, LLM `User-Agent: harbor-gateway/0.4`.
  Namespaces (`urumi-*`) and the kind cluster name are unchanged, so no reinstall was needed.
- Dashboard restyled after urumi.ai (tokens read from the live site in Chrome): cream canvas
  `#f3f2ed`, ink `#121517`, teal accent `#136b69`, frosted pill header, pill buttons, mono
  uppercase labels, italic teal heading accents. System fonts only (CSP `default-src 'self'`).
- Deployed with `helm upgrade gateway ... --rollback-on-failure`; smoke 13/13, all pods restarts 0;
  Servers, Team & Keys, Audit and Chat checked in Chrome.

## Restyle round 2 (gateway 0.4.16, 2026-10-21, not yet deployed)

Closes the gaps left by 0.4.15 against urumi.ai (read from the fully rendered site):
- **Fonts self-hosted.** 0.4.15 named Switzer but shipped no file, so browsers used system fonts.
  JetBrains Mono comes from npm (OFL). Switzer is fetched from Fontshare at build time
  (`make fonts`, run by `make images`) into the gitignored `apps/dashboard/public/fonts/`: its
  licence allows self-hosting but not redistribution, and the repo is public. The gateway now
  serves `dist/fonts/*.woff2` as exact paths listed once at boot (`apps/gateway/src/dashboard.ts`,
  `test/dashboard.test.ts`); Vite no longer inlines assets as `data:` URLs (the CSP blocks them).
  CSP is unchanged.
- **Motion:** pages fade and rise 16px on entry (0.5s, staggered), header slides in, typing
  dots while the agent works, pulsing live dots; all off under `prefers-reduced-motion`.
- **Chat:** ink user bubbles, tinted agent bubbles, tool calls as cards (dark mono server tag,
  teal edge, red on failure), three quick-start prompts, a "Working as <user> · <role>" line.
- **Servers:** a mono "harbor · mcp" card with a live count, one row per server with status on
  the right and tools as chips.
- **Cursor spotlight:** urumi.ai's hero glow (their `vision-v2-hero-spotlight`): a 700px teal
  radial gradient, blurred 40px, that trails the pointer. They use Framer Motion's
  `useSpring(stiffness 80, damping 22, mass 0.6)`; `Spotlight` in `ui.jsx` integrates the same
  spring by hand (no animation library). Overdamped, so no bounce; off on touch and reduced
  motion; the frame loop stops once it settles.
- **Page heads:** "01 / SERVERS" eyebrow, large heading with an italic teal accent, short lead.
  The new-key reveal is a dark ink panel.

Verified locally only (Docker Desktop was not running): `npm test -w apps/gateway` 59/59; the
built dashboard served through `loadDashFiles` with the gateway's CSP and a mock API: Switzer
roman + italic and JetBrains Mono load, no CSP errors, all four tabs and a streamed chat render,
no horizontal scroll at 375px. Not yet run: `make images`, `helm upgrade` and smoke on the VPS.

Deploy on the VPS: `git pull && make images` (fetches Switzer), retag and import the gateway image
as in the install sequence, then the README upgrade command:
`helm upgrade gateway ./charts/gateway -n urumi-gateway -f charts/gateway/values-prod.yaml
--set appHost=app.169-58-78-14.sslip.io --set ingress.tlsSecretName=app-tls --set gatewayTag=0.4.16
--rollback-on-failure --timeout 3m`, then `make smoke` with `PROTO=https` (now 14 checks: one more for a served font).

## Tester feedback round (gateway 0.4.17, woo-mcp 0.1.7, 2026-10-21)

A tester using A reported three issues:

1. **Currency.** `list_orders`, `list_products` and `create_product` returned bare amounts, so the
   model guessed the currency. woo-mcp now reads the store currency once
   (`GET /wc/v3/data/currencies/current`, cached) and every amount carries `currency` (ISO code)
   and `symbol`.
2. **Order pagination.** `list_orders` only had `complete: orders.length < perPage` and summed
   just the fetched page. It now reads WooCommerce's `X-WP-Total`/`X-WP-TotalPages`, returns
   `page`, `per_page`, `total_pages`, and its `count`/`total` cover **every** matching order
   (walked in pages of 100, capped at 1,000; `complete` says whether the cap was hit).
   `list_products` returns `total_products`/`total_pages` too. Checked live: page 2 of size 3
   returned #17, #14, #12 with `count 6, total 59.94 USD`, the same as one full fetch.
   New **Orders** tab in the dashboard (`GET /api/orders`): status and date filters, First/Prev/
   Next/Last, page size 10-100. It calls `woo__list_orders` the same way chat does (role grants,
   schema check, one audit row per page load), so it shows nothing a member could not already
   get. 401 without a session.
3. **Several people on one account.** Not changed (login logic is the hand-written T4.3 zone):
   Logout bumps `session_version`, which by design ends **every** session of that user, so one
   tester logging out kicks the others; the login limiter also locks the user name for all of
   them. The supported model is one user per person.

After this round: smoke 14/14, e2e 5/5, netpol ENFORCED, 0 restarts.

## Review fixes, round 1 (2026-10-21, gateway 0.4.18, woo-mcp 0.1.8)

From an outside review of the repo. Each item checked live on the VPS after the upgrade:
1. **Members could break a shared upstream.** `mock__break_me` (fails every mock tool until the pod
   restarts) and `mock__sleep_forever` were open to members. Both are now in the member deny list.
   A member key lists 7 tools, and `mock__break_me` gets `-32000 forbidden for role` with a
   `denied` audit row.
2. **Order times.** `list_orders` also returns `created_gmt`; the Orders page shows that in the
   viewer's timezone instead of treating the store-local `created` as UTC (it only matched because
   this store runs on UTC). `created` is unchanged, since `after`/`before` use the same clock.
3. **Orders audit.** A reply that is not JSON wrote an `ok` row and then an `error` row; now it is
   one row and a 502 "unreadable reply".
4. **Lost audit writes** are logged (`audit write failed ...`) instead of disappearing; requests
   still succeed. **500 errors** return `internal error` and log the detail. **`/mcp` without a
   bearer key** gets 401 before the body is read.
5. **woo-mcp NetworkPolicy** now admits only `app: gateway` pods in `urumi-gateway`. Checked:
   Postgres -> woo-mcp:3000 is blocked, the gateway connects. `test-netpol.sh` now deletes its
   namespace on exit.

After this round: unit tests 68 + 4, smoke 14/14, e2e 5/5, netpol ENFORCED, 0 restarts.

## Review fixes, round 2: SSRF guard (2026-10-21, gateway 0.4.19)

The old guard allowed only in-cluster Services, so an admin could not add a hosted MCP server by
URL at all. `apps/gateway/src/egress.ts` now allows in-cluster Services (as before) **or** a
public `https` host, and blocks internal targets twice: every resolved address at save time, and
again on every connection (a pinned `undici` lookup, so DNS rebinding fails; redirects refused).
Checked live through the admin API, all `400`, nothing saved:
`169-254-169-254.sslip.io`, `10-43-0-10.sslip.io` and `127-0-0-1.sslip.io` ("resolves to a
private or reserved address"), `https://169.254.169.254`, `http://mcp.deepwiki.com` (http),
`gateway-postgres.urumi-gateway.svc.cluster.local`, `[::ffff:a9fe:a9fe]`, and an unresolvable
name. From the VPS, the guarded transport connects to `https://mcp.deepwiki.com/mcp` and lists
its 3 tools. The 3 existing servers stay Connected. Unit tests 78 (10 new for the guard); smoke
14/14, e2e 5/5.

## Review fixes, round 3: a third-party upstream (2026-10-21)

Registered DeepWiki (`https://mcp.deepwiki.com/mcp`, no credential) with `make seed`, which now
adds it when the cluster has internet (`DEEPWIKI_URL=` skips it). Checked live: 4 servers
Connected, 14 tools for an admin and 10 for a member; a member key called
`deepwiki__read_wiki_structure` for `modelcontextprotocol/typescript-sdk` in about 2s, with an `ok`
audit row under that member. smoke 14/14 (its "every enabled upstream is Connected" check now
includes DeepWiki, so a DeepWiki outage fails that one check), e2e 5/5.

## Review fixes, round 4: Certificates in the charts, crypto tests (2026-10-21)

- `charts/{gateway,store}/templates/certificate.yaml` render the cert-manager Certificate from
  `ingress.tlsSecretName` + `ingress.certIssuer`. The live `app-tls` and `shop-tls` (made by
  hand) were adopted by adding the Helm ownership label and the two `meta.helm.sh/release-*`
  annotations, then `helm upgrade` both releases. The rendered spec equals the live one, so
  nothing was reissued: both stay at revision 2, `notAfter=2027-01-19T10:57:52Z`, no new
  CertificateRequest. The ClusterIssuers stay cluster-wide objects created once, outside the
  charts.
- `apps/gateway/test/crypto.test.ts`: round trip, layout, fresh IV, wrong key, tampered IV /
  ciphertext / tag, truncated blob, wrong key size. Unit tests 84.

## Review fixes, round 5: `everything` renamed to `utils` (2026-10-21, utils-mcp 0.1.2)

The third in-cluster upstream was called `everything`, the name of the official reference server,
which it is not. Renamed throughout: `apps/utils-mcp`, image `utils-mcp:0.1.2`, Deployment and
Service `upstreams-utils-mcp`, NetworkPolicy `utils-mcp-ingress`, server slug `utils`, tools
`utils__echo` / `utils__add`. Live: `helm upgrade upstreams` replaced the old objects, `make seed`
registered `utils`, and the old `everything` row was deleted through the admin API (older audit rows
keep the old slug as text). Checked: 4 servers Connected, 14 tools; a member key called
`utils__add(2,3)` and got 5; scaling `upstreams-utils-mcp` to 0 showed `utils` Unreachable while the
others stayed Connected, and it recovered at 1. smoke 14/14, e2e 5/5. Dated notes above and in
`P4-k3d.md` / `E2E-*` keep the old name.

## Stand-out: observability (2026-10-22, gateway 0.4.20)

- Per-server metrics from the audit table (no new work on the request path): calls, ok / error /
  denied, error rate (errors over calls that reached the upstream), p50 / p95 / max latency and
  error classes. `GET /api/metrics?window=1h|24h|7d` (admin) feeds a stats line per server on the
  Servers page; `GET /metrics` serves the same as Prometheus gauges plus `harbor_upstream_up`
  (admin token). Migration 6 indexes `audit(created_at)`.
- Why a server is down: each health probe failure is turned into a short reason
  (`describeFailure` in `pool.ts`), shown under an Unreachable server with how long it has been
  down. Checked live: scaling `upstreams-utils-mcp` to 0 showed
  `Unreachable | connection refused (nothing listening)`; it recovered at 1.
- Checked: 7-day metrics (woo 47 calls, 4.3% errors, p50 283 ms, p95 1077 ms), a bad window gives
  400, `/metrics` without auth gives 401. Unit tests 89; smoke 14/14, e2e 5/5.

## Stand-out: scaling (2026-10-22, gateway 0.4.21)

- Production runs 2 gateway pods with a PodDisruptionBudget (`minAvailable: 1`).
- Rate limits: 120 requests a minute per API key on `/mcp`, 20 chat messages a minute per user
  (Helm values `rateLimit.*`), counted in Postgres (`rate_counters`, one atomic upsert per hit).
  Over the limit: 429 with `Retry-After` and an audit row `denied` / `rate_limited`.
- The login lock moved from memory to Postgres (`login_limits`), so it holds across pods.
- Migrations take a Postgres advisory lock; a server add/edit/disable/remove sends
  `NOTIFY servers_changed` and every pod refreshes at once.
- Checked live with 2 pods: 125 `tools/list` calls with one key gave 120 × 200 and 5 × 429
  (`retry-after: 8`) plus a `rate_limited` audit row; 6 bad logins for one name gave 401 × 5 then
  429; disabling `mock` emptied its tools on both pods within a second, and re-enabling restored
  4; deleting one gateway pod during 60 requests failed none of them. Unit tests 87, plus 5
  Postgres integration tests (`TEST_DATABASE_URL`, run against a throwaway Postgres 17: limits,
  two-replica races, the lock, pruning, concurrent migrations). smoke 14/14, e2e 5/5.

## Bonus: multi-store provisioning (2026-10-22, gateway 0.4.22, provisioner 0.1.0)

Live on the VPS, driven through the gateway API as a throwaway member `e2e-stores`:
- `alpha` and `beta` requested at the same moment: both went Provisioning -> Ready in under
  2 minutes, in parallel. A third request from the same user: `429 limit reached: 2 stores per
  user`.
- Each got `urumi-store-<name>` with MariaDB, WordPress (2Gi volumes), woo-mcp, the bootstrap Job,
  Ingress `shop-<name>.169-58-78-14.sslip.io`, a Certificate, 5 NetworkPolicies, a ResourceQuota
  (used: 300m/1 CPU, 512Mi/1.5Gi requested) and a LimitRange. Servers `store-alpha` and
  `store-beta` Connected; 10 new tools.
- The brief's test: a COD order in each store (alpha 2 x 20.00 = 40.00, beta 7.50), then chat as the
  member: "compare today's orders across the alpha and beta stores" called
  `store-alpha__list_orders` and `store-beta__list_orders` and answered 1 order / 40.00 vs
  1 order / 7.50. Deleting `beta`: in about 30s its MCP server and 5 tools, its namespace and both
  PersistentVolumes were gone.
- Isolation: alpha's woo-mcp reaches alpha's WordPress, and is refused by beta's WordPress, beta's
  MariaDB and the original store's MariaDB.
- Least privilege: `kubectl auth can-i --as` the provisioner: no Secrets in `urumi-gateway` or
  `urumi-store`, yes in `urumi-store-alpha`; the ValidatingAdmissionPolicy denied it binding
  itself in `urumi-gateway` and creating `evil-ns`.
- Recovery: the provisioner pod was killed while helm was installing `gamma` (release
  `pending-install`); the new pod claimed it after the lease ran out, cleared the release,
  reinstalled, and gamma reached Ready with one clean release.
- Testing used the Let's Encrypt staging issuer to spare rate limits; afterwards a store `proof`
  with the prod issuer served HTTPS with a verified Let's Encrypt certificate, then was deleted.
  All test stores were deleted; smoke 14/14, e2e 5/5, netpol ENFORCED after the batch.

## Stand-out: handling many tools (2026-10-22, gateway 0.4.23)

Above `chat.toolSearchThreshold` (prod 20) visible tools, the chat model gets `search_tools` and
`call_tool` only. Checked live with the threshold briefly set to 5 (the member sees 10 tools):
"Convert 250 USD to INR" ran `search_tools` (3 found) then `mock__convert_currency`; "What orders
came in today?" ran `search_tools` (5 found) then `woo__list_orders`, both answered correctly and
audited under the user. Threshold restored to 20. Unit tests: ranking, meta-tools only above the
threshold, `call_tool` audited as the real tool, members never find or call denied tools,
arguments still validated. Gateway unit tests 93; smoke 14/14, e2e 5/5.
