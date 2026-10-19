# Design tradeoffs (draft, P9 T9.2 — from progrestillnow.md D1–D26)

Source of truth for decisions: `progrestillnow.md` §5. One line each; undo order in D13.

- **D1 TS/Node 24 everywhere** — one runtime/image, shared types, reference SDK (1.x pinned, T0.4). Cost: no Python ecosystem.
- **D2 kind + Netpol pair test** — stock kindnet enforces (T1.1 passed on v0.33.0, baseline+pair); no Calico. kindnet is FailOpen, so the denied-half is the real signal.
- **D3 Own store chart, official images** — Bitnami gated since Aug 2025; version-gate risk traded for chart-writing cost.
- **D4 Postgres for gateway metadata** — multi-replica future vs SQLite+PBC half-day saving. Cut only if behind Oct 14 (passed; keep only if defensible live).
- **D5 `<slug>__<tool>`** — client function-name compat (Anthropic/OpenAI `[A-Za-z0-9_-]`), not Gemini (allows dots). No aliasing; 64-char cap enforced at list.
- **D6 Stateless gateway, fresh transport per request** — any replica serves any call; gives up server-initiated `tools/list_changed` notifications.
- **D7 In-process chat agent, same aggregator** — one routing + audit path; no HTTP hop to ourselves.
- **D8 mock + everything as upstreams #2/#3** — deterministic/offline; `everything` pinned image, never `npx` at pod start.
- **D10 OpenAI-compatible chat endpoint, plain fetch, no SDK** — one tool-call format for Gemini (primary) + Ollama fallback; provider switch = 3 env vars. TODO(verify): both endpoints' tool-call shape (T6.1).
- **D11 All secrets generated (`randAlphaNum` + `lookup`, kept)** — no hardcoded secrets; `lookup` is empty under `helm template`, so test with real installs.
- **D16 Images: local build + `kind load`; GHCR multi-arch for prod** — kind nodes can't see host images; mini is arm64, VPSes amd64.
- **D17 `*.localhost` domains** — loopback with no hosts edits, reviewer-identical; nip.io fallback.
- **D18 woo-mcp in `urumi-store`** — Secrets don't cross namespaces; woo-mcp mounts the WC REST key where it lives. Gateway→woo-mcp bearer is a separate secret, seeded via `make seed`.
- **D19 One-command bring-up (`make up/down/reset/seed`)** — DoD runs twice on a clean cluster; TODO(verify): `up` still stubs.
- **D20 Keep PVCs + Secrets on uninstall** — else regenerated DB passwords are rejected by old data dirs; only `make reset` wipes.
- **D22 Audit: log every call + denial, never args/results** — customer data/secrets live in args; tradeoff = less forensic detail. Members see own rows only.
- **D24 Failure demos via `scale --replicas=0`** — pod deletion self-heals too fast to show Unreachable; health probe 5s/2s/Unreachable-after-2.
- **D25 Ingress default-deny only; no egress deny** — chat agent needs LLM/DNS/PG/upstream egress. Gap stays open; documented in threat model (T11.2 optional allow-list).
- **D26 Real clients at C2, not P8** — 401 + `/.well-known` JSON-404 handling; Inspector proven 2026-10-14, Claude Code TODO(verify).
- **D27 Unreachable tools stay listed; Disabled tools are hidden (decided 2026-10-19, E2E L6)** — Disabled is an admin decision, so its tools leave `tools/list` and chat at once. Unreachable is an outage: the last-known tool list stays cached and a call fails fast with a clear `server unreachable` error (C2). Clients keep a stable tool list instead of tools flickering on every blip, and the model can tell the user the server is down. Tradeoff: a client may offer a tool that will fail until the server is back.
