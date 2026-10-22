# Harbor: a team MCP gateway on Kubernetes, with WooCommerce hosting

Repo: `KubernetesBasedMCPGateway`. Built for the Urumi AI FDE internship take-home (Round 1).
Live: https://app.169-58-78-14.sslip.io (dashboard) and https://shop.169-58-78-14.sslip.io (store).

One WooCommerce store, a WooCommerce MCP server written for it, and Harbor: a gateway with a React
dashboard. An admin registers MCP servers once; every team member then uses all of them through
one MCP endpoint (`/mcp`) and through a chat agent in the dashboard. The upstream credentials
never leave the gateway. The same three Helm charts run on kind (local) and on k3s (production),
with values changes only.

```
 browser ──► shop.localhost ──► WordPress + WooCommerce ── MariaDB      (urumi-store)
 browser ──► app.localhost  ──► gateway: dashboard, /api, /mcp, chat ── Postgres (urumi-gateway)
 MCP client (Inspector, Claude Code) ──► app.localhost/mcp + "Authorization: Bearer <user key>"

 gateway ──Streamable HTTP, credential attached here only──► woo-mcp        (urumi-store)
                                                          ├─► mock-mcp       (urumi-upstreams)
                                                          ├─► utils-mcp      (urumi-upstreams)
                                                          └─► DeepWiki       (public https, mcp.deepwiki.com)
 woo-mcp ──WooCommerce REST (OAuth 1.0a, Service DNS)──► WordPress
 gateway chat ──► LLM (DeepSeek v4.1 flash on OpenCode Go, automatic fallback to Groq)
```

The design and the reasons for it are in `docs/design-tradeoffs.md`, the threat model in
`docs/threat-model.md`, and the evidence for every claim in `docs/notes/`.

## 1. Repo layout

```
apps/gateway         MCP aggregator and router (/mcp), admin/users/keys/audit API, chat agent, dashboard host
apps/dashboard       React (Vite) dashboard: Servers, Team & Keys, Audit, Chat
apps/woo-mcp         the WooCommerce MCP server (5 tools) over the WooCommerce REST API
apps/mock-mcp        upstream #2: deterministic tools (convert_currency, a colliding list_products, sleep_forever, break_me)
apps/utils-mcp       upstream #3: echo/add (our own small server)
apps/mcp-mini        shared stateless Streamable HTTP server shell used by mock-mcp and utils-mcp
(upstream #4)        DeepWiki: a public hosted MCP server we did not write, registered by URL (no image here)
charts/store         WordPress, MariaDB, woo-mcp, store bootstrap Job, NetworkPolicies
charts/gateway       gateway Deployment, Postgres, Ingress, generated Secrets, NetworkPolicies
charts/upstreams     mock-mcp and utils-mcp
charts/*/values.yaml   local (kind) defaults; values-local.yaml restates them; values-prod.yaml holds every production difference
scripts/             smoke.sh, e2e.sh, seed.sh + seed.mjs, test-netpol.sh
docs/                design-tradeoffs.md, threat-model.md, versions.md, woo-store-access.md, notes/
```

## How it works (short)

- **Tool names (the collision scheme).** Every tool is exposed as `<server slug>__<tool>`. The
  slug is `[a-z0-9-]`, and a tool whose prefixed name would exceed 64 characters is skipped.
  `mock` deliberately also has `list_products`, so clients see `woo__list_products` and
  `mock__list_products`. Nothing is aliased (D5, `docs/design-tradeoffs.md`).
- **How woo-mcp talks to the store.** It uses the WooCommerce REST API (`/wp-json/wc/v3`) over
  in-cluster Service DNS, signed with OAuth 1.0a: over plain in-cluster HTTP, WooCommerce accepts
  nothing else. REST is the public contract, keeps WooCommerce's own logic (totals, stock,
  status changes) and needs no exec into the WordPress pod. Details:
  `docs/woo-store-access.md`.
- **Local domains.** `*.localhost` resolves to loopback in browsers with no setup and is the
  same on every machine (D17). Node tools in WSL need the hosts line in section 2; nip.io or
  sslip.io is the fallback.
- **A tool call:** client → gateway (key hash → user → role check) → the right upstream with
  that server's credential (attached gateway-side) → result back. Every call is written to the
  audit log. More in `docs/design-tradeoffs.md`.

## 2. Prerequisites

- Windows + WSL2 (Ubuntu 24.04) or Linux. Keep the repo on the Linux filesystem, not `/mnt/c`.
- Docker (Docker Desktop with the WSL2 backend), kind v0.33.0, kubectl, Helm v4, Node 24, make.
  The exact versions and how each was checked are in `docs/versions.md`.
- Local domains are `*.localhost`. Browsers resolve them to loopback with no setup. Node-based
  tools in WSL (MCP Inspector, Claude Code) need one hosts line:
  ```bash
  grep -q 'app.localhost' /etc/hosts || echo '127.0.0.1 app.localhost shop.localhost' | sudo tee -a /etc/hosts
  ```
  WSL rewrites `/etc/hosts` at boot. Add `[network]` with `generateHosts = false` to
  `/etc/wsl.conf` to keep the line.

## 3. Local setup (kind)

```bash
make up
```
This one command:
1. creates the kind cluster;
2. installs ingress-nginx;
3. builds the 4 service images and loads them into kind;
4. creates the namespaces and placeholder LLM Secrets;
5. installs the 3 charts and registers the upstream servers (`make seed`): the 3 in-cluster ones,
   plus DeepWiki when the cluster has internet (`DEEPWIKI_URL=` skips it).

All other Secrets are created inside the cluster:
- The database passwords, credential encryption key, session secret, admin token and the
  gateway-to-woo-mcp token are generated by the charts and kept across upgrades (`randAlphaNum`
  + `lookup`, `helm.sh/resource-policy: keep`).
- The WooCommerce REST key is created once by the store bootstrap Job, with a least-privilege
  Role, and is not owned by Helm.

Then:
1. **LLM key** (never in values or git). Paste it at the silent prompt:
   ```bash
   read -rs K && make secrets LLM_API_KEY="$K"; unset K                         # primary: Secret llm-opencode
   read -rs K && make secrets LLM_SECRET=llm-groq LLM_API_KEY="$K"; unset K     # automatic fallback: Secret llm-groq
   kubectl -n urumi-gateway rollout restart deploy/gateway-gateway
   ```
2. **Check it:**
   ```bash
   make smoke   # 13 live checks: dashboard, 401s, headers, upstreams Connected, no secrets returned, storefront
   make e2e     # product via /mcp, storefront COD order via the Store API, order read back, key revoked
   ```
3. **Create the dashboard users** (an admin A and a member B) with the admin token:
   ```bash
   T=$(kubectl -n urumi-gateway get secret gateway-admin -o jsonpath='{.data.token}' | base64 -d)
   J='Content-Type: application/json'; H="Authorization: Bearer $T"
   A_ID=$(curl -s -X POST http://app.localhost/api/users -H "$H" -H "$J" -d '{"name":"A","role":"admin"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
   B_ID=$(curl -s -X POST http://app.localhost/api/users -H "$H" -H "$J" -d '{"name":"B","role":"member"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
   read -rs P && curl -s -X POST http://app.localhost/api/users/$A_ID/password -H "$H" -H "$J" -d "{\"password\":\"$P\"}"; unset P
   read -rs P && curl -s -X POST http://app.localhost/api/users/$B_ID/password -H "$H" -H "$J" -d "{\"password\":\"$P\"}"; unset P
   unset T
   ```
   Passwords need at least 8 characters. An admin can also set one-time passwords later on the
   **Team & Keys** tab. There is no email infrastructure, by design.

Other targets:
- `make down`: uninstalls the charts but keeps the data.
- `make reset`: deletes the cluster.
- `make test-netpol`: proves the cluster's CNI enforces NetworkPolicies (a scratch namespace, baseline plus an allowed/denied pair).
- `make help`: lists them all.

Exposed URLs (ingress-nginx, `ingressClassName` from values):

| URL | What |
|---|---|
| http://shop.localhost | storefront; `/wp-admin` for WooCommerce admin |
| http://app.localhost | dashboard; `/api` for the dashboard API, `/mcp` for MCP clients |

The WooCommerce MCP server, the other upstreams and both databases have **no Ingress**. They
are ClusterIP Services behind default-deny ingress NetworkPolicies. Only the gateway can reach
the MCP servers, and only WordPress and woo-mcp can reach the store (see `docs/threat-model.md`).

## 4. Place an order and see it in WooCommerce admin

1. Open http://shop.localhost/shop, add a product to the cart, and check out with **Cash on
   delivery** and any US test address. You get "Order received". The bootstrap Job configures
   the store: country, currency, COD, a flat-rate shipping zone, and "Coming soon" switched off.
2. WooCommerce admin: http://shop.localhost/wp-admin, user `admin`, password from
   ```bash
   kubectl -n urumi-store get secret store-wp-admin -o jsonpath='{.data.password}' | base64 -d; echo
   ```
   Go to **WooCommerce → Orders**: the order is there with status Processing.

## 5. Use the dashboard and the chat agent

Log in at http://app.localhost.
- **Admins** land on **Servers**: status (Connected / Unreachable / Disabled), tools, and Add,
  Edit, Disable and Remove. `woo` is registered first by `make seed`.
- **Members** land on **Chat** and have no Servers tab.
- **Team & Keys:** users, one-time passwords, "Generate my key", and issuing or revoking keys
  (admins).
- **Audit:** every tool call, with who, server, tool, time, duration, outcome and error class.
  Members see only their own rows.

**Chat agent** (the Chat tab):
- It calls the same aggregator as `/mcp`, as the logged-in user. The model only ever sees tools
  that user may call, and every call is audited under that user.
- Tool chips show which server and tool each step used.
- Prompts to try:
  - `Create a product called Desk Lamp priced 33.25`
  - `What orders came in today?` (the day comes from the store timezone)
  - `Get today's order total and convert it from USD to EUR` (two servers)

**LLM providers.** Any OpenAI-compatible chat endpoint works. Switching the primary is three values:
- **Primary:** DeepSeek v4.1 flash on OpenCode Go (`llm.baseUrl`, `llm.model`,
  `llm.secretName: llm-opencode`). The gateway identifies itself with its own `User-Agent` and a
  per-conversation `x-opencode-session` header, as OpenCode asks clients to. OpenCode Go is aimed
  at coding agents; see D10.
- **Automatic fallback:** Groq `qwen/qwen3.8-27b` (`llm.fallback.*`, Secret `llm-groq`).
  - When the primary fails (unreachable, a 20s timeout, an error, or rate-limited after one
    retry), the same request is answered by the fallback, and the primary rests for 60s.
  - Each failover logs one line in `kubectl -n urumi-gateway logs deploy/gateway-gateway`.
  - Set `llm.fallback.baseUrl=""` to turn it off.
- **Also tested:** Gemini (`https://generativelanguage.googleapis.com/v1beta/openai`,
  `gemini-3.8-flash`, Secret `llm`). Ollama works too, with `http://<host>:11434/v1`.

## 6. Connect an external MCP client

Every client needs only the gateway URL `http://app.localhost/mcp` (Streamable HTTP) and a user's
API key. Generate a key on **Team & Keys → Generate my key**; it is shown once. A member sees 10
tools (14 for an admin): the write tools `woo__create_product` and `woo__update_order_status`, and the failure-demo
tools `mock__sleep_forever` and `mock__break_me`, are admin-only, hidden from `tools/list` and
rejected if called.

**MCP Inspector 2.11.0** (UI):
```bash
MCP_INSPECTOR_SECRET_STORE=memory npx -y @modelcontextprotocol/inspector@2.11.0
```
Connect with transport Streamable HTTP, URL `http://app.localhost/mcp`, and header
`Authorization: Bearer <key>`. `MCP_INSPECTOR_SECRET_STORE=memory` stops Inspector from saving
the key to a plain file when no OS keychain exists. Headless:
```bash
npx -y @modelcontextprotocol/inspector@2.11.0 --cli http://app.localhost/mcp --transport http \
  --header "Authorization: Bearer <key>" --method tools/list
```

**Claude Code** (tested with 2.1.304):
```bash
claude mcp add --transport http harbor http://app.localhost/mcp --header "Authorization: Bearer <key>"
claude mcp list        # harbor: http://app.localhost/mcp (HTTP) - Connected
```
Then ask, for example, "Using the harbor tools, what orders came in today?".

**Cursor** and other clients: add an HTTP MCP server with the same URL and the same static
`Authorization` header. Not tested here.

A missing or bad key gets `401` with `WWW-Authenticate: Bearer realm="harbor"`. A revoked key gets
`401` and an audit row `revoked_key`.

## 7. Production-like deployment (k3s)

The charts are the same; only `values-prod.yaml` and a few `--set` values change.

| Concern | Local (kind) | Production (k3s) |
|---|---|---|
| Ingress | ingress-nginx, `ingress.className: nginx`, buffering-off annotations | k3s Traefik: `ingress.className: traefik`, `controllerNamespace: kube-system`, `controllerPodLabels: {app.kubernetes.io/name: traefik}`; nginx annotations nulled |
| Hosts | `app.localhost`, `shop.localhost` | real names via `--set appHost=... --set storeHost=...` (required) |
| Store URL | `http://<storeHost>` | `storeUrl: https://shop.<domain>` (WP_HOME / WP_SITEURL, D21) |
| TLS | none | `ingress.tlsSecretName`, plus `ingress.certIssuer: letsencrypt-prod` so the chart creates the cert-manager Certificate (or leave it empty and bring a `kubernetes.io/tls` Secret); `ingress.acmeHttp01: true` lets cert-manager's HTTP-01 solver past default-deny |
| Storage | kind `standard` | `storage.className: local-path` (k3s default) |
| Images | local tags, `kind load` | `ghcr.io/kss004/kubernetesbasedmcpgateway/<name>:<tag>`; `imagePullSecrets: [{name: ghcr-pull}]` if private |
| Cookie | no `Secure` (http) | `session.cookieSecure: true` (https only) |
| Secrets | generated in-chart; LLM keys via `make secrets` | the same |

**Rehearsed on k3s (k3d v5.9.0, k3s v1.35.5)**, evidence in `docs/notes/P4-k3d.md`:
```bash
make prod-up      # k3d cluster on ports 8081/8444, values-prod.yaml, images retagged to the GHCR names
make prod-check   # smoke + e2e against http://app.localhost:8081
```
- **2026-10-18 (gateway 0.4.2):** after the startupProbe fix, a fresh run from zero passed first
  time with zero restarts.
- **2026-10-20 (current build: gateway 0.4.14, woo-mcp 0.1.5):** `make prod-up` upgraded the
  existing `urumi-prod` cluster, then `make prod-check` passed smoke 13/13 and e2e 5/5, with zero
  restarts.

The k3s run found and fixed 6 production bugs, 4 of which kind had hidden:
- NetworkPolicies admitted only ingress-nginx (Traefik is in `kube-system`);
- the bootstrap Job raced kube-router's NetworkPolicy allow-list;
- WordPress probes followed canonical and https redirects to a dead port;
- the gateway was killed by liveness while Postgres was still pulling;
- `make seed` registered only one server;
- `helm install --wait` deadlocked the store chart (its bootstrap creates woo-mcp's Secret).

**VPS: run 2026-10-21** on a Contabo VPS (k3s v1.36.5, Traefik 3.7.13, cert-manager v1.21.2,
Let's Encrypt over HTTP-01, `sslip.io` hosts). Full commands and evidence: `docs/notes/P5-vps.md`.
- Same charts and `values-prod.yaml`, plus `--set appHost/storeHost/storeUrl=https://...` and
  `--set ingress.tlsSecretName=app-tls|shop-tls`; the charts create the cert-manager Certificates
  (`ingress.certIssuer: letsencrypt-prod` in `values-prod.yaml`).
- Images built on the box and imported with `k3s ctr images import` (no registry).
- smoke 14/14 and e2e 5/5 over https, `test-netpol.sh` ENFORCED, all pods restarts 0.
- The run found 4 problems, all fixed:
  - woo-mcp's OAuth signature failed over https (woo-mcp 0.1.6 sends `X-Forwarded-Proto: https`);
  - default-deny would block cert-manager's HTTP-01 solver at renewal
    (`ingress.acmeHttp01: true` adds an allow policy);
  - klipper-lb masqueraded every client to `10.42.0.1`, so Traefik now uses `hostPort` 80/443
    with a ClusterIP Service (a k3s `HelmChartConfig`).
  - plain http was served; `ingress.httpsRedirect: true` adds a Traefik redirect to https.

## 8. Upgrade and rollback (Helm 4)

Rehearsed on k3d. Commands and output are in `docs/notes/P4-k3d.md`.
```bash
# upgrade one component; a failed rollout rolls itself back
# prod: always pass the same values file and hosts, or the release falls back to chart defaults
helm upgrade gateway ./charts/gateway -n urumi-gateway -f charts/gateway/values-prod.yaml \
  --set appHost=<host> --set gatewayTag=<new> --rollback-on-failure --timeout 3m
# kind: helm upgrade gateway ./charts/gateway -n urumi-gateway --set gatewayTag=<new> --rollback-on-failure --timeout 3m
helm history gateway -n urumi-gateway
helm rollback gateway <revision> -n urumi-gateway --wait --timeout 3m
```
- The same applies to the store (`charts/store`: WordPress, WooCommerce version, woo-mcp tag)
  and the upstreams. Install the store chart without `--wait`, since its post-install bootstrap
  creates the Secret woo-mcp needs.
- During the rehearsal, a bad image tag rolled back automatically while the old pod kept
  serving. Users and servers in Postgres survived every step.
- Helm 4 flag names: `--rollback-on-failure` (was `--atomic`), `--force-replace` (was `--force`).
- Helm reuses the last release's values only when an upgrade passes no `--set` or `-f`. Any
  `--set` or `-f` starts again from the chart defaults. So always pass the same
  `-f values-prod.yaml` and host values, or use `--reset-then-reuse-values`. Check what a
  release holds with `helm get values <release>`.
- PVCs and generated Secrets carry `helm.sh/resource-policy: keep`, so an uninstall and reinstall
  keeps the data and passwords. Only `make reset` wipes them.

## 9. Tests

- **Unit:** `cd apps/gateway && npm test` (57 tests). `cd apps/woo-mcp && npm test` (3 tests:
  OAuth signing, order allowlist, order totals).
- **Live:** `make smoke`, `make e2e`, `make test-netpol`, `make prod-check`.
- **End-to-end:** 8 rounds by separate tester sessions (browser plus terminal), with every
  finding fixed and retested. Reports are in `docs/notes/E2E-2026-10-19*.md`, and the recording
  script in `docs/notes/DEMO-RUNBOOK.md`.

## 10. Stand-out items attempted

| Item | Where |
|---|---|
| Production-like deployment (live on a k3s VPS with Let's Encrypt TLS via cert-manager; rehearsed on k3d first) | section 7, `docs/notes/P5-vps.md`, `docs/notes/P4-k3d.md`, `charts/*/values-prod.yaml` |
| Tool permissions (members cannot see or call write tools or the failure-demo tools) | `apps/gateway/src/router.ts` (`grantsAllow`), applied in `/mcp` and in chat |
| Security hardening: SSRF guard on server URLs, credentials encrypted at rest (AES-256-GCM), default-deny ingress NetworkPolicies with an enforcement test, non-root containers where the image allows, no service-account tokens, least-privilege RBAC for the bootstrap Job, CSP and security headers, login rate limit, logout invalidation | `apps/gateway/src/egress.ts` (SSRF guard: in-cluster Services or public https hosts, IPs checked at save and on every connection), `crypto.ts`, `session.ts`, `ratelimit.ts`, the `NetworkPolicy` objects in `charts/*/templates/`, `charts/store/templates/bootstrap.yaml` (Role), `scripts/test-netpol.sh` |
| Upgrades and rollback | section 8, `docs/notes/P4-k3d.md` |
| Observability: per-server calls, error rate, p50/p95 latency and error classes (Servers page, `/api/metrics`, Prometheus `/metrics`); why an upstream is Unreachable and since when | `apps/gateway/src/metrics.ts`, `pool.ts` (`describeFailure`), `apps/dashboard/src/Servers.jsx` |
| Scaling: 2 gateway replicas in production with a PodDisruptionBudget; rate limits per key on `/mcp` and per user on chat; login lock, limits and migrations coordinated through Postgres; server changes pushed to every pod (LISTEN/NOTIFY) | `apps/gateway/src/ratelimit.ts`, `db.ts`, `index.ts`, `charts/gateway/templates/pdb.yaml`, `docs/design-tradeoffs.md` "Replicas" |
| LLM resilience: automatic provider fallback | `apps/gateway/src/chat.ts` (`makeLlmCaller`) |
| Chat correctness guard: no store data shown without a tool call in that request | `apps/gateway/src/chat.ts` (`driveLoop`), D28 |

Not attempted: multi-store provisioning, OAuth on the gateway, many-tools search and hosted MCP
servers.
