# Demo recording runbook on the VPS (DoD walkthrough)

The same script as `DEMO-RUNBOOK.md` (kind), adapted for the live VPS deploy
(`docs/notes/P5-vps.md`):
- dashboard: https://app.169-58-78-14.sslip.io
- store: https://shop.169-58-78-14.sslip.io

Two places run commands:
- **VPS shell**: SSH to the VPS for `kubectl` (`root@vmi3684285`).
- **PC terminal**: your own machine, for MCP Inspector, Claude Code and `curl`. sslip.io names
  resolve publicly, so no hosts-file line is needed.

Tool counts below (11 for admin, 9 for a member) come from the kind dry-run on gateway 0.4.14;
the VPS runs the same gateway build.

## 0. Before recording (about 10 min)

1. VPS shell: point kubectl at the cluster and check everything is up.
   ```bash
   export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
   cd ~/kssproj/KubernetesBasedMCPGateway
   PROTO=https APP_HOST=app.169-58-78-14.sslip.io SHOP_HOST=shop.169-58-78-14.sslip.io bash scripts/smoke.sh
   kubectl get pods -A
   ```
   Expect `smoke: all checks passed` (13) and every pod Running.
2. Clean slate:
   - Users A (admin) and B (member) exist and have passwords. B has no keys yet.
   - The store holds test data from the e2e runs: products named `E2E Mug ...` and their COD
     orders, all from 2026-10-21. "Orders today" in step 4 counts them if you record on that
     date. Either say so on camera, or move the `E2E Mug` products and orders to the trash in
     wp-admin first.
   - On your PC, remove any old `urumi` entry from `~/.mcp-inspector/mcp.json` and from
     `claude mcp list`.
3. Chat model: DeepSeek v4.1 flash (OpenCode Go), with automatic Groq fallback. If chat says "the
   model is busy", wait about 2 minutes.
4. Windows to open:
   - A: a normal browser window at the dashboard;
   - B: a private window at the dashboard;
   - shopper: a second private window at the store;
   - a VPS shell for `kubectl`;
   - a PC terminal for Inspector or Claude Code.
5. VPS shell: load the admin token for terminal checks. It stays in the shell and is never
   printed:
   ```bash
   T=$(kubectl -n urumi-gateway get secret gateway-admin -o jsonpath='{.data.token}' | base64 -d)
   ```
6. Optional on camera: the padlock. Both sites use Let's Encrypt certificates issued by
   cert-manager, which renews them in-cluster.

## 1. The store works (shopper)
Shopper window: https://shop.169-58-78-14.sslip.io/shop. Add any product, then check out with
Cash on delivery and a US test address. Expect "Order received". Note the number.

## 2. Admin sees the gateway (A)
Log in as A, which opens the **Servers** tab. Show:
- `woo`, `mock` and `everything` all **Connected**, 11 tools in total;
- auth shows only "secret set" (no secret values).

## 3. Chat writes to the store (A, chat agent)
**Chat**: `Create a product called Demo Desk Lamp priced 33.25`. Expect a `woo create_product ✓`
chip. Then:
1. Shopper window: reload `/shop`. **Demo Desk Lamp** shows at $33.25. Buy it with COD.
2. WooCommerce admin screen: in a new tab, open https://shop.169-58-78-14.sslip.io/wp-admin and
   log in as `admin`. The password comes from the VPS shell:
   ```bash
   kubectl -n urumi-store get secret store-wp-admin -o jsonpath='{.data.password}' | base64 -d; echo
   ```
   Go to **WooCommerce → Orders**: the new order shows with status **Processing**.

## 4. Chat reads the store, across two servers (A)
Leave about a minute between prompts.
1. `What orders came in today?`: a `list_orders ✓` chip, then the count and total. The total
   comes from the tool (`list_orders` returns `count`/`total`); the model never adds it up itself.
   "Today" is UTC.
2. `Get today's order total and convert it from USD to EUR.`: `woo list_orders ✓` then
   `mock convert_currency ✓`.

## 5. A member with a real MCP client (B)
Log in as B in the private window. B lands on **Chat**, with no Servers tab.
**Team & Keys → Generate my key**, then **Copy** (it is shown once).

### 5a. MCP Inspector (PC terminal)
```bash
MCP_INSPECTOR_SECRET_STORE=memory npx -y @modelcontextprotocol/inspector@2.11.0
```
`MCP_INSPECTOR_SECRET_STORE=memory` keeps the key out of files on disk.

In the Inspector tab that opens, connect with:
- transport **Streamable HTTP**
- URL `https://app.169-58-78-14.sslip.io/mcp`
- header `Authorization: Bearer <B key>`

Then:
- **List tools**: 9 tools, prefixed `woo__`, `mock__`, `everything__`. There is **no**
  `woo__create_product` and **no** `woo__update_order_status` (member role).
- Call `woo__list_orders` with `after` = `<today>T00:00:00` and `before` = `<today>T23:59:59`.
  It returns `count`, `total` and the orders.
- Call `mock__convert_currency` (amount = that total, from USD, to EUR). Two servers, one client,
  one key.

The same calls from the CLI, if the UI misbehaves:
```bash
K='<B key>'; I="npx -y @modelcontextprotocol/inspector@2.11.0 --cli https://app.169-58-78-14.sslip.io/mcp --transport http --header"
MCP_INSPECTOR_SECRET_STORE=memory $I "Authorization: Bearer $K" --method tools/list
MCP_INSPECTOR_SECRET_STORE=memory $I "Authorization: Bearer $K" --method tools/call --tool-name woo__list_orders --tool-arg after=$(date -u +%F)T00:00:00 before=$(date -u +%F)T23:59:59
```

### 5b. Claude Code (PC terminal)
In an empty folder:
```bash
claude mcp add --transport http urumi https://app.169-58-78-14.sslip.io/mcp --header "Authorization: Bearer <B key>"
claude mcp list            # urumi: ... (HTTP) - Connected
claude                     # then ask:
```
- `Using the urumi MCP tools: what orders came in today (UTC)? Give the count and total.`
- `Using the urumi MCP tools: get today's order total, then convert it from USD to EUR.`

Approve the urumi tool calls when Claude Code asks.

## 6. Permissions are enforced server-side (B)
- B **Chat**: `Create a product called Hack Mug priced 1.00`. Expect a one-sentence refusal and
  no tool call. Nothing appears in the store.
- Optional, PC terminal: a direct `tools/call woo__create_product` with B's key gets
  `-32000 forbidden for role` and an audit row `denied`.

## 7. Revoke a key (A)
A, **Team & Keys → All keys**: revoke B's key (confirm the dialog). The next Inspector or Claude Code
call fails. In the PC terminal (where `K` holds B's key) it prints `401`:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://app.169-58-78-14.sslip.io/mcp -H "Authorization: Bearer $K" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 8. Disable and re-enable a server (A)
**Servers → Disable** `mock`: it shows Disabled at once and its tools are gone. Chat
`Convert 100 USD to EUR.` gets one plain sentence, "no tool for that", with no tool call.
**Enable**: Connected again with 11 tools.

## 9. A dead server (failure demo, VPS shell)
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
- **LLM fallback (VPS shell).** Break the primary URL, ask chat a question, show the failover
  line, then restore. On prod, every upgrade must repeat the values file and all `--set` flags.
  Do **not** use `--reset-values` here: it would drop the hosts and TLS settings.
  ```bash
  GW="helm upgrade gateway ./charts/gateway -n urumi-gateway -f charts/gateway/values-prod.yaml --set appHost=app.169-58-78-14.sslip.io --set ingress.tlsSecretName=app-tls --wait --timeout 5m"
  $GW --set llm.baseUrl=https://opencode.ai/zen/go/v1-broken
  # chat a question, then:
  kubectl -n urumi-gateway logs deploy/gateway-gateway | grep 'llm failover'
  $GW                                   # restore
  helm get values gateway -n urumi-gateway   # no llm.baseUrl override left
  ```
- **Lockout.** On the VPS each client keeps its real IP (`P5-vps.md`, problem 3). Five wrong
  passwords for B lock B's name and your IP for 60s, but A can still log in from another network
  (a phone on mobile data, say). On kind every browser shared one IP. Do it last anyway.

## After recording
- PC: `claude mcp remove urumi`
- A: revoke B's recording key
- VPS shell and PC: `unset T K`
