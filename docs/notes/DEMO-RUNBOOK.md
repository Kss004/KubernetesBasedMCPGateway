# Demo recording runbook (DoD walkthrough)

The script for the demo video, on kind (`http://app.localhost`, `http://shop.localhost`).
For the live VPS (https, sslip.io hosts) use `DEMO-RUNBOOK-VPS.md`.
Every step below was dry-run on 2026-10-20 at gateway 0.4.14:
- MCP Inspector CLI 2.11.0 with a member key: 9 tools, `woo__list_orders` today gave
  `count 3, total 61.73`, and `mock__convert_currency` 100 USD gave 92 EUR;
- Claude Code 2.1.304 as B's client answered "orders today" and the two-server prompt,
  with the audit rows attributed to B.

## 0. Before recording (about 10 min)

1. Start Docker Desktop and wait for "Engine running". Then `make smoke`; expect
   `smoke: all checks passed` (13).
2. WSL hosts line: Node tools (Inspector, Claude Code) cannot resolve `*.localhost` without it.
   ```bash
   grep -q 'app.localhost' /etc/hosts || echo '127.0.0.1 app.localhost shop.localhost' | sudo tee -a /etc/hosts
   ```
   `/etc/wsl.conf` has `generateHosts = false`, so it survives `wsl --shutdown`.
3. Clean slate (test data is listed in `docs/notes/E2E-2026-10-19.md` "Test data and hygiene", in the
   "Test data" sections of rounds 2-4, and in `E2E-2026-10-19-round5-8.md`):
   - revoke B's old keys;
   - rotate the A and B passwords with the password commands in README section 3, step 3;
   - remove the old `urumi-gateway` entry from `~/.mcp-inspector/mcp.json`. It holds B's old key
     `b455739e` in plain text.
4. Chat model: DeepSeek v4.1 flash (OpenCode Go), with automatic Groq fallback. If chat says "the
   model is busy", wait about 2 minutes. Groq's free tier is tight.
5. Windows to open:
   - A: a normal browser window at the dashboard;
   - B: a private window at the dashboard;
   - shopper: a second private window at the store;
   - two WSL terminals: one for `kubectl`, one for Inspector or Claude Code.
6. Admin token for terminal checks. It stays in the shell and is never printed:
   ```bash
   T=$(kubectl -n urumi-gateway get secret gateway-admin -o jsonpath='{.data.token}' | base64 -d)
   ```

## 1. The store works (shopper)
Shopper window: http://shop.localhost/shop, add any product, check out with Cash on delivery and a
US test address. Expect "Order received". Note the number.

## 2. Admin sees the gateway (A)
Log in as A, which opens the **Servers** tab. Show:
- `woo`, `mock`, `everything` and `deepwiki` all **Connected**, 14 tools in total. `deepwiki` is a
  public hosted MCP server we did not write, added by URL;
- auth shows only "secret set" (no secret values).

## 3. Chat writes to the store (A, chat agent)
**Chat**: `Create a product called Demo Desk Lamp priced 33.25`. Expect a `woo create_product ✓`
chip. Then:
1. Shopper window: reload `/shop`. **Demo Desk Lamp** shows at $33.25. Buy it with COD.
2. WooCommerce admin screen: in a new tab, open http://shop.localhost/wp-admin and log in as
   `admin`. The password comes from:
   ```bash
   kubectl -n urumi-store get secret store-wp-admin -o jsonpath='{.data.password}' | base64 -d; echo
   ```
   Go to **WooCommerce → Orders**: the new order shows with status **Processing**.

## 4. Chat reads the store, across two servers (A)
Leave about a minute between prompts.
1. `What orders came in today?`: a `list_orders ✓` chip, then the count and total. The total
   comes from the tool (`list_orders` returns `count`/`total`); the model never adds it up itself.
2. `Get today's order total and convert it from USD to EUR.`: `woo list_orders ✓` then
   `mock convert_currency ✓`.

## 5. A member with a real MCP client (B)
Log in as B in the private window. B lands on **Chat**, with no Servers tab.
**Team & Keys → Generate my key**, then **Copy** (it is shown once).

### 5a. MCP Inspector
```bash
MCP_INSPECTOR_SECRET_STORE=memory npx -y @modelcontextprotocol/inspector@2.11.0
```
`MCP_INSPECTOR_SECRET_STORE=memory` keeps the key out of files on disk (2.11 otherwise falls back
to plain files when there is no OS keychain).

In the Inspector tab that opens, connect with:
- transport **Streamable HTTP**
- URL `http://app.localhost/mcp`
- header `Authorization: Bearer <B key>`

Check the exact 2.11 UI labels when you open it.
- **List tools**: 10 tools, prefixed `woo__`, `mock__`, `everything__`, `deepwiki__`. There is **no**
  `woo__create_product`, `woo__update_order_status`, `mock__sleep_forever` or `mock__break_me`
  (member role).
- Call `woo__list_orders` with `after` = `<today>T00:00:00` and `before` = `<today>T23:59:59`.
  It returns `count`, `total` and the orders.
- Call `mock__convert_currency` (amount = that total, from USD, to EUR). Two servers, one client,
  one key.

The same calls from the CLI, if the UI misbehaves:
```bash
K='<B key>'; I="npx -y @modelcontextprotocol/inspector@2.11.0 --cli http://app.localhost/mcp --transport http --header"
MCP_INSPECTOR_SECRET_STORE=memory $I "Authorization: Bearer $K" --method tools/list
MCP_INSPECTOR_SECRET_STORE=memory $I "Authorization: Bearer $K" --method tools/call --tool-name woo__list_orders --tool-arg after=$(date -u +%F)T00:00:00 before=$(date -u +%F)T23:59:59
```

### 5b. Claude Code
In an empty folder:
```bash
claude mcp add --transport http harbor http://app.localhost/mcp --header "Authorization: Bearer <B key>"
claude mcp list            # harbor: ... (HTTP) - Connected
claude                     # then ask:
```
- `Using the harbor MCP tools: what orders came in today (UTC)? Give the count and total.`
- `Using the harbor MCP tools: get today's order total, then convert it from USD to EUR.`

Approve the harbor tool calls when Claude Code asks. Remove the server afterwards with
`claude mcp remove harbor`.

## 6. Permissions are enforced server-side (B)
- B **Chat**: `Create a product called Hack Mug priced 1.00`. Expect a one-sentence refusal and
  no tool call. Nothing appears in the store.
- Optional, terminal: a direct `tools/call woo__create_product` with B's key gets
  `-32000 forbidden for role` and an audit row `denied`.

## 7. Revoke a key (A)
A, **Team & Keys → All keys**: revoke B's key (confirm the dialog). The next Inspector or Claude Code
call fails. In the terminal it prints `401`:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://app.localhost/mcp -H "Authorization: Bearer $K" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 8. Disable and re-enable a server (A)
**Servers → Disable** `mock`: it shows Disabled at once and its tools are gone. Chat
`Convert 100 USD to EUR.` gets one plain sentence, "no tool for that", with no tool call.
**Enable**: Connected again with 14 tools.

## 9. A dead server (failure demo)
First show why deleting the pod is not enough: the Deployment recreates it within seconds, so
the dashboard may never show Unreachable (D24).
```bash
kubectl -n urumi-upstreams delete pod -l app=everything-mcp      # comes back almost at once
```
Then take it down for real:
```bash
kubectl -n urumi-upstreams scale deploy/upstreams-everything-mcp --replicas=0
```
- Within about 10s, `everything` shows **Unreachable** while `woo` and `mock` stay Connected.
- Chat `What orders came in today?` still works.
- An `everything` tool fails fast with "server unreachable".

```bash
kubectl -n urumi-upstreams scale deploy/upstreams-everything-mcp --replicas=1
```
Connected again within about 10-20s.

## 10. Audit (A and B)
- A, **Audit → Refresh**: rows for A's chat calls (no key), B's key calls, the `denied` row, the
  `revoked_key` row and the unreachable `error` rows. There are no arguments or results anywhere.
- B, **Audit**: only B's rows.

## Optional extras
- **LLM fallback:** temporarily set `--set llm.baseUrl=https://opencode.ai/zen/go/v1-broken` on the
  gateway, ask chat a question, and show the `llm failover: ... -> fallback=qwen/qwen3.8-27b` line
  in `kubectl -n urumi-gateway logs deploy/gateway-gateway`. Then
  `helm upgrade ... --reset-values` to restore.
- **Lockout:** do it last. On kind every local browser shares one client IP (`172.18.0.1`), so it
  blocks all logins for 60s.

## After recording
- `claude mcp remove harbor`
- revoke B's recording key
- `unset T K`
