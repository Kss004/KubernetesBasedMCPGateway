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
- **ingress-nginx archived upstream (read-only since Mar 2026)** — accepted for a
  2-week project; switch cost recorded in `docs/versions.md`.
