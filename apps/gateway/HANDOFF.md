# HANDOFF — human-written zones: T3.4 aggregator, T3.5 router (+T4.1 keys, T4.3 login)

Agents must NOT write these files — only discuss/review/explain (Agents.md §3).
The pool (`src/pool.ts`) and registry (`src/servers.ts`) are done and give you:

- `pool.getStates()` → `{id, slug, url, auth_type, header_name, enabled,
  has_secret, status}` with status Connected/Unreachable/Disabled.
- `pool.callTool(serverId, toolName, args, timeoutMs)` → upstream result.
  Typed errors: 404 unknown server, 503 disabled, 502 unreachable,
  504 `upstream timeout after Nms`. Retries once on dropped session (404).
  Secrets are decrypted in-memory only, never logged, never returned.
- `listServers/createServer/patchServer/deleteServer` for the registry.

## T3.4 `src/aggregator.ts` (you write)

- Cache tool lists per server so `tools/list` never waits on a dead upstream:
  refresh on pool tick or own timer; serve last-known for Unreachable.
- Names: `<slug>__<tool>`, slug `[a-z0-9-]`, whole name ≤64 chars.
- Defensive limits: tool-name length, ≤200 tools/server, description length cap.
- `sha256` each tool description; keep previous hash; expose `changed: true`
  per tool for the dashboard flag (~20 lines).
- API the router needs: `listAllTools(): PrefixedTool[]`,
  `resolve(prefixed): { serverId, tool } | null`.

## T3.5 `src/router.ts` (you write)

- Replace the 501 `/mcp` branch in `index.ts`: authenticate key → route.
- `initialize`/`notifications` handled by McpServer per request (stateless, D6);
  `tools/list` from aggregator cache; `tools/call` = prefix split → enabled +
  grants check → `pool.callTool` → 256 KB result cap with truncation marker.
- Malformed/unknown names, disabled servers, unreachable: typed JSON-RPC
  errors, never a hang. Denied attempts will feed audit (P4, D22).

## Order of work

1. T4.1 keys first (SHA-256, 32 random bytes, prefix shown, revoke flag;
   members self-service T4.1b), because the router needs `authenticate(key)`.
2. T3.4 aggregator, then T3.5 router + `/mcp` wiring.
3. Then say the word: T3.6 `make seed` (idempotent register-or-update woo),
   T3.7 Inspector + Claude Code compat, and the C2 two-server prompt.
