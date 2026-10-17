#!/usr/bin/env bash
# Live smoke check against the running cluster: run after every deploy.
# Prints one PASS/FAIL line per check, exits non-zero if any check fails.
# Reads the admin token from the cluster; never prints it.
set -uo pipefail
APP=${APP_HOST:-app.localhost}
SHOP=${SHOP_HOST:-shop.localhost}
GW_NS=${GW_NS:-urumi-gateway}
GW_RELEASE=${GW_RELEASE:-gateway}
fails=0
check() { # name, command...
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then echo "PASS $name"; else echo "FAIL $name"; fails=$((fails + 1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

TOKEN=$(kubectl -n "$GW_NS" get secret "$GW_RELEASE-admin" -o jsonpath='{.data.token}' | base64 -d)

check "dashboard / is the React shell" bash -c "curl -s http://$APP/ | grep -q 'id=\"root\"'"
check "dashboard /app.js served as JS" bash -c "[[ \$(curl -s -o /dev/null -w '%{content_type}' http://$APP/app.js) == application/javascript* ]]"
check "dashboard /style.css served as CSS" bash -c "[[ \$(curl -s -o /dev/null -w '%{content_type}' http://$APP/style.css) == text/css* ]]"
check "/api/me without session is 401" test "$(code "http://$APP/api/me")" = 401
check "/mcp without key is 401" test "$(code -X POST "http://$APP/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')" = 401
check "/mcp with bad key is 401" test "$(code -X POST "http://$APP/mcp" -H 'Authorization: Bearer nope' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')" = 401
check "admin API rejects missing auth" test "$(code "http://$APP/api/servers")" = 401
check "every enabled upstream is Connected" bash -c "curl -s http://$APP/api/upstreams -H 'Authorization: Bearer $TOKEN' |
  node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const u=JSON.parse(s).upstreams;process.exit(u.length>=3&&u.every(x=>!x.enabled||x.status===\"Connected\")?0:1)})'"
check "upstream credentials never returned" bash -c "! curl -s http://$APP/api/servers -H 'Authorization: Bearer $TOKEN' | grep -qi '\"secret\"\\|enc_secret'"
check "storefront responds" test "$(code "http://$SHOP/")" = 200
unset TOKEN

echo "---"
[ "$fails" -eq 0 ] && echo "smoke: all checks passed" || echo "smoke: $fails check(s) failed"
exit "$fails"
