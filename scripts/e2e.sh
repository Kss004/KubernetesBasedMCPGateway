#!/usr/bin/env bash
# End-to-end check: product via /mcp, storefront COD order via the Store API,
# order read back via /mcp. Creates a throwaway admin key and revokes it at the
# end; never prints secrets. Leaves the product and order as data (count check).
# Usage: APP_HOST=app.localhost SHOP_HOST=shop.localhost bash scripts/e2e.sh
set -uo pipefail
APP=${APP_HOST:-app.localhost}
SHOP=${SHOP_HOST:-shop.localhost}
PROTO=${PROTO:-http} # https on a TLS VPS (README section 7)
GW_NS=${GW_NS:-urumi-gateway}
GW_RELEASE=${GW_RELEASE:-gateway}
fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }

ADMIN=$(kubectl -n "$GW_NS" get secret "$GW_RELEASE-admin" -o jsonpath='{.data.token}' | base64 -d)
AH="Authorization: Bearer $ADMIN"

# Reuse one e2e admin user; mint a fresh key per run.
UID_=$(curl -s "$PROTO://$APP/api/users" -H "$AH" | json "(o.users.find(u=>u.name==='e2e-admin')||{}).id||''")
[ -z "$UID_" ] && UID_=$(curl -s -X POST "$PROTO://$APP/api/users" -H "$AH" -H 'Content-Type: application/json' \
  -d '{"name":"e2e-admin","role":"admin"}' | json "o.id")
KEYJSON=$(curl -s -X POST "$PROTO://$APP/api/keys" -H "$AH" -H 'Content-Type: application/json' -d "{\"user_id\":\"$UID_\"}")
KEY=$(echo "$KEYJSON" | json "o.key")
KEY_ID=$(echo "$KEYJSON" | json "o.id")
[ -n "$KEY" ] && [ -n "$KEY_ID" ] || { echo "FAIL could not mint an e2e key"; exit 1; }
# Revoke on any exit (Ctrl-C, hung curl), not only at the end.
trap 'curl -s -o /dev/null -X POST "$PROTO://$APP/api/keys/$KEY_ID/revoke" -H "$AH"' EXIT

# One MCP tools/call; prints the first text content (handles JSON or SSE replies).
mcp() {
  curl -s -X POST "$PROTO://$APP/mcp" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" |
    sed -n 's/^data: //p;/^{/p' | head -1 | json "o.result?.content?.[0]?.text ?? JSON.stringify(o.error ?? o)"
}

NAME="E2E Mug $(date +%s)"
PROD=$(mcp woo__create_product "{\"name\":\"$NAME\",\"price\":\"9.99\"}")
PID=$(echo "$PROD" | json "o.id" 2>/dev/null)
[[ "$PID" =~ ^[0-9]+$ ]] && pass "/mcp woo__create_product -> product $PID" || fail "/mcp woo__create_product: $PROD"

# Storefront checkout through the WooCommerce Store API (what the block checkout uses).
JAR=$(mktemp); HDR=$(mktemp)
curl -s -c "$JAR" -b "$JAR" -D "$HDR" -o /dev/null "$PROTO://$SHOP/wp-json/wc/store/v1/cart"
NONCE=$(grep -i '^nonce:' "$HDR" | tr -d '\r' | cut -d' ' -f2)
curl -s -c "$JAR" -b "$JAR" -o /dev/null -X POST "$PROTO://$SHOP/wp-json/wc/store/v1/cart/add-item" \
  -H "Nonce: $NONCE" -H 'Content-Type: application/json' -d "{\"id\":$PID,\"quantity\":1}"
ADDR='{"first_name":"E2E","last_name":"Buyer","address_1":"1 Test St","city":"San Jose","state":"CA","postcode":"95112","country":"US","email":"e2e@example.com","phone":"5550100"}'
ORDER=$(curl -s -c "$JAR" -b "$JAR" -X POST "$PROTO://$SHOP/wp-json/wc/store/v1/checkout" -H "Nonce: $NONCE" \
  -H 'Content-Type: application/json' -d "{\"billing_address\":$ADDR,\"shipping_address\":$ADDR,\"payment_method\":\"cod\"}")
rm -f "$JAR" "$HDR"
OID=$(echo "$ORDER" | json "o.order_id ?? ''" 2>/dev/null)
[[ "$OID" =~ ^[0-9]+$ ]] && pass "storefront COD checkout -> order $OID" || fail "storefront checkout: $(echo "$ORDER" | head -c 300)"

GOT=$(mcp woo__get_order "{\"id\":${OID:-0}}")
echo "$GOT" | grep -q "$NAME" && pass "/mcp woo__get_order $OID shows the product" || fail "/mcp woo__get_order: $(echo "$GOT" | head -c 300)"

REV=$(curl -s -X POST "$PROTO://$APP/api/keys/$KEY_ID/revoke" -H "$AH" | json "o.revoked")
[ "$REV" = true ] && { pass "e2e key revoked"; trap - EXIT; } || fail "e2e key revoke"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PROTO://$APP/mcp" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[ "$CODE" = 401 ] && pass "revoked key gets 401" || fail "revoked key got $CODE"
unset ADMIN KEY AH

echo "---"
[ "$fails" -eq 0 ] && echo "e2e: all checks passed" || echo "e2e: $fails check(s) failed"
exit "$fails"
