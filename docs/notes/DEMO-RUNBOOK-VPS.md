# Demo recording runbook on the VPS: Harbor (15 minutes)

Live system (`docs/notes/P5-vps.md`):
- dashboard: https://app.169-58-78-14.sslip.io
- store: https://shop.169-58-78-14.sslip.io
- provisioned stores: https://shop-<name>.169-58-78-14.sslip.io

Two places run commands:
- **VPS shell**: SSH to the VPS (`kubectl`, `helm`).
- **PC terminal**: Claude Code (or MCP Inspector) as user B.

Tool counts:
- base: 14 for an admin and 10 for a member; members don't get the writes or the mock
  failure-demo tools;
- each Ready store adds 5 tools (3 for a member).

Above 20 tools, the dashboard chat switches to tool search (`search_tools` + `call_tool`).

## 0. Before recording (about 20 min)

1. **VPS shell, health:**
   ```bash
   export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
   cd ~/kssproj/KubernetesBasedMCPGateway && git pull
   PROTO=https APP_HOST=app.169-58-78-14.sslip.io SHOP_HOST=shop.169-58-78-14.sslip.io bash scripts/smoke.sh
   kubectl get pods -A | grep urumi
   ```
   Expect `smoke: all checks passed`, and every pod Running, including 2 `gateway-gateway` pods and
   1 `gateway-provisioner`.
2. **wp-admin:** trash the test products and orders, and leave 3–5 real products.
3. **As A:**
   - Team & Keys: revoke old keys.
   - Chat: ask one DeepWiki question, to check the LLM works.
4. **Pre-make store `alpha`** (so the bonus segment doesn't wait 2 minutes on camera):
   - as A: Stores → name `alpha` → Create store; wait until **Ready** (about 2 min);
   - open `https://shop-alpha.169-58-78-14.sslip.io/shop`; create a product there if it is empty
     (A's chat: `Create a product called Alpha Lamp priced 20 in store alpha`);
   - buy it with Cash on delivery.
5. **Final state:**
   - B has no keys.
   - PC: `claude mcp list` shows no `harbor`.
   - Stores: only `alpha`.
   - Hosted servers: none.
6. **Windows, opened in this order:**
   1. A, normal browser: Servers tab. Extra tabs: wp-admin, the GitHub README,
      `charts/gateway/values-prod.yaml`, `docs/threat-model.md`, `apps/gateway/src/router.ts`.
   2. B, private window: Chat tab.
   3. Shopper, another private window: `https://shop.169-58-78-14.sslip.io/shop`.
   4. VPS shell: run `export KUBECONFIG=…`, `cd` into the repo, then `clear`.
   5. PC terminal: an empty folder.

   Then: zoom 110–125%, a large terminal font, notifications off.
7. **Never on screen:** passwords, a full API key, or any `secret … base64 -d` output.

### Paste list (keep it off camera)

```
SSRF test URL:      https://169-254-169-254.sslip.io/mcp
A chat:             Create a product called Demo Desk Lamp priced 33.25 in the main woo store
                    What orders came in today in the main woo store?
                    Convert 100 USD to EUR
                    Compare today's orders across the alpha and beta stores.
B chat:             Create a product called Hack Mug priced 1.00
Claude Code:        claude mcp add --transport http harbor https://app.169-58-78-14.sslip.io/mcp --header "Authorization: Bearer KEY"
                    Using the harbor tools: what orders came in today?
                    Using the harbor tools: get today's order total and convert it from USD to EUR.
                    Using the harbor tools: convert 50 USD to INR.
Hosted image:       slug demo, image ghcr.io/kss004/kubernetesbasedmcpgateway/utils-mcp:0.1.2, port 3000, path /mcp
VPS:
kubectl -n urumi-upstreams scale deploy/upstreams-utils-mcp --replicas=0
kubectl -n urumi-upstreams scale deploy/upstreams-utils-mcp --replicas=1
kubectl get ns | grep urumi; kubectl get pods -n urumi-gateway; kubectl get pods,pvc,ingress,resourcequota -n urumi-store-alpha
kubectl -n urumi-gateway describe deploy gateway-gateway | grep -E -A3 "Limits|Requests|Liveness|Readiness"
IP=$(kubectl -n urumi-store get svc store-woo-mcp -o jsonpath='{.spec.clusterIP}'); kubectl -n urumi-gateway exec gateway-postgres-0 -- timeout 5 bash -c "echo > /dev/tcp/$IP/3000" && echo OPEN || echo BLOCKED
kubectl get ns urumi-store-beta
helm history gateway -n urumi-gateway
```

## 1. The script (about 15 min after editing)

Record in one go and cut the waits (model replies, provisioning, health checks) afterwards.

| Time | Where | Do | Say |
|---|---|---|---|
| 0:00 | README diagram | Point at each box. | "A WooCommerce store with a team MCP gateway on Kubernetes. Admins register MCP servers once; each member gets one URL and a key; upstream credentials never leave the server." |
| 0:40 | Shopper | Point at the padlock. Type `http://shop…` and watch it switch to https. Add to cart, then Checkout with Cash on delivery. Then wp-admin → WooCommerce → Orders. | "Let's Encrypt via cert-manager; the order is in WooCommerce admin." |
| 1:30 | A → Servers | Point at the 4 servers Connected and each one's stats line (calls, error rate, p50/p95). Add server with the SSRF URL: refused. | "Health is probed every 5 seconds, and per-server metrics come from the audit log. An admin can't point the gateway at internal or metadata addresses: every address is checked at save and on every connection." |
| 2:20 | A → Chat | Create Demo Desk Lamp ("in the main woo store": with `alpha` there, say which store). Shopper: reload and buy it. Chat: orders today in the main woo store. A → Orders tab. | "The agent acts as me and the call is audited. The total comes from the tool, not the model." |
| 4:00 | A → Stores | Create `beta` and leave it provisioning. | "Each store gets its own namespace, database, volumes, certificate and quota. A separate provisioner does the Kubernetes work, so the internet-facing gateway has no Kubernetes rights." |
| 4:30 | B | No Servers tab. Chat: Hack Mug is refused. Team & Keys → Generate my key → Copy. | "Members can't write. That's enforced on the server, not just hidden." |
| 5:10 | PC terminal | `claude mcp add …`, then `claude`, then `/mcp` (the tools list). Ask the orders question, then the two-server question. | "One URL, one key: tools from every server, with nothing set up per server." |
| 6:40 | A → Servers | Disable `mock`. A chat: "Convert 100 USD to EUR" gets "no tool". Claude Code: the convert question is refused; `/mcp` → harbor → Reconnect: the mock tools are gone. Enable `mock`. | "Disabled tools vanish from chat at once, and from clients on their next listing. Every gateway pod hears about it through Postgres." |
| 7:40 | A → Team & Keys | Revoke B's key. Claude Code: the next question fails. A → Audit: the `revoked_key` and `denied` rows, plus everyone's calls. | "Revocation takes effect on the next call. Every call is audited: who, server, tool, time, duration, outcome." |
| 8:10 | VPS shell | Scale utils to 0. Servers: utils shows **Unreachable**, "connection refused (nothing listening) · for 12s", while the others stay Connected. Scale back to 1. | "A dead upstream doesn't affect the rest, and the dashboard says why it's down." |
| 9:00 | A → Stores | beta is now Ready. Open its shop link, add the product, Cash on delivery (create a product first in chat if empty: `Create a product called Beta Mug priced 7.50 in store beta`). A chat: "Compare today's orders across the alpha and beta stores": `search_tools` chips, then `store-alpha__list_orders` and `store-beta__list_orders`. | "With many tools the agent searches for the right ones instead of reading every schema. These two calls hit two different stores." |
| 10:20 | A → Stores, then VPS | Delete `beta`. Once it's gone: `kubectl get ns urumi-store-beta` → NotFound; Servers: no `store-beta`. | "Teardown removes the MCP registration first, then the namespace with its volumes and Secrets." |
| 11:00 | A → Servers | "Deploy a server from an image": the hosted image from the paste list. Ready in about 15 seconds, its tools appear. Remove it. | "Admins can also run a server from an image. It's locked down: no Kubernetes token, non-root, read-only filesystem, limits, and only the gateway can reach it." |
| 11:45 | VPS shell | The `kubectl get` line, then the `describe` line, then the NetworkPolicy check (prints **BLOCKED**). | "Namespaces per concern, two gateway replicas, probes, requests and limits. Only the shop and dashboard are public; everything else is behind default-deny policies." |
| 13:00 | `router.ts`, then the threat model | Don't scroll; talk over them. | "A call: the key is hashed and looked up, the role checked, the prefix routes it to the server, a fresh MCP client adds the upstream credential, and woo-mcp calls WooCommerce REST with OAuth 1.0a. A malicious server is limited: prefixed names, size caps, flagged description changes, plain-text rendering, no database access. The provisioner can only write inside store namespaces, which an admission policy enforces." |
| 14:15 | `values-prod.yaml`, then `helm history` | | "The same charts run locally on kind and here on k3s; only the values change. Every upgrade is a revision I can roll back. That's Harbor." |

## 2. If something breaks

| Problem | Fix |
|---|---|
| "Model is busy" | Wait 1–2 minutes and ask again. |
| DeepWiki Unreachable | A third-party outage. Say so; the rest keeps working. |
| A store stuck in Provisioning | Its row shows the step. After 10 min it fails with a reason. Delete it and use `alpha`. |
| Claude Code 401 | Re-paste the key: no `< >`, one space after `Bearer`. |
| Login says "too many attempts" | Wait 60 seconds. |

## 3. After recording

- PC: `claude mcp remove harbor`.
- A:
  - revoke B's key;
  - delete leftover stores (each holds about 0.5 GB of memory);
  - remove leftover hosted servers.
- Cut the waits; check that no password or full key is visible; note the timestamps for the form.

The kind runbook (`DEMO-RUNBOOK.md`) covers the core flow locally. Store provisioning and hosted
servers need the provisioner, which only the prod values turn on.
