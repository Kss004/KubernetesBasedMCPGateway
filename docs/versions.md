# versions.md — pinned versions with evidence (T0.4)

> Rule: every pin below shows the command that produced it. Nothing from memory.
> Re-check on upgrade day; `latest` floats are not pins.

## Node / TS (T0.3, resolved 2026-10-09)

| Package | Pinned | Evidence |
|---|---|---|
| node | v24.21.0 (local) | `node -v` → `v24.21.0` |
| typescript | 5.9.3 | `npm ls typescript` → `typescript@5.9.3` |
| tsx | 4.23.15 | `npm ls tsx` → `tsx@4.23.15` |
| @types/node | 24.19.2 | `npm ls @types/node` → `@types/node@24.19.2` |

## MCP SDK — stable 1.x line (D1, D5)

| Package | Pinned | Evidence |
|---|---|---|
| @modelcontextprotocol/sdk | 1.32.1 (`latest` tag) | `npm view @modelcontextprotocol/sdk dist-tags --json` → `{"latest": "1.32.1"}` |
| spec revision spoken | **2025-11-25** via legacy `initialize` | SDK `types.js` (`LATEST_PROTOCOL_VERSION = '2025-11-25'`); **2026-07-28 is v2-only** (`@modelcontextprotocol/server` / `client` 2.3.1) and is NOT pinned here |
| zod | 4.6.5 | `npm view zod version` → `4.6.5`. Compatible: `npm view @modelcontextprotocol/sdk@1.32.1 peerDependencies` → `"zod": "^3.25 \|\| ^4.0"` — 4.6.5 satisfies `^4.0` |
| pg | 8.23.1 | `npm view pg version` → `8.23.1` |

Why 1.x: reference TS implementation, one protocol line for gateway + upstreams, no v2 migration risk inside a 2-week deadline.

## Kubernetes tooling (local, 2026-10-09)

| Tool | Pinned | Evidence |
|---|---|---|
| kind | v0.33.0 | `kind version` → `kind v0.33.0 go1.26.7 linux/amd64` |
| kind node image | `kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5` | `strings $(which kind) \| grep kindest/node` → same digest (kind v0.33.0 default, K8s 1.37.0) |
| kubectl (client) | v1.36.1 | `kubectl version --client` → `Client Version: v1.36.1` |
| helm | v4.3.0 | `helm version` → `version.BuildInfo{Version:"v4.3.0", ...}` |
| ingress-nginx chart | 4.15.1 (controller v1.15.1) | `curl .../ingress-nginx/main/charts/ingress-nginx/Chart.yaml` → `version: 4.15.1, appVersion: 1.15.1` |

Decision: ingress-nginx upstream repo is **archived (read-only since Mar 2026)**. Still fine for a 2-week project; recorded here and in the threat model. Stay unless T1.2 fights; switching to Traefik costs T1.2 + gotcha-list rework.

## Store images (exact tags; digests only for kind node per decision)

| Image | Pinned | Evidence |
|---|---|---|
| wordpress | `7.1.3-apache` | Hub API `.../library/wordpress/tags/7.1.3-apache` → `last_updated: 2026-10-08` |
| wordpress WP-CLI | `wordpress:cli-2.12.0` (tag on same repo; no separate `wordpress:cli` repo) | Hub API → `last_updated: 2026-09-30` |
| mariadb | `11.8` | Hub API `.../library/mariadb/tags/11.8` → `last_updated: 2026-10-02` |
| WooCommerce plugin | **11.2.1** (install exact zip in bootstrap Job, never `latest`) | WP.org API `plugins/info/1.2/?action=plugin_information&slug=woocommerce` → `version: 11.2.1, requires: 7.0, tested: 7.1.3` — matches WP 7.1.3 |

## Calico

Not pinned. Only needed if T1.1 shows kindnet policies are not enforced — the T1.1 test result is the authority, not a version note.
