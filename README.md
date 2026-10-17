# KubernetesBasedMCPGateway — Urumi MCP Gateway on Kubernetes

## 1. What this is

A multi-tenant MCP gateway on Kubernetes: one `POST /mcp` endpoint aggregates
WooCommerce (`woo-mcp`), a deterministic mock (`mock-mcp`), and the SDK
`everything` server into prefixed tools (`<slug>__<tool>`). The gateway holds
all upstream credentials; clients use only the gateway URL + a user API key.

```
shop.localhost ──► WordPress + WooCommerce (urumi-store)
app.localhost  ──► gateway /mcp + /api (urumi-gateway)
MCP clients ──► gateway URL + `Authorization: Bearer <user key>` only
gateway ──► woo-mcp (urumi-store) + mock/everything (urumi-upstreams), Streamable HTTP
```

Details: `progrestillnow.md` §4, `docs/design-tradeoffs.md`, `docs/threat-model.md`.

## 2. Prerequisites and versions

- WSL2 + Ubuntu 24.04, repo on the WSL filesystem (not `/mnt/c`); `.wslconfig`: 20GB RAM, 8 CPUs.
- Docker Desktop (WSL2 backend), kind, kubectl, helm, node 24, make.
- `*.localhost` resolves to loopback in browsers; WSL2 CLI tools needed an
  `/etc/hosts` entry (`127.0.0.1 app.localhost shop.localhost`) — verified 2026-10-14.
- Pins: `docs/versions.md` (node v24.21.0, SDK 1.32.1 / spec 2025-11-25,
  kind v0.33.0, helm v4.3.0, ingress-nginx 4.15.1, WP 7.1.3, WC 11.2.1).

## 3. Local setup — TODO(verify): `make up` is still stubs (Makefile prints TODO)

```bash
make up        # TODO(verify): target = kind create + ingress + build/load + helm install + seed
make seed      # registers woo-mcp via admin API (reads token with kubectl, gateway never reads other namespaces)
make reset     # kind delete cluster — wipes everything (asks first in real use)
```

Ingress: `app.localhost` → gateway, `shop.localhost` → WordPress (ingress-nginx,
`proxy-buffering: off` on `/mcp`, `/api/chat`). Generated secrets (all
`randAlphaNum` + `lookup`, kept on uninstall): read human-needed ones with, e.g.
`kubectl -n urumi-gateway get secret <name> -o jsonpath=...` — never commit values.

Live state 2026-10-16: cluster `urumi` up; `urumi-gateway` / `urumi-store` /
`urumi-upstreams` all Running; `helm list -A` shows gateway/store/upstreams +
ingress-nginx deployed; `/healthz` → ok, `/readyz` → ready.

## 4. Place an order on the storefront — TODO(verify): re-run on clean `make up`

1. Open `http://shop.localhost/`, add a product to cart, checkout (COD; store needs
   country/currency + a shipping zone with a method or checkout fails).
2. Confirm the order in wp-admin and via `list_orders` (DoD T8.1/T8.3).

## 5. Use the chat agent

`POST /api/chat` (SSE) with the logged-in session; history is client-sent per
request (never stored server-side). System prompt pins current date/timezone so
"today" maps to `list_orders(after/before)`. Audit rows attribute the human user.

### LLM provider keys

The key never goes in values or git. Each provider has its own Secret (key
`api-key`) in `urumi-gateway`. `llm.secretName` picks which one the gateway
reads. Load a key without echoing it or saving it to shell history:

```bash
# Gemini (default: llm.secretName=llm)
read -rs K && kubectl -n urumi-gateway create secret generic llm --from-literal=api-key="$K" --dry-run=client -o yaml | kubectl apply -f - ; unset K

# Groq (fallback)
read -rs K && kubectl -n urumi-gateway create secret generic llm-groq --from-literal=api-key="$K" --dry-run=client -o yaml | kubectl apply -f - ; unset K
```

After `read -rs K`, paste the key at the blank prompt and press Enter.

Switch provider (values only, no code change):

```bash
# to Groq
helm upgrade gateway ./charts/gateway -n urumi-gateway --reuse-values \
  --set llm.secretName=llm-groq \
  --set llm.baseUrl=https://api.groq.com/openai/v1 \
  --set llm.model=qwen/qwen3.8-27b

# back to Gemini
helm upgrade gateway ./charts/gateway -n urumi-gateway --reuse-values \
  --set llm.secretName=llm \
  --set llm.baseUrl=https://generativelanguage.googleapis.com/v1beta/openai \
  --set llm.model=gemini-3.8-flash
```

Tested 2026-10-17: `gemini-3.8-flash` and Groq `qwen/qwen3.8-27b` both run the tool loop. Groq `openai/gpt-oss-120b` failed (sent `null` for an optional argument), so avoid it.

A key change alone (same Secret) needs `kubectl -n urumi-gateway rollout restart deploy/gateway-gateway`, because env vars are read at pod start.

## 6. Connect an external MCP client

- Gateway URL: `http://app.localhost/mcp` (Streamable HTTP). Key: member or admin
  user key (`Authorization: Bearer <key>`), created via dashboard/API, shown once.
- Verified 2026-10-14 (C2): MCP Inspector v2.11.0 over ingress with a member key —
  `tools/list` 11 tools in ~24ms, `mock__convert_currency` call in ~31ms.
  No/bad key → clean `{"error":"unauthorized"}` 401 (re-verified 2026-10-16);
  `/.well-known/*` → JSON 404.
- Inspector: server URL + `Authorization: Bearer <key>` in the connection headers
  (its own `MCP_INSPECTOR_API_TOKEN` is unrelated to our key).
- Claude Code / Cursor: TODO(verify) — configure the gateway URL with a static
  `Authorization` header; Claude Code 401/`well-known` behaviour not yet proven
  (Inspector only so far).

## 9. Repo layout

```
apps/gateway       /mcp aggregator+router, /api admin/users/audit/chat, postgres
apps/woo-mcp       5 Woo tools over WC REST (OAuth1a, same-namespace Service DNS)
apps/mock-mcp      deterministic upstream #2 (incl. colliding name, sleep_forever)
apps/everything-mcp  SDK everything server, pinned image (upstream #3)
charts/{gateway,store,upstreams}  Helm charts (+ values-local/prod overrides)
scripts/seed.sh    registers woo-mcp through the admin API
docs/              versions.md, woo-store-access.md, design-tradeoffs.md,
                   threat-model.md, notes/ (per-task evidence)
progrestillnow.md  source of truth: status, decisions D1–D26, risks R1–R14
```

§7 production-like (k3s/Mac mini) + §8 upgrade/rollback: TODO(verify) — P9 awaits
Oct 20 go/no-go; `helm rollback` rehearsal not yet done.
