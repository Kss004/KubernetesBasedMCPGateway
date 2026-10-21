# System design and tradeoffs

Short note for reviewers: what the system is made of, how a tool call travels, how failures are
contained, and what changes for production. Selected decisions are listed at the end, with IDs
from `progrestillnow.md` (section 5); the evidence is in `docs/notes/`.

## Architecture choices

- **Three Helm charts, three namespaces.** `store` (WordPress, MariaDB, woo-mcp, bootstrap
  Job), `upstreams` (mock-mcp, everything-mcp) and `gateway` (gateway, Postgres). Secrets live in
  the namespace of the workload that uses them, because Secrets do not cross namespaces (D18).
  That is why woo-mcp sits next to the store: it mounts the WooCommerce REST key, and nothing else
  ever holds it.
- **One gateway process.** It serves the dashboard (static React build), the dashboard API
  (`/api`), the MCP endpoint (`/mcp`) and the chat agent (`/api/chat`). The chat agent runs
  in-process and calls the same aggregator and router as external clients, so there is one
  routing and audit path (D7).
- **Stateless per request (D6).** Every `/mcp` POST is handled on its own by a small JSON-RPC
  handler (`router.ts`): no MCP session and no `Mcp-Session-Id`. Every upstream call gets a fresh
  SDK client. Any replica can serve any request; the cost is no server-initiated
  `tools/list_changed` notifications.
- **TypeScript and Node 24 everywhere, the reference MCP SDK pinned to 1.x** (D1). No ORM, no
  LLM SDK, and one crypto dependency only: `bcryptjs` for passwords. Everything else is plain
  SQL, plain `fetch` and Node `crypto`. The one addition is `undici` (pinned to the version Node
  bundles), so the SSRF guard can check each external upstream's IP at connect time.
- **Postgres for gateway metadata** (servers, encrypted credentials, users, hashed keys, audit),
  so the gateway itself stays stateless (D4).
- **woo-mcp talks to WooCommerce over its REST API** (OAuth 1.0a over in-cluster HTTP), not
  WP-CLI or SQL. REST is the public contract, keeps WooCommerce's business logic (totals, stock,
  status transitions), and needs no exec into the WordPress pod. Details:
  `docs/woo-store-access.md`.

## How aggregation, routing and failure handling work

**Aggregation** (`apps/gateway/src/aggregator.ts`):
- Every 15s, and right after an admin adds, edits or deletes a server, the gateway lists the
  tools of every enabled server in parallel, with a 5s timeout each.
- Names become `<slug>__<tool>`. The slug is `[a-z0-9-]`, and a tool whose prefixed name would
  exceed 64 characters is skipped, not truncated. This is the **collision scheme** (D5):
  `mock` deliberately also exposes
  `list_products`, and clients see `woo__list_products` and `mock__list_products`. Nothing is
  aliased.
- Caps for untrusted upstreams: at most 200 tools per server, and descriptions truncated to
  1024 characters. Each description is hashed. A changed description is flagged
  `[description changed]` in the dashboard for one refresh cycle (about 15s, in memory per pod),
  so a rug-pull is visible only to someone watching. Persisting the hash is the upgrade.
- A server that fails to list keeps its last-known tools (D27).

**Routing** (`router.ts`, `pool.ts`), for `tools/call woo__list_orders`:
1. Check the key: SHA-256 of the bearer key, then look up the user and role. A revoked or unknown
   key gets `401`.
2. Check the role: members cannot see or call `woo__create_product`,
   `woo__update_order_status`, `mock__sleep_forever` or `mock__break_me` (`grantsAllow`). A denied call gets `-32000` and an audit row
   `denied`.
3. Resolve the full prefixed name to its server. The server must be enabled and not Unreachable.
4. Decrypt that server's credential (AES-256-GCM, key in a Secret) and attach it as a bearer or
   custom header, gateway-side only. Call the upstream over Streamable HTTP with a 30s timeout.
   One re-initialise happens only for the transport's own 404 "session gone" error, so a failed
   write never runs twice.
5. Cap the result at 256 KB. Write the audit row: user, server, tool, time, duration, outcome,
   error class. Arguments and results are never stored (D22).

**Failure handling** (`pool.ts`):
- **Health probe:** every 5s, 2s timeout. Two consecutive failures mark a server Unreachable
  (about 10s: measured 9.1s in E2E round 2 and 10s in round 8). While it is down, it is
  re-probed with a capped backoff of
  5/10/15s.
- **Outage isolation:** probes and tool listing run in parallel per server, so a slow or dead
  upstream cannot delay the others. A call to an Unreachable server fails fast with JSON-RPC error
  `-32000 server unreachable` instead of waiting for the timeout.
- **Timeouts are actually enforced.** The MCP SDK's transport ignores `requestInit.signal`, so
  our timeouts had never fired: a hanging upstream held a probe for 13-65s. The gateway now
  passes the abort signal per request (`connect`, `listTools`, `callTool`) and always closes the
  client. Tests use an upstream that accepts connections and never answers.
- **Disabled vs Unreachable:** a Disabled server's tools disappear from `tools/list` and from
  chat at once. An Unreachable server's tools stay listed and fail fast with a clear error (D27).
- **Graceful shutdown:** every service handles SIGTERM. As PID 1, Node ignores it otherwise, and
  a scaled-down pod kept serving for its whole grace period.
- **LLM failures:** a primary error, or a 429 that survives one retry, moves the request to the
  fallback provider (D10). The user sees a plain "model is busy" message only if the fallback is
  also rate-limited.

## What changes for production

The same charts are used; only values change (`charts/*/values-prod.yaml`, README section 7):

| Concern | Production setting |
|---|---|
| DNS and hosts | real `appHost` / `storeHost` (required values); `storeUrl: https://...` sets WP_HOME and WP_SITEURL (D21) |
| Ingress | Traefik on k3s: `ingress.className: traefik`; NetworkPolicies admit only Traefik pods in `kube-system`; nginx-only annotations nulled |
| TLS | `ingress.tlsSecretName` plus `ingress.certIssuer: letsencrypt-prod`: the chart creates the cert-manager `Certificate` (the ClusterIssuer is created once per cluster). Or leave `certIssuer` empty and bring your own TLS Secret. `session.cookieSecure: true` |
| Storage class | `storage.className: local-path` on k3s; PVCs keep data across uninstalls (D20) |
| Secrets | still generated in-chart; LLM keys created out-of-band with `make secrets`; `imagePullSecrets` for private GHCR images |
| Images | `ghcr.io/kss004/kubernetesbasedmcpgateway/<name>:<tag>`, built with buildx |

All of this except TLS, GHCR pulls and `cookieSecure: true` (P4-k3d.md, "Not covered") was
rehearsed on k3s (k3d v5.9.0) with `make prod-up` / `make prod-check`: from zero
at gateway 0.4.2 (2026-10-18), and the current build (0.4.14) on 2026-10-20. The k3s run found 6
bugs, 4 of which kind hid; see `docs/notes/P4-k3d.md`. The same charts now run on a real k3s VPS
with Let's Encrypt TLS; that run found 4 more problems (`docs/notes/P5-vps.md`).

### Replicas: why one gateway pod, and what a second one needs

The gateway runs `replicas: 1`. The request path is already replica-safe: `/mcp` and chat hold no
session (D6), dashboard sessions are signed cookies checked against `session_version` in
Postgres, and servers, keys and audit all live in Postgres. Two things are per pod, in memory:
- **Login limiter** (5 failures per name or IP, then a 60s lock). With N pods behind round-robin
  an attacker gets up to 5×N tries per window. Fix: keep the counters in Postgres (or Redis).
- **LLM fallback cool-down.** Each pod finds out on its own that the primary model is down.
  Harmless, only a few extra failed calls.

Health status, tool lists and the `[description changed]` flag are also per pod, but each pod
rebuilds them from Postgres and its own probes within seconds, so they converge. Startup
migrations run per version inside a transaction; if two pods race on a fresh database the loser
fails on the version row and its retry loop finds it applied (a Postgres advisory lock would make
that explicit). So `replicas: 2` works today with a weaker lockout; the limiter is the one change
to make before scaling out. Postgres itself is a single StatefulSet pod (D4), the real
single point of failure.

## Decisions log

- **D1 TS/Node 24 everywhere** — one runtime/image, shared types, reference SDK (1.x pinned, T0.4). Cost: no Python ecosystem.
- **D2 kind + Netpol pair test** — stock kindnet enforces (T1.1 passed on v0.33.0, baseline+pair); no Calico. kindnet is FailOpen, so the denied-half is the real signal.
- **D3 Own store chart, official images** — Bitnami gated since Aug 2025; version-gate risk traded for chart-writing cost.
- **D4 Postgres for gateway metadata** — multi-replica future vs the half-day saved by SQLite on a PVC. Kept: lets the gateway stay stateless and run more than one replica later.
- **D5 `<slug>__<tool>`** — client function-name compat (Anthropic/OpenAI `[A-Za-z0-9_-]`), not Gemini (allows dots). No aliasing; 64-char cap enforced at list.
- **D6 Stateless gateway, fresh transport per request** — any replica serves any call; gives up server-initiated `tools/list_changed` notifications.
- **D7 In-process chat agent, same aggregator** — one routing + audit path; no HTTP hop to ourselves.
- **D8 mock + everything as upstreams #2/#3** — deterministic/offline; both are our own small servers on `mcp-mini` (`everything` is not the official server-everything). **Upstream #4 is DeepWiki** (`https://mcp.deepwiki.com/mcp`), a public hosted MCP server we did not write: it proves the gateway works with a third-party server over the internet, through the SSRF guard. Tradeoff: it depends on an outside service; if it is down it shows Unreachable and the others keep working.
- **D10 OpenAI-compatible chat endpoint, plain fetch, no SDK; automatic provider fallback** — one tool-call format and one loop for every provider; switching a provider is 3 values. History: Gemini primary (Oct 17, tool-call shape verified live, `thought_signature` echoed for Gemini 3), Groq after Gemini chat completions hung (Oct 19), then DeepSeek v4.1 flash on OpenCode Go (Oct 20) because Groq's free tier refused about half the demo prompts. Groq is now an automatic fallback (`makeLlmCaller`: on a provider error the request moves to the fallback and the primary rests 60s). OpenCode Go is aimed at coding agents and monitors traffic; the gateway identifies itself honestly (own `User-Agent`, per-conversation `x-opencode-session`), and the user accepted that risk for a short demo. Verified: tool calls, a two-turn loop, and failover against both live providers.
- **D11 All secrets generated (`randAlphaNum` + `lookup`, kept)** — no hardcoded secrets; `lookup` is empty under `helm template`, so test with real installs.
- **D16 Images: local build + `kind load`; GHCR multi-arch for prod** — kind nodes can't see host images; mini is arm64, VPSes amd64.
- **D17 `*.localhost` domains** — loopback with no hosts edits, reviewer-identical; nip.io fallback.
- **D18 woo-mcp in `urumi-store`** — Secrets don't cross namespaces; woo-mcp mounts the WC REST key where it lives. Gateway→woo-mcp bearer is a separate secret, seeded via `make seed`.
- **D19 One-command bring-up (`make up/down/reset/seed`, `make prod-up/prod-check`)** — a reviewer reproduces everything with one command. Verified: `make prod-up` from zero on fresh k3d clusters passed first time (P4-k3d.md); `make seed` registers the three in-cluster upstreams, plus DeepWiki when online.
- **D20 Keep PVCs + Secrets on uninstall** — else regenerated DB passwords are rejected by old data dirs; only `make reset` wipes.
- **D22 Audit: log every call + denial, never args/results** — customer data/secrets live in args; tradeoff = less forensic detail. Members see own rows only.
- **D24 Failure demos via `scale --replicas=0`** — pod deletion self-heals too fast to show Unreachable; health probe 5s/2s/Unreachable-after-2.
- **D25 Ingress default-deny only; no egress deny** — chat agent needs LLM/DNS/PG/upstream egress. Gap stays open; documented in threat model (T11.2 optional allow-list).
- **D26 Real clients early, not at the end** — 401 with `WWW-Authenticate: Bearer` and JSON 404 on `/.well-known/*`. Verified: MCP Inspector 2.11.0 (UI on Oct 14; CLI on Oct 20) and Claude Code 2.1.304 as an HTTP MCP client with a static `Authorization` header (Oct 20, DEMO-RUNBOOK.md). Cursor is not tested.
- **D27 Unreachable tools stay listed; Disabled tools are hidden (decided 2026-10-19, E2E L6)** — Disabled is an admin decision, so its tools leave `tools/list` and chat at once. Unreachable is an outage: the last-known tool list stays cached and a call fails fast with a clear `server unreachable` error (C2). Clients keep a stable tool list instead of tools flickering on every blip, and the model can tell the user the server is down. Tradeoff: a client may offer a tool that will fail until the server is back.
- **D28 Chat guard against invented store data: block, nudge once, then fall back (2026-10-19, E2E H1/R1)** — the prompt alone did not stop `qwen/qwen3.8-27b` from inventing orders on follow-up turns (2 of 4 runs), so `driveLoop` blocks a reply that shows store-like tokens (`#N`, money, `N.NN`) when no tool ran in the request, except tokens the user typed. The model gets one nudge to call the tool; if it still does not, the user sees a fixed "couldn't look that up" message. Verified 6 of 6 runs in E2E round 3. Rejected: `tool_choice: "required"` (forces pointless calls on greetings and the final answer turn) and truncating history (lowers the odds, guarantees nothing). Not tightened to "every shown token must appear in this request's tool results", because legitimate computed answers ("3 orders, total $60.00") would be rejected and end in the fallback. Limits: see the threat model.
