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
# grep, not node: works from a non-interactive shell without nvm on PATH (E2E L9).
UPS=$(curl -s "http://$APP/api/upstreams" -H "Authorization: Bearer $TOKEN" | grep -o '{[^{}]*}')
check "every enabled upstream is Connected" bash -c "[ \$(echo '$UPS' | grep -c '\"slug\"') -ge 3 ] && ! echo '$UPS' | grep '\"enabled\":true' | grep -vq '\"status\":\"Connected\"'"
# Must read a real 200 server list first, or a failed auth would pass this check (E2E L9).
SRV_CODE=$(curl -s -o /tmp/smoke-servers.$$ -w '%{http_code}' "http://$APP/api/servers" -H "Authorization: Bearer $TOKEN")
check "upstream credentials never returned" bash -c "[ '$SRV_CODE' = 200 ] && grep -q '\"slug\"' /tmp/smoke-servers.$$ && ! grep -qi '\"secret\"\\|enc_secret' /tmp/smoke-servers.$$"
rm -f /tmp/smoke-servers.$$
check "/mcp 401 sends WWW-Authenticate" bash -c "curl -s -o /dev/null -D - -X POST http://$APP/mcp -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -qi '^www-authenticate: bearer'"
check "security headers on / (CSP, frame, nosniff, referrer)" bash -c "H=\$(curl -s -o /dev/null -D - http://$APP/); for h in \"content-security-policy: default-src 'self'\" 'x-frame-options: deny' 'x-content-type-options: nosniff' 'referrer-policy: no-referrer'; do echo \"\$H\" | grep -qi \"^\$h\" || exit 1; done"
check "dashboard is served no-cache" bash -c "curl -s -o /dev/null -D - http://$APP/ | grep -qi '^cache-control: no-cache'"
check "storefront responds" test "$(code "http://$SHOP/")" = 200
unset TOKEN

echo "---"
[ "$fails" -eq 0 ] && echo "smoke: all checks passed" || echo "smoke: $fails check(s) failed"
exit "$fails"
