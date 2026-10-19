# Threat model (draft, P9 T9.3 — from progrestillnow.md D22/D25/R14)

## Trust boundaries

Client (browser/MCP client) → ingress → gateway → upstreams (woo-mcp, mock,
everything) → store (WP/Woo/MariaDB). Secrets live only in the consumer's
namespace; gateway has no RBAC into other namespaces (Secrets map, §4).

## Controls in place

- **Upstream credentials never reach clients.** Attached gateway-side per call
  (`requestInit.headers.Authorization`); client bearer keys are SHA-256 stored,
  never forwarded upstream (D26, T3.5/T4.1).
- **A credential a member never sees.** WC REST key is mounted only into woo-mcp
  (`urumi-store`); members get prefixed tool access, never the key (D18).
- **Audit without payload.** Every `tools/call` + denial logged (user, server,
  tool, time, duration, outcome, error class); no args/results stored — they may
  hold customer data/secrets (D22). Revoked-key attempts attributed to the known user.
- **Untrusted-upstream caps.** Tool-name length, ≤200 tools/server, description
  length, 256 KB result cap with truncation marker; description-hash change flag
  surfaced in dashboard (T3.4/T3.5) — defence vs a compromised upstream rewriting
  descriptions to steer the model.
- **Render as plain text / escaped markdown, never raw HTML** (dashboard + chat)
  — malicious tool results (e.g. order notes) can't inject script (R14, T5).
- **Zod-validate model args, turn-capped loop** — bad args returned to the model for retry (R7, T6.2). TODO(verify): chat loop not built yet.
- **Roles server-side, not UI-only.** Admin/member enforced on every admin route;
  members self-serve only their own keys; T11.1 hides + rejects write tools for
  members (D23, T4.1b/T4.2).
- **No service-account tokens** (`automountServiceAccountToken: false`) where pods
  never call the K8s API; session cookies signed + SameSite + JSON-only CSRF (T4.3).
- **SSRF guard design (T11.2, stretch):** always block loopback/link-local incl.
  `169.254.169.254`; allow-list cluster Service names in known namespaces only.

## Known gaps (stated, not hidden)

- **No egress default-deny (D25).** Chat agent needs LLM egress; ingress-only
  default-deny per namespace. Egress allow-list is T11.2 stretch.
- **Prompt injection via tool results/descriptions (R14)** is mitigated (caps,
  change flag, plain-text render, arg validation) but not eliminated — document
  per-incident handling, not prevention claims.
- **Member-vs-member:** members see only their own audit rows (D22); no
  per-tool grants yet (T11.1 stretch) — today a member can call any enabled tool.
- **Chat can still state wrong store data in some cases (D28).** The gateway guard
  (`driveLoop` in `apps/gateway/src/chat.ts`) blocks a reply that shows order numbers or
  money when no tool ran for the question. Its limits:
  - It is skipped once any tool ran in the request. A reply after `get_order` that
    invents other orders is not caught.
  - It only matches `#N`, `$`/`€`/`£` amounts and `N.NN`. Plain integers ("3 orders",
    "Order 39", "USD 25") pass.
  - A legitimate repeat of earlier data, with no new tool call, can get the nudge and
    then the "couldn't look that up" fallback.
  The audit log stays the source of truth: every real tool call has a row.
- **Login lockout can be used against a user (bug 6, E2E N6).** The limiter locks a user
  name after 5 failures in 15 min, so anyone who knows a name can keep that account locked
  out, one minute at a time. A successful login clears only the name key, not the IP key.
  - The IP key is the last `X-Forwarded-For` hop. On kind every local client arrives as
    `172.18.0.1`, so one lockout blocks all local logins for 1 min.
  - Unverified for prod: on k3s with Traefik behind klipper-lb, the last hop may be a node
    or load-balancer address (source NAT) unless the Traefik Service uses
    `externalTrafficPolicy: Local` or Traefik is set to trust forwarded headers. Then the IP
    lock is effectively global in prod too. Check it on the target before relying on it.
  - The counters are in memory, per gateway pod (`// ponytail:` in `session.ts`).
- **ingress-nginx archived upstream (read-only since Mar 2026)** — accepted for a
  2-week project; switch cost recorded in `docs/versions.md`.
