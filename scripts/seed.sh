#!/usr/bin/env bash
# T3.6 make seed: register woo-mcp through the gateway admin API.
# Reads the woo-mcp token with kubectl from this machine (the gateway never
# gets RBAC into other namespaces). Idempotent: creates or updates the row.
# The worker runs inside the gateway pod via kubectl exec (node is in the
# image; busybox wget cannot PATCH), so no port-forward is needed.
set -euo pipefail
GW_NS="${GW_NS:-urumi-gateway}"
STORE_RELEASE="${STORE_RELEASE:-store}"
GW_RELEASE="${GW_RELEASE:-gateway}"

ADMIN=$(kubectl -n "$GW_NS" get secret "$GW_RELEASE-admin" -o jsonpath='{.data.token}' | base64 -d)
TOKEN=$(kubectl -n urumi-store get secret "$STORE_RELEASE-woo-inbound" -o jsonpath='{.data.token}' | base64 -d)
kubectl -n "$GW_NS" exec "deploy/$GW_RELEASE-gateway" -- env "ADMIN=$ADMIN" "TOKEN=$TOKEN" \
  "WOO_URL=http://store-woo-mcp.urumi-store:3000/mcp" \
  node -e "$(<scripts/seed.mjs)"
