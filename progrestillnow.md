# progrestillnow.md — Urumi MCP Gateway on Kubernetes

Second revision, 2026-10-09. Single handoff document: read top to bottom and you know what exists, what was decided and why, what is next.

**Rule for whoever picks this up:** update the Status Board and "In flight" at the end of every session. This file is the source of truth, not the git log.

Items marked **REVISED** changed after the first draft. Items marked **NEW** were added in the second revision. Section 15 lists every change and the one-line reason.

---

## 0. Decisions confirmed

| Topic | Answer |
|---|---|
| Services stack | TypeScript, Node 24, everywhere |
| Local cluster | kind on the PC under WSL2, Docker Desktop (WSL2 backend) |
| Chat agent LLM | OpenAI-compatible chat endpoint, Gemini free tier primary, Ollama fallback, pinned model, key in a Secret created out-of-band (D10) |
| Stretch scope | Tool permissions (T11.1) then security hardening (T11.2). Multi-store only if C3 is reached by end of Oct 16 (a day early) |
| Deadline | Target submit 2026-10-22 night, hard deadline 2026-10-23 |
| Production target | Mac mini + k3s in a Linux VM, go/no-go on Oct 20. Cloud VPS documented only unless rented (Q11) |
| Git | Private GitHub repo created on day 1 (needed for GHCR and backup) |
| Bring-up | One command: `make up` (D19) |
| Demo users | A = admin, B = member (D23) |
| Repo | `github.com/Kss004/KubernetesBasedMCPGateway`, private, remote configured |
| Availability | All 14 days Oct 9-22 are full working days |
| Working mode | AI-native coding, user learns alongside: context and reasoning are part of every task's output, not an afterthought |
| Working location | All development happens on the Windows PC under WSL2. The MacBook Air session that wrote this file is finished |

---

## 1. Current state

Repo contains the assignment `.docx` (untracked, see `docs/` after T0.1), `Agents.md`, `README.md` and this file. Git repo + remote exist. No cluster, no source code. Nothing is built. `windows-coding-setup.md` now exists (written by T0.1, see `docs/notes/T0.1.md`).

There is no `t1-1/` folder in the repo. An earlier reference to it was stale.

---

## 2. Status board

| Phase | State |
|---|---|
| P0 Environment + scaffold + Makefile skeleton | Done (T0.1→T0.5, notes docs/notes/T0.1.md) |
| P1 Store on K8s | Done (C1 met: checkout order 12, persistence, reset; T1.6) |
| P2 Woo MCP server | Done (5 tools live, OAuth client, netpol pair; docs/woo-store-access.md) |
| P3 Gateway core (+ mock-mcp first) | Partial: T3.0–T3.3 + T3.6 done. NEXT: T3.4/T3.5 (agent writes, human reviews; HANDOFF.md) |
| P4 Users, keys, roles, audit | Not started |
| P5 Dashboard | Not started |
| P6 Chat agent | Not started |
| P7 Third upstream + failure demos | Not started |
| P8 DoD run-through (twice) | Not started |
| P9 Docs, prod values, demo video | Not started |
| Stretch: T11.1 + T11.2 (D12) | Not started |

---

## 3. Environment and device roles

| Device | Role | Why |
|---|---|---|
| Windows PC (Ryzen 7 9800X3D, 32GB, 5070 Ti) | **Primary: all development, the kind cluster, all testing** | Most RAM, amd64 like nearly every VPS, no remote-cluster plumbing. Optional: Ollama on the GPU as LLM fallback |
| Mac mini M4 (confirm 16 or 24GB) | **Production-like target**: k3s in a Linux VM, `values-prod.yaml` executed here in Phase 9 | Separate always-on node proves "same charts, config changes only" |
| MacBook Air M2 8GB | Editor, second MCP client (user B), screen recording | Crashes past ~5GB Docker, so it never runs the cluster |

The earlier draft had the Mac mini running everything. Rejected: a remote kind cluster needs `apiServerAddress` + `certSANs` and a tunnel before `kubectl` works at all, and every debug loop pays a network hop.

### PC setup (WSL2)

- Full steps and troubleshooting: `windows-coding-setup.md`.
- WSL2 + Ubuntu 24.04. Repo in the repo root on the WSL filesystem, **not** `/mnt/c`.
- `%UserProfile%\.wslconfig`: `memory=20GB`, `processors=8`, `swap=8GB`.
- Docker Desktop with the WSL2 backend. Do not also install native Docker Engine in WSL2.
- Inside WSL: kind, kubectl, helm, node 24, git, make.
- `.gitattributes`: `* text=auto eol=lf` and `git config core.autocrlf input`.
- Ollama stays on the Windows side; pods reach it by host address.

### Mac mini setup (Phase 9 only)

- Linux VM (OrbStack machine, Lima or Multipass), arm64. Install k3s. Decide once whether to keep Traefik or standardise on ingress-nginx, and document it.
- Images must be multi-arch (D16).
- Do not run kind and k3s on the mini at the same time.

---

## 4. Architecture

```
                         INGRESS (ingress-nginx, kind)
 shop.localhost  ───────────►  WordPress + WooCommerce   (public, browser needed for DoD)
 app.localhost   ───────────►  dashboard (static) + /api + /mcp  → gateway

 MCP clients (Claude Code / Cursor / Inspector) ──► only gateway URL + user API key

                               ┌────────────────────────┐
                               │ gateway (Node/TS)      │
                               │ /mcp  aggregated MCP   │
                               │ /api  REST for UI      │
                               │ /api/chat SSE → LLM    │
                               │ postgres: users, keys, │
                               │ servers, creds, audit  │
                               └──┬─────────┬─────────┬─┘
                  Streamable HTTP, credential attached at the gateway only
                       ┌─────────┘         │         └─────────┐
                 ┌─────▼─────┐      ┌──────▼─────┐      ┌──────▼─────┐
                 │ woo-mcp   │      │ mock-mcp   │      │ everything │
                 └─────┬─────┘      └────────────┘      └────────────┘
                       │ REST (Service DNS + Host header, same namespace)
                 ┌─────▼─────┐
                 │ WooCommerce│ on MariaDB
                 └───────────┘
```

| Namespace | Contents | Public? |
|---|---|---|
| urumi-store | wordpress, mariadb, **woo-mcp** (REVISED) | wordpress via ingress only; woo-mcp ClusterIP, reachable only from the gateway |
| urumi-gateway | gateway, dashboard, postgres | ingress only |
| urumi-upstreams | mock-mcp, everything-mcp | none (ClusterIP, no Ingress) |

### Tool call path

1. Client POSTs JSON-RPC to `/mcp` with `Authorization: Bearer <user key>`.
2. Gateway SHA-256s the key, looks up user, role, grants.
3. Gateway resolves `<slug>__<tool>` to a server row, checks enabled and healthy.
4. Gateway attaches that server's decrypted credential header to the outbound request.
5. Gateway calls the upstream `/mcp` over Streamable HTTP with a per-call timeout. If the upstream says its session is gone (404), the pool re-initialises once and retries.
6. Audit row written (success, error, timeout, denied). Only the tool result (size-capped) returns to the client.

Client tokens are never forwarded upstream. Upstream credentials never reach any client or the browser.

### Secrets map (NEW)

Kubernetes Secrets cannot be mounted across namespaces, so each secret lives where its consumer lives.

| Secret | Namespace | Created by | Consumed by |
|---|---|---|---|
| MariaDB root and WordPress DB password | urumi-store | Helm (`randAlphaNum` + `lookup`), kept on uninstall | mariadb, wordpress, bootstrap Job |
| WordPress admin password | urumi-store | Helm, kept | wordpress bootstrap; human reads it with kubectl |
| WooCommerce REST key and secret | urumi-store | Bootstrap Job | **woo-mcp only** (same namespace) |
| woo-mcp inbound bearer token | urumi-store | Helm, kept | woo-mcp (to verify the gateway). The same value is stored encrypted in the gateway DB as that server's credential, put there by `make seed` |
| Postgres password | urumi-gateway | Helm, kept | postgres, gateway |
| Credential encryption key (AES-256-GCM) | urumi-gateway | Helm, kept | gateway. Losing it makes stored upstream credentials unreadable; document this |
| Session signing secret | urumi-gateway | Helm, kept | gateway |
| Bootstrap admin password | urumi-gateway | Helm, kept | gateway seed, human reads it with kubectl |
| LLM API key | urumi-gateway | `kubectl create secret` out-of-band (`make secrets`) | gateway |
| GHCR pull secret (prod only) | each namespace | `kubectl create secret docker-registry` | pods via imagePullSecret |

The gateway never gets RBAC to read Secrets in other namespaces. `make seed` reads the woo-mcp token with kubectl from your machine and registers the server through the gateway's admin API.

---

## 5. Decisions log

- **D1 TypeScript / Node 24 everywhere.** One runtime, one base image, shared types with React. The MCP TS SDK is the reference implementation. Pin the stable 1.x line and record why in T0.4.
- **D2 kind locally, with a NetworkPolicy enforcement test before anything depends on it (T1.1).** The test is a baseline plus a **pair**, in a scratch namespace. Baseline: with no policy, both an "allowed" and a "denied" pod reach the target. Then apply the policies: the allowed pod must still connect, and the denied pod must not. kindnet's policy engine runs with `FailOpen: true`, so a dead engine *allows* traffic, which means the denied half catches a dead engine. The allowed half and the baseline rule out typos, wrong Service names and not-ready pods. Either half alone proves nothing.
- **D3 Own store Helm chart, official `wordpress` + `mariadb` images.** Not Bitnami: public charts/images are version-gated since Aug 2025.
- **D4 Postgres for gateway metadata.** Honest tradeoff: SQLite on a PVC is half a day cheaper but forecloses multi-replica. Keep Postgres only if you will defend it in the interview. Cut it if you are behind on Oct 14.
- **D5 Tool names: `<slug>__<tool>`.** Double underscore, slug restricted to `[a-z0-9-]`, whole name under 64 chars (enforced when tools are listed). Only the prefixed name exists; nothing is aliased.
  Why not dots: Anthropic and OpenAI function-name patterns allow only letters, digits, `_` and `-`, and Claude Code and Cursor add their own prefixes on top. Gemini is not the constraint (its `FunctionDeclaration.name` permits dots, up to 128 chars), so the reason is purely client compatibility.
  Do not cite the SDK's `mcp__<server>__<tool>` helper as a standard: it exists only on `main` (v2.0.0-alpha.0) as example code, not on the pinned `v1.x`.
- **D6 Stateless gateway.** No MCP sessions, any replica serves any request. Create a fresh server + transport **per request**. Tradeoff to state out loud: no server-initiated notifications such as `tools/list_changed`.
- **D7 Chat agent runs in-process and calls the same aggregator**, passing the logged-in user's identity. One routing function, one audit path. Prepared one-line answer: same function external clients hit, minus a pointless HTTP hop to ourselves.
- **D8 mock-mcp + SDK `everything` server as upstreams #2 and #3.** Deterministic and offline. mock-mcp exposes a plausible tool (`convert_currency`), a deliberately colliding tool name, a `sleep_forever` tool, and a kill switch. Build `everything` into a pinned image; do not `npx` at pod start.
- **D9 Production story.** Written and charted, then executed on the Mac mini if the Oct 20 go/no-go says yes (D15). Cloud VPS stays documented-only unless rented (Q11).
- **D10 LLM access via an OpenAI-compatible chat-completions endpoint (REVISED).** Gemini exposes one and Ollama exposes one, so there is a single tool-calling format and a single loop, called with plain `fetch` (no SDK). Switch provider with `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`. Gemini free tier is primary; Ollama on the PC GPU is the fallback. Pin the model. Key created out-of-band with `kubectl create secret`, never in a values file. Verify in T6.1 that both endpoints return tool calls in the expected shape.
  Verified: Gemini's OpenAI-compatible endpoint is real — `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, `Authorization: Bearer $GEMINI_API_KEY`, with `tools` (type `function`) and `tool_choice` accepted, returning standard `choices[0].message.tool_calls`.
- **D11 All secrets generated, local and prod.** `randAlphaNum` + `lookup` so upgrades do not rotate them. Fixed credentials in a committed values file would fail a "no hardcoded secrets" review. Note: `lookup` returns nothing under `helm template` / `--dry-run`, so test generation with a real install.
- **D12 Stretch scope.** The schedule has no slack for multi-store provisioning (4-5 days: provisioner, RBAC, driving Helm or the K8s API from Node, per-store NetworkPolicies, quotas, teardown). Stretch is **T11.1 tool permissions, then T11.2 security hardening**, roughly a day each, feeding the threat model and the video. Multi-store (Phase 10) only if C3 is reached by end of Oct 16, a day ahead of the schedule. Otherwise it is dropped.
- **D13 Timeline.** See section 6. Cut order if behind: stretch, then dashboard polish, then audit filtering/pagination (fall back to "latest 200"), then mock-mcp extras. Never cut docs, threat model, video, or security controls.
- **D14 Cluster and all development on the PC under WSL2.**
- **D15 Mac mini = production-like target.** k3s needs a Linux VM on macOS. State plainly what it does not cover: arm64 not amd64, no public DNS, no cert-manager issuance against a real domain, different scheduler behaviour. Go/no-go on Oct 20; if no-go, document the path and say so.
- **D16 Images: local build + `kind load`, plus GHCR for prod.** kind nodes cannot see host images, and the mini is arm64 while most VPSes are amd64. Locally: unique tags, `imagePullPolicy: IfNotPresent`. For prod: `docker buildx build --platform linux/amd64,linux/arm64` pushed to GHCR, pulled via `imagePullSecret`.
- **D17 Local domains: `*.localhost`.** Resolves to loopback in browsers with no hosts-file edits, identical on all machines and for a reviewer, avoids `.local` mDNS delays. Fallback: nip.io.
- **D18 woo-mcp lives in `urumi-store` (NEW).** It must mount the WooCommerce REST key Secret, and Secrets do not cross namespaces. Putting woo-mcp beside the store ties its lifecycle to the key, and gives a clean NetworkPolicy story: only the gateway reaches woo-mcp; only the ingress and woo-mcp reach WordPress. The gateway-to-woo-mcp bearer token is a different secret from the REST key and is never the same value.
- **D19 One-command bring-up (NEW).** A Makefile with `up`, `down`, `reset`, `secrets`, `seed`, `test-netpol`. `up` = create kind cluster, install ingress-nginx, build and `kind load` images, create out-of-band secrets, helm install, seed. `down` = helm uninstall (data kept). `reset` = delete the cluster or namespaces and PVCs for a clean run. The DoD runs twice on a clean cluster, you do a live walkthrough, and a reviewer must reproduce it, so this is on the critical path, not a nicety.
- **D20 Persistence policy (NEW).** PVCs and generated Secrets carry `helm.sh/resource-policy: keep`. Otherwise `helm uninstall` deletes the PVC and the reinstall generates a new DB password that MariaDB rejects against the old data directory. The persistence test (T1.5) uses pod deletion, `helm upgrade`, and uninstall/install with kept resources. `make reset` is the only thing that wipes data.
- **D21 Site URL via config, not the database (NEW).** Set `WP_HOME` and `WP_SITEURL` from Helm values through `WORDPRESS_CONFIG_EXTRA`. A URL stored with `wp option update` survives a domain change and causes redirect loops in prod.
- **D22 Audit and privacy decisions (NEW).** Log every `tools/call` and every denied attempt (including a revoked key, attributed to the known user). Do **not** store tool arguments or results (they can contain customer data or secrets); store user, server, tool, timestamp, duration, outcome, error class. Members see only their own rows; admins see all. Chat history is not stored server-side; the client sends history with each request, so it is per-user by construction. Tradeoff to state: less forensic detail.
- **D23 Demo users and roles (NEW).** User A = admin (creates a product through chat). User B = member (reads orders, two-server prompt). In the core, members default-allow every tool. T11.1 restricts members from write tools (`create_product`, `update_order_status`). The DoD still passes after T11.1 because B's flows are all reads and A is admin, and the demo shows a real role difference.
- **D24 Failure demos use `scale --replicas=0` (NEW).** Deleting the pod makes the Deployment recreate it in seconds, so the dashboard may never show Unreachable. Scale to 0, show Unreachable and that others keep working, scale back to 1. Health probe: every 5s, 2s timeout, Unreachable after 2 consecutive failures.
- **D25 Egress is not default-denied (NEW).** The chat agent needs egress to the LLM, DNS, Postgres and the upstreams. Default-deny **ingress** in every namespace; add an egress allow-list only if time remains (T11.2). State this gap in the threat model.
- **D26 External-client compatibility (NEW).** Test MCP Inspector and Claude Code at C2, not in P8. Return a clean 401 for a missing or invalid key and a JSON 404 on the `/.well-known` OAuth discovery paths, because real clients probe them. Configure the key through the client's static header setting. Verify behaviour against the clients you actually run.
  Verified and important for T3.5: the SDK's `StreamableHTTPClientTransport` takes an optional `authProvider`, and when auth is required but no `authProvider` is supplied it throws `UnauthorizedError`. So the upstream credential is attached via `authProvider` (or `requestInit` headers), **not** by inventing a bearer token the client SDK understands natively. Attach a plain `requestInit.headers.Authorization` unless T3.7 proves `authProvider` is needed for a specific upstream.
  Inspector-specific: its own API token (`MCP_INSPECTOR_API_TOKEN`) guards the Inspector's own routes and is unrelated to ours. Our gateway key goes in the server connection's headers field.

---

## 6. Schedule and checkpoints

| Dates | Work |
|---|---|
| Oct 9-10 | P0 (incl. Makefile skeleton), T1.1 (cluster + NetworkPolicy test), T1.2 (ingress) |
| Oct 11-12 | P1 rest: store chart, bootstrap, persistence, manual checkout. **C1** |
| Oct 13 | P2 woo-mcp |
| Oct 14-15 | mock-mcp, P3 gateway core, real-client check. **C2**. Draft the design-and-tradeoffs note |
| Oct 16 | P4 users, keys, roles, audit. Draft the threat-model note |
| Oct 17 | P6 chat loop working from curl. **C3** |
| Oct 18-19 | P5 dashboard (minimal) + wire the chat UI |
| Oct 20 | P7 failure demos, P8 DoD run 1, record a rough video. **C4**. Mac mini go/no-go |
| Oct 21 | P8 run 2, fixes, stretch item if C4 was clean |
| Oct 22 | Docs polish, k3s run if go, final video, submit. **C5** |
| Oct 23 | Buffer only |

Checkpoints:

- **C1** manual checkout works, product survives pod deletion and `helm upgrade`, and `make reset` gives a clean slate.
- **C2** with curl **and with MCP Inspector using only the gateway URL + a key**, `tools/list` aggregates three servers, a call routes to the right one, a dead upstream returns a clear error and does not stall listing.
- **C3** API keys and audit work; the chat loop answers "what orders came in today" from curl.
- **C4** full DoD script passes once.
- **C5** README, design note, threat model, final video done.

If C2 slips past Oct 16, drop the dashboard to a bare table. P4 has no slack: if it overruns, cut audit filtering/pagination first (D13), never CSRF, hashing or role checks.

---

## 7. Task breakdown

**Per-workload checklist,** applied the moment each Deployment/StatefulSet is written, not at the end: requests + limits, readiness + liveness probes, `securityContext` (`runAsNonRoot`, drop capabilities) where the image allows, **`automountServiceAccountToken: false`** (a pod that never calls the Kubernetes API should not hold a token), Secret references only, labelled namespace, ingress default-deny NetworkPolicy in the namespace.

### P0 Environment and scaffold

- **T0.1** PC: WSL2 + Docker + tools per `windows-coding-setup.md`. **That file does not exist yet** — write it as part of this task, capturing the commands you actually run. Verify: `docker info` shows the memory you set, `kind version` / `helm version` / `node -v` / `make -v` print.
- **T0.2** `git init`, `.gitignore`, `.gitattributes` (LF), create the private GitHub repo, first push. Verify: the remote shows the commit.
- **T0.3** npm workspaces root, `tsconfig.base.json`, tsx/typescript. Verify: `npm install` clean.
- **T0.4** `docs/versions.md`: SDK stable line and why, zod, pg, chart versions, base image tags, **kind node image tag**, and (only if needed) the Calico release — all copied from `npm view` / `helm show chart` / release notes, not from memory. Record which MCP spec revision the SDK speaks: the SDK carries **2026-07-28**, selected only through `server/discover`, never through the legacy `initialize` handshake, which negotiates older versions only. Confirm Claude Code and MCP Inspector connect cleanly.
- **T0.5 (NEW)** Makefile skeleton with `up`, `down`, `reset`, `secrets`, `seed`, `test-netpol` targets (stubs). Each later task fills in its target as it lands. Verify: `make help` lists them.

### P1 Store on Kubernetes

- **T1.1** `kind.yaml` with extraPortMappings 80/443 and the ingress-ready label. Then the NetworkPolicy test: a scratch namespace with a target pod and Service plus two client pods labelled `role=allowed` and `role=denied`. **Baseline:** with no policy, both clients reach the target (if not, the test is invalid: fix Service name, readiness or DNS first). Apply deny-all ingress plus an allow rule from `role=allowed`. **(a)** the allowed pod still connects; **(b)** the denied pod is blocked. Distinguish "the request failed" from "kubectl exec failed". Outcomes: both hold = enforced; (b) fails (denied pod still connects) = not enforced, recreate with `disableDefaultCNI` plus Calico and re-run; (a) fails = allow policy over-broad or mislabelled; baseline fails = invalid test. Wire it into `make test-netpol`. The test, not the kindnet version note, is the authority.
- **T1.2** ingress-nginx, matched to the kind node (ingress-ready label, control-plane toleration, hostPort 80/443). Verify: `curl http://shop.localhost/` hits the ingress (use `--resolve` if WSL cannot resolve it). Annotate the `/mcp` and `/api/chat` routes with `nginx.ingress.kubernetes.io/proxy-buffering: "off"` and a long `proxy-read-timeout`.
- **T1.3** `charts/store`: MariaDB StatefulSet + PVC, WordPress Deployment + PVC, Services, Ingress, generated Secrets. PVCs and Secrets carry `helm.sh/resource-policy: keep` (D20). `WP_HOME` / `WP_SITEURL` set via `WORDPRESS_CONFIG_EXTRA` from values (D21). Chart is written so a provisioner could reuse it per namespace later.
- **T1.4** Bootstrap Job using the **`wordpress:cli`** image against the same PVC, **idempotent** (safe to re-run after a retry or reinstall): install WordPress, activate WooCommerce, pretty permalinks, enable COD, create the REST keys with `wp eval` and write them to a Secret. **Also configure what checkout needs:** store country and currency, a shipping zone covering the test address with at least one shipping method (flat rate or free shipping). Without a shipping method, checkout fails with "no shipping options" and DoD step 1 fails. Verified: the official `wordpress` image ships no WP-CLI, and WooCommerce has no built-in CLI command for REST keys. Half-day cap; fallback is a documented manual setup with keys moved into a Secret.
- **T1.5** Persistence check: create a product, then (1) delete the WordPress and MariaDB pods, (2) run `helm upgrade`, (3) `helm uninstall` then `helm install` with kept PVCs and Secrets. The product must survive all three. Separately confirm `make reset` really wipes everything.
- **T1.6** Manual checkout; order visible in wp-admin.

### P2 Woo MCP server

- **T2.1** `apps/woo-mcp`: HTTP + `McpServer` + Streamable HTTP transport (stateless, fresh per request), Dockerfile. Verifies the gateway's bearer token on every request.
- **T2.2** REST client. **The base URL is the WordPress Service DNS name in the same namespace with a `Host: shop.localhost` header.** Pods cannot resolve `*.localhost` to the ingress, and WordPress redirects any request whose Host does not match its configured site URL. Test early whether WooCommerce accepts Basic auth with the key/secret over plain HTTP; if not, fall back to query-string keys or application passwords.
- **T2.3** Five tools with Zod schemas: `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status`. **`create_product` defaults to `publish`** (otherwise the product is a draft and never appears on the storefront, failing DoD step 2). **`list_orders` takes `after` / `before`** date parameters so "orders today" is answerable. Keep tool descriptions short and factual.
- **T2.4** Deploy woo-mcp into **`urumi-store`**, ClusterIP, no Ingress. NetworkPolicies: default-deny ingress in the namespace; woo-mcp accepts ingress only from the `urumi-gateway` namespace (select by the `kubernetes.io/metadata.name` label); WordPress accepts ingress only from ingress-nginx and woo-mcp; MariaDB accepts ingress only from WordPress and the bootstrap Job. Verify with the T1.1 pair, not by assumption.
- **T2.5** `docs/woo-store-access.md`: REST vs WP-CLI and why. REST is the documented public contract, needs no exec into the WordPress pod, and needs only the key pair already in a Secret.

### P3 Gateway core

- **T3.0** `apps/mock-mcp` **first**, so aggregation and routing are testable with two upstreams from day one.
- **T3.1** `apps/gateway` scaffold, config from env, Postgres pool, idempotent migrations, `/healthz` `/readyz`.
- **T3.2** `servers` + `server_credentials` admin CRUD. Credentials AES-256-GCM encrypted with a key from a Secret, using Node `crypto`. Verify plaintext never appears in an API response or a log line.
- **T3.3** Upstream pool: one MCP client per enabled server, lazy connect, capped exponential backoff. A **background health loop** (D24: 5s interval, 2s timeout, Unreachable after 2 failures) updates Connected / Unreachable / Disabled independently of any call. If an upstream reports its session is gone (404), re-initialise once and retry; some upstreams, such as the `everything` server, are stateful.
- **T3.4** Aggregator: **cached** tool list per server, refreshed by the health loop, so listing never waits on a dead upstream. Names per D5. Enforce limits on what an untrusted upstream can send: tool-name length, tools per server (for example 200), and description length. Record a hash of each tool description and surface a change flag in the dashboard: about 20 lines, and a real defence against a compromised upstream rewriting descriptions to manipulate the model.
- **T3.5** Router: prefix to server, enabled check, grants check, credential attach, per-call timeout, typed error on timeout/unreachable. **Cap result size** (for example 256 KB, truncated with a marker) so one upstream cannot flood the model or the client.
- **T3.6** Seed woo-mcp as the first server via **`make seed`**, which reads the woo-mcp token with kubectl from your machine and registers the server through the gateway's admin API. The gateway never reads Secrets in other namespaces.
- **T3.7 (NEW)** Client compatibility: clean 401 for a missing or invalid key; JSON 404 on `/.well-known/*` OAuth discovery paths. Connect MCP Inspector with only the gateway URL and a key, and run `tools/list` and a call. Do the same with Claude Code. This is part of C2.

### P4 Team, access, audit

- **T4.1** Keys: 32 random bytes, shown once, **stored as SHA-256** (not bcrypt: keys are high-entropy and looked up by hash, and bcrypt cannot be indexed). Show a short key prefix in the UI. Revoke = flag.
- **T4.1b (NEW)** Members create and revoke **only their own** keys through their own endpoint and UI. Admins can revoke any key. The brief says a team member generates their own key; an admin-only design misses that.
- **T4.2** Roles admin/member, enforced server-side on every admin route, not just hidden in the UI.
- **T4.3** Dashboard login: bcrypt/argon2 for **passwords** only, signed session cookie, SameSite plus a JSON-only CSRF defence. First admin seeded from a Secret. "Invite" means the admin creates a user with a one-time password or link; there is no email infrastructure, so the UI must not imply an email was sent.
- **T4.4** Audit per D22: every `tools/call`, including chat calls, failures and denied attempts; no arguments or results stored.
- **T4.5** `GET /api/audit`, paginated and filtered if time allows (D13 fallback: latest 200). Members see only their own rows; admins see all.

### P5 Dashboard (minimal)

- **T5.1** Vite + React + TS, static via nginx.
- **T5.2** Login. **T5.3** Servers: status, tools, add/edit/disable/remove, plus the tool-description change flag. **T5.4** Team and keys, including the member self-service key page. **T5.5** Audit log. **T5.6** Ingress default-deny NetworkPolicies in each namespace, allowing ingress only from ingress-nginx where the service is public (D25: no egress default-deny).
- Render model and upstream text as **plain text or escaped markdown**, never raw HTML, so a malicious tool result cannot inject script into the chat view.
- Show mock-mcp and everything as ordinary registered servers. An honest dashboard beats a clean-looking one that hides test scaffolding.

### P6 Chat agent

- **T6.1** LLM via the OpenAI-compatible endpoint (D10). Key Secret, confirm egress from the gateway pod, and confirm the endpoint returns tool calls in the expected shape for both Gemini and Ollama.
- **T6.2** Tool loop per D7 with a hard turn cap. The system prompt includes the **current date and timezone**, since the model does not know what "today" means, and `list_orders` needs `after` / `before`. Validate the model's arguments against the tool's Zod schema before dispatch and return validation errors to the model so it can retry.
- **T6.3** `POST /api/chat` over SSE, emitting which tool ran. History comes from the client with each request (D22).
- **T6.4** Verify audit rows show the human user, not a service account.

### P7 Failure demos

- **T7.1** Deploy `everything` from a pinned image, register all three upstreams.
- **T7.2** Demo the collision, the timeout via `sleep_forever`, and a stopped upstream (`kubectl scale --replicas=0`, D24) showing Unreachable while the others keep working, then scale back.
- **T7.3** Disable a server; its tools vanish from both the chat agent and the external client.

### P8 Definition of done (run twice on a clean cluster via `make reset && make up`)

T8.1 storefront checkout → T8.2 agent (user A, admin) creates a product → T8.3 manual order, agent lists today's orders → T8.4 user B (member) via Inspector or Claude Code → T8.5 two-server prompt → T8.6 revoke B → T8.7 disable a server → T8.8 stop a server and show Unreachable → T8.9 audit log shows everything, correctly attributed.

### P9 Docs and submission

Write the notes as you finish the phases they describe, so Oct 22 is polish, not authoring.

- **T9.1** README.md, outline in section 10. **T9.2** System design and tradeoffs (draft after P3). **T9.3** Threat model (draft after P4): a credential a member never sees, why client tokens are not passed upstream, malicious tool descriptions and what you built against them, prompt injection through tool results (for example order notes) against write tools, size caps, no raw HTML rendering, no egress default-deny (D25), member versus member. **T9.4** `docs/MCP-internals.md` with captured traffic. **T9.5** `docs/upgrade-rollback.md`, including a `helm rollback` you have actually rehearsed. **T9.6** `values-local.yaml`, `values-prod.yaml`, executed on the Mac mini k3s only if the Oct 20 go/no-go says yes. **T9.7** Demo video: record a rough pass right after C4, then the final one on Oct 22, scripted from the P8 steps.

### Stretch

- **T11.1 Tool permissions.** Per-role or per-user grants (D23: members blocked from `create_product` and `update_order_status`); restricted tools hidden from the list *and* rejected on direct call.
- **T11.2 Security hardening.** SSRF guard on admin-added URLs: always block loopback and link-local (including `169.254.169.254`); because your own upstreams are cluster-internal, allow cluster Service names only in an allow-list of namespaces (`urumi-store`, `urumi-upstreams`). Optional egress allow-list (D25). Non-root containers and encryption at rest are already in the base tasks.
- Phase 10 multi-store only if C3 is reached by end of Oct 16. Needs a decision first: shell out to the `helm` binary versus `@kubernetes/client-node`.

**Delegation rule (changed 2026-10-14).** The agent writes T3.4, T3.5, T4.1 and T4.3 too; the human reviews every line of them before commit. The brief grades whether you can defend the internals live in Round 2, so review these as if you wrote them. Delegate the dashboard, Helm templates, and Dockerfiles freely.

---

## 8. Gotcha checklist (read before the phase it names)

| Phase | Gotcha |
|---|---|
| P0 | CRLF line endings, repo on `/mnt/c`, giving WSL all its RAM |
| P1 | kindnet policies run FailOpen, so test with baseline + pair; official `wordpress` image has no WP-CLI; WooCommerce REST keys need `wp eval`; `kind load` after every build; `helm uninstall` deletes PVCs and Secrets unless kept; `lookup` is empty under `helm template`; checkout needs a shipping method |
| P2 | Secrets do not cross namespaces; pods cannot resolve `shop.localhost`; WordPress redirects on Host mismatch; pretty permalinks; Basic auth over plain HTTP; products default to draft |
| P3 | Fresh transport per request in stateless mode; listing must never wait on a dead upstream; stateful upstreams drop sessions (404); real clients probe `/.well-known`; cap result and tool-name sizes |
| P4 | SHA-256 for keys, bcrypt/argon2 only for passwords; log denied calls; members need their own key endpoint; do not store args or results |
| P5/P6 | ingress-nginx buffering breaks SSE; egress default-deny breaks the chat agent; never render raw HTML; the model needs the current date |
| P7 | Deleting a pod hides the failure (it comes back); scale to 0 instead |
| P9 | arm64 versus amd64 images; GHCR pull secret per namespace |

---

## 9. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Headless WooCommerce bootstrap eats days | `wordpress:cli` Job, half-day cap, documented manual fallback |
| R2 | Bitnami image/chart gating | Already avoided (D3) |
| R3 | Memory pressure | `.wslconfig` 20GB; keep Postgres and MariaDB limits modest |
| R4 | LLM rate limits or model retirement during reruns and video retakes | Pinned model, OpenAI-compatible endpoint with Ollama fallback (D10), rehearse exact prompts |
| R5 | SDK or spec drift | Pin in T0.4 and record why, including the 2026-07-28 discover nuance |
| R6 | Ingress and Host header surprises | T1.2 curl check before anything depends on it |
| R7 | Model sends bad tool arguments | Zod validation, error returned to the model, turn cap |
| R8 | Stretch eats the core | Checkpoints in section 6, hard cut order in D13 |
| R9 | Mac mini k3s step overruns | Oct 20 go/no-go, one-day time box, document instead |
| R10 | Not understanding AI-written code | Human reviews every line of T3.4, T3.5 and auth before commit; agent explains each decision (AGENTS.md section 2) |
| R11 | Reinstall breaks the DB because of a regenerated password | Keep policy on PVCs and Secrets (D20) |
| R12 | Real MCP clients behave differently from curl | Test Inspector and Claude Code at C2 (D26) |
| R13 | Schedule tail (docs, video, submit) crowded into Oct 22 | Write notes progressively, rough video after C4, buffer day Oct 23 |
| R14 | Prompt injection through tool results or descriptions | Description-change flag, size caps, plain-text rendering, documented in the threat model |

---

## 10. README.md outline (the deliverable)

1. What this is: three sentences plus the architecture diagram.
2. Prerequisites and versions, including the Docker memory minimum and WSL2 notes.
3. Local setup: `make up`, ingress, `*.localhost`, how to read generated secrets, `make reset`.
4. Place an order on the storefront.
5. Use the chat agent.
6. Connect an external MCP client: gateway URL, key, Claude Code / Cursor / Inspector snippets.
7. Production-like setup: Mac mini + k3s steps (or the documented path if no-go), values diff table (domain, ingress class, storage class, secrets, optional TLS), and an honest limitations list.
8. Upgrade and rollback with Helm.
9. Repo layout.
10. Links: design and tradeoffs, threat model, MCP internals, stretch items implemented.

Write each section's commands only after running them on the PC. Anything not yet run stays marked `TODO(verify)`.

---

## 11. Open questions

| ID | Question | Status |
|---|---|---|
| Q2 | Repo name | Pick on day 1 when creating the GitHub repo |
| Q10 | Mac mini RAM: 16 or 24GB? | Deferred to Phase 9, not blocking |
| Q11 | Rent a cheap VPS for a few days to get a real amd64 run? | Decide by Oct 16. If yes, rent Oct 20-22 only |
| Q13 | Any days between Oct 9 and Oct 22 when you cannot work a full day? | **Answered: no, all 14 days are full days.** Schedule in section 6 holds; P1 and P4 zero-slack phases are viable |
| Q14 | Repo name, for the GitHub repo created on day 1 | **Answered: `KubernetesBasedMCPGateway`** (private, `Kss004/KubernetesBasedMCPGateway`) |

No open questions remain.

Answered earlier: Q3 tool naming (D5), Q5 mock upstreams visible (P5), Q9 stretch swap (D12), Q12 Docker Desktop (section 3).

---

## 12. In flight

P0–P3 done. Gateway live: user keys, cached aggregation, `/mcp` routing
(11 tools, woo+mock+everything Connected). **C2 met 2026-10-14:** MCP
Inspector v2.11.0 over ingress with a member key — 11 tools in 24ms,
`mock__convert_currency` call in 31ms. WSL2 `/etc/hosts` now maps
`app/shop.localhost` (CLI tools could not resolve them before).
Hand-written zones lifted by the human 2026-10-14; agent writes, human reviews.

**Next: audit log, then dashboard login, then chat loop (C3).**

---

## 13. How to work this

- Do not start phase N+1 before phase N's verify passes. No dashboard before `curl` routes a call through the gateway. No chat UI before the loop works from curl.
- Run every verify command. No evidence, not done.
- After each task, add one line: what you built and the one non-obvious reason. You will be asked in Round 2.
- Ponytail rule: no ORM, no UI framework, no crypto library, no retry library, no LLM SDK, no DI container. Plain `fetch`, plain SQL, Node `crypto`, `node --test`. Deliberate shortcuts get a `// ponytail:` comment naming the ceiling and the upgrade path.

**Learning mode.** The human is doing AI-native coding and learning alongside, not accepting generated code blind. So for every task: state the context and the constraints before writing code, name the decision and the rejected alternatives as you make it, and say plainly what is uncertain or unverified. A task is not finished until the human could explain that task's design in a live walkthrough. Prefer one small understood thing over a large opaque one.

---

## 14. Verification notes (as of 2026-10-10)

**Verified**

1. The official `wordpress` image ships no WP-CLI (checked by grepping the generated Dockerfile and entrypoint). The `wordpress:cli` image exists (Docker Hub tag lookup returned 200).
2. kind v0.31.0's kindnetd embeds `sigs.k8s.io/kube-network-policies` and runs a policy engine configured `FailOpen: true`. A dead engine therefore *allows* traffic, so the denied half of the pair catches it; the allowed half and the baseline rule out mundane failures. The latest kind is v0.33.0 (released 2026-08-26); the note was checked on v0.31.0, so the T1.1 test result, not this note, is authoritative for the version you install.
3. Gemini's `FunctionDeclaration.name` permits dots (letters, digits, `_`, `.`, `:`, `-`, up to 128 chars). `__` is justified by client compatibility alone.
4. `naming.ts` with `namespaceTool` exists only on SDK `main` (v2.0.0-alpha.0), as example code and not an exported API. Do not present it as an SDK standard.
5. The SDK negotiates spec revision 2026-07-28 only via `server/discover`; the legacy `initialize` handshake offers only older versions.
6. **Gemini's OpenAI-compatible endpoint supports function calling.** Confirmed in the Gemini API docs: `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, `Authorization: Bearer`, `tools` with `type: "function"` and `tool_choice` accepted, standard `choices[0].message` response. This is what makes D10 possible and keeps the LLM loop SDK-free.
7. **T1.1 result (kind v0.33.0, 2026-10-09): policies ARE enforced on stock kindnet** — baseline OK/OK, then allowed OK / denied BLOCKED. No Calico needed; the T0.4 Calico item is closed.
8. **WooCommerce 11.2.1 over plain HTTP: Basic AND query-string ck/cs both 401** (verified live). Only OAuth 1.0a one-legged works. Plus the double-encoding quirk: `join_with_equals_sign()` re-encodes the joined `k=v`, so ISO datetimes fail while plain dates pass. `woo.ts:signedPair` replicates it; proven by real `list_orders(after=...)` returning order 12.
9. **SDK 1.32.1 speaks spec 2025-11-25, not 2026-07-28** (`npm view` + types.js; 2026-07-28 is v2-only). Staying on 1.x per decision; zod 4.6.5 satisfies its `^3.25 || ^4.0` peer range.
10. **`helm.sh/resource-policy: keep` verified with Helm v4.3.0** (T1.5): PVCs + Secrets survived `helm uninstall`, reinstall reused the DB password, product survived. `make reset` (`kind delete cluster`) verified to wipe everything.
11. **Upstream credential path verified live** (T2.4/T3.3): static bearer via `requestInit.headers.Authorization` works against our servers; `requestInit` exists on the 1.x client transport. Health loop flips Connected→Unreachable on scale-to-0 (~50s stock, ~15s with 10s grace) and back.
12. **K8s RBAC: `resourceNames` is ignored on `create`** — real POST 403s while `kubectl auth can-i` says yes. Role grants bare `create` (namespace-bounded) + name-scoped get/delete.
13. **Mount PVCs ON the image's VOLUME path, never its parent (2026-10-13).** The postgres chart mounted at `/var/lib/postgresql` while the image declares `VOLUME .../data` → double mount, postgres wrote to ephemeral storage, first container restart wiped the gateway DB (initdb ran fresh). Fix: mount at `/var/lib/postgresql/data`. MariaDB/WP were correct (single mounts). Verify with `/proc/mounts`, not assumptions.
14. **C2 met 2026-10-14 (gateway 0.2.0).** `/mcp` serves 11 prefixed tools across woo+mock+everything; curl: clean 401 no/bad key, `initialize` 2025-11-25, `tools/call` routes to all three (real Woo products returned), unknown → -32602. SDK client via gateway: 11 tools + call. Inspector v2.11.0 over ingress with member key: 11 tools in 24ms, `mock__convert_currency` 100 USD→EUR = 92 in 31ms. Key revoke round-trip verified. Hand-written zones lifted by human; agent writes, human reviews.
15. **WSL2 CLI DNS (2026-10-14).** WSL2 does not resolve `*.localhost` via the Windows resolver for all CLI tools; mapping `127.0.0.1 app.localhost shop.localhost` in WSL2 `/etc/hosts` fixed Node/Inspector CLI access to the ingress. Browsers were unaffected.

**Not yet verified (check before relying on them)**

- Gemini's and Ollama's OpenAI-compatible endpoints both return tool calls in the shape the loop expects (T6.1). Early key/model smoke test due before Oct 14 (R4) — now overdue, do before the chat loop.
- Claude Code handles the 401 and `/.well-known` 404 behaviour as described (T3.7). Inspector proven; Claude Code still to prove.
- Whether Ollama's OpenAI-compatible endpoint returns tool calls in the same shape as Gemini's (T6.1).

---

## 15. Change log, second revision

| # | Change | Reason |
|---|---|---|
| 1 | woo-mcp moved to `urumi-store`; added the Secrets map; woo-mcp token vs REST key separated; `make seed` registers the server (D18, T2.4, T3.6) | Secrets cannot be mounted across namespaces; the old T3.6 conflated two different secrets |
| 2 | PVC/Secret keep policy and a reworked persistence test (D20, T1.3, T1.5) | `helm uninstall` deletes PVCs and Secrets, and a regenerated DB password is rejected by the old data |
| 3 | `WP_HOME`/`WP_SITEURL` via config (D21, T1.3) | A URL stored in the database causes redirect loops when the domain changes |
| 4 | Checkout bootstrap (country, currency, shipping), `create_product` publishes, `list_orders` date params, date in the chat prompt (T1.4, T2.3, T6.2) | Without these, DoD steps 1, 2 and 3 fail |
| 5 | `make up/down/reset/seed` (D19, T0.5) | DoD runs twice on a clean cluster and a reviewer must reproduce it |
| 6 | Scale-to-zero failure demo and health timings (D24, T7.2, T8.8) | A deleted pod is recreated before the dashboard shows it |
| 7 | Real clients tested at C2 with 401 and well-known 404 handling, upstream session re-init (D26, T3.3, T3.7) | Real clients behave differently from curl |
| 8 | OpenAI-compatible LLM endpoint, no SDK (D10, T6.1) | One tool-calling format covers Gemini and the Ollama fallback; rate limits and model retirement are a real risk |
| 9 | Ingress-only default-deny (D25, T5.6) | Egress default-deny would break the chat agent |
| 10 | Member self-service keys (T4.1b, T5.4) | The brief says members generate their own key |
| 11 | A = admin, B = member; T11.1 restricts members from writes (D23) | Keeps the DoD valid after tool permissions are added |
| 12 | Audit and privacy decisions (D22, T4.4, T4.5) | Storing args and results risks leaking customer data; scoping answers the member-versus-member question |
| 13 | Upstream limits, result cap, plain-text rendering, no service-account tokens, SSRF allow-list design (T3.4, T3.5, T5, per-workload checklist, T11.2) | An untrusted upstream can send hostile or oversized content |
| 14 | Schedule rebalanced: notes written progressively, rough video after C4, Oct 20 go/no-go for the Mac mini, P4 cut order (section 6, D13) | Oct 22 carried docs, video, k3s and submission |
| 15 | T1.1 rewritten with baseline, pair and the "(b) fails" branch; C3 date made consistent; kind version note qualified; "not yet verified" list added | Closes gaps found in the previous version of this file |