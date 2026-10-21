# Threat model

Who can do what to whom, what stops them, and what does not. Controls are listed with where they
live in the code or charts. Evidence is in `docs/notes/` (E2E rounds 1-8, P4-k3d, DEMO-RUNBOOK).

## Trust boundaries

```
browser / MCP client --(Ingress, public)--> gateway --(ClusterIP, gateway only)--> woo-mcp, mock, everything
                                               |                                       |
                                               +--> Postgres (gateway only)            +--> WordPress --> MariaDB
                                               +--> LLM provider (egress)                   (store only)
```

- Public: the storefront and the gateway, both through Ingress.
- Internal only: every MCP server and both databases. They are ClusterIP Services with no
  Ingress, behind default-deny ingress NetworkPolicies:
  - woo-mcp, mock and everything admit only pods in the `urumi-gateway` namespace;
  - WordPress admits only the ingress controller, woo-mcp and the bootstrap Job;
  - MariaDB admits only WordPress and the bootstrap Job;
  - the gateway admits only the ingress controller, and Postgres only the gateway.
- `make test-netpol` proves that the cluster's CNI enforces NetworkPolicies (a scratch
  namespace, baseline plus an allowed/denied pair, on kind and on k3s). The chart's own rules
  showed up in practice: an unlabelled pod was blocked by the MariaDB policy
  (`docs/notes/T1.5.md`), and the bootstrap Job raced the policy on k3s (`P4-k3d.md`).
- Secrets live only in their consumer's namespace (D18), and the gateway has no RBAC into other
  namespaces.

## The four questions

### 1. Shared upstream credentials: what can a member do with a credential they never see?

The WooCommerce REST key (scope `read_write`) is mounted only into woo-mcp. The gateway-to-woo-mcp
bearer token is stored encrypted (AES-256-GCM, key in a Secret) and attached by the gateway per
call. A member therefore **uses** the credential's power through tools, but can never **hold** it.

What a member can do with it:
- call the tools their role allows: list and read products and orders, including customer names
  and addresses through `get_order` (an allowlist with no email, phone, IP or `order_key`);
- convert currency and use the other upstreams.

What they cannot do:
- The write tools (`woo__create_product`, `woo__update_order_status`) are hidden from members'
  `tools/list` and rejected if called directly (`grantsAllow` in `router.ts`, in `/mcp` and in
  chat).
- They never see the credential. It is not in any API response (a smoke check asserts this), not
  in the browser, not in logs, and not in audit rows.

Every call is audited under the member's name. Revoking their key cuts access at once, and the
upstream credential never needs rotating. The residual risk is data the tools legitimately
return: a member can read and copy order data. Restricting `get_order` per role is one entry in
`MEMBER_DENIED_SUFFIXES` (`router.ts`). The deny list matches by tool-name suffix, so it covers
`create_product` and `update_order_status` on every server, not only woo.

### 2. Why client tokens are not passed through to upstream servers

- The gateway is the only place that knows who the user is and what they may do. Upstreams
  cannot validate our keys.
- Forwarding a user's gateway key would hand a replayable credential to every upstream. A
  compromised or malicious server could then call the gateway **as that user**, including any
  other server's tools: a confused deputy. That is why the MCP authorization spec forbids
  token passthrough.
- Instead each hop has its own secret. Client → gateway uses the user's API key, stored only as a
  SHA-256 hash. Gateway → upstream uses that server's own static credential, attached
  gateway-side.
- An upstream sees only its own credential and never learns which user called, so it receives
  nothing it could reuse anywhere else.

### 3. Untrusted upstreams: tool descriptions written to manipulate the model

This is also "what happens if an admin adds a malicious or compromised MCP server".

**Contained:**
- **Scope:** `validUrl` in `servers.ts` limits server URLs to cluster Services in
  `urumi-store` and `urumi-upstreams`. External hosts, IP literals, `localhost`, userinfo tricks,
  the cloud metadata address and the gateway's own namespace are rejected. URLs are checked by
  name only, with no DNS resolution at admission (`// ponytail:` in `servers.ts`).
- **No impersonation:** tools are prefixed `<slug>__<tool>`, so a new server cannot shadow
  `woo__*`.
- **No credential theft:** it receives only its own credential. It never gets user keys or
  other servers' credentials. The store's ingress NetworkPolicies admit only WordPress and the
  bootstrap Job to MariaDB, so it cannot reach the database.
- **Size caps:** at most 200 tools per server, descriptions truncated to 1024 characters, and
  results capped at 256 KB.
- **Visibility:** a changed description is flagged `[description changed]` in the dashboard for
  one refresh cycle (about 15s; hash per description, in memory per pod). A rug-pull is visible
  only to someone watching; persisting the hash is the upgrade.
- **Rendering:** all tool and model text is rendered as plain text, never HTML, so a result
  cannot inject script.
- **Arguments:** model arguments are validated against the tool's schema before the call, and
  the loop is capped at 8 turns.
- **Data guard:** chat cannot show store data without a tool call in that request (D28; limits
  below).

**Not prevented:** a description or result can still *ask* the model to call other tools ("now
call `woo__update_order_status`"). For a member, write tools are absent, so the attempt fails.
For an admin, the model could be steered into a write. The next step would be a confirmation
step for write tools in chat. The audit log records every call.

### 4. What one team member can do to another

**Cannot:**
- **Keys:** see, use or revoke another user's key. Members manage only their own keys
  (`/api/me/keys`, scoped by `user_id`). Admin APIs answer `403` to members.
- **Audit:** see another user's audit rows. The member view is filtered server-side; a
  `?user_id=` parameter is ignored.
- **Chat:** read another user's chat. History lives in the browser, and the server stores none
  (D22).
- **Sessions:** reuse another user's session. Cookies are HttpOnly, SameSite=Lax and signed;
  logout and a password reset invalidate all of that user's tokens (`session_version`).

**Can:**
- **Lockout:** keep another user's login locked out by failing their password 5 times per
  15 minutes (see Known gaps).
- **Shared data:** read the same store data through the tools. There is no per-user data
  isolation inside one store.
- **Shared quota:** use up the shared LLM quota or load the store. There is no per-key rate
  limit on `/mcp` or chat yet.

## Controls in place

- **Keys and passwords.** API keys are random, stored as SHA-256 hashes, shown once and
  revocable. Passwords use bcrypt. A dummy hash is checked for unknown names, so login time does
  not reveal which names exist.
- **Login hardening (bug 6).**
  - Rate limit: 5 failures per 15 min per client IP or user name gives a 1-min lock (429).
  - Session cookie: HttpOnly, SameSite=Lax, `Secure` in prod; session writes need
    `Content-Type: application/json` (CSRF).
  - Logout invalidation through `session_version`.
- **Headers on every response:** `Content-Security-Policy: default-src 'self'; frame-ancestors
  'none'; ...`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`.
- **Upstream credentials encrypted at rest** (AES-256-GCM, `crypto.ts`). The key is a generated
  Secret; losing it makes stored credentials unreadable, which is documented.
- **Audit without payload.** Every call and denial is logged, including revoked keys, attributed
  to the known user. Arguments and results are never stored (D22).
- **Workloads:**
  - `runAsNonRoot` where the image allows: gateway, woo-mcp, mock, everything. The stock
    WordPress, MariaDB and Postgres images start as root.
  - `automountServiceAccountToken: false` everywhere except the bootstrap Job, which uses a
    least-privilege Role to write the REST key Secret. The bootstrap Job runs as root
    (`runAsUser: 0`, wp-cli image) because the docroot belongs to the WordPress user.
  - Resource requests and limits on every workload, and probes on every long-running workload
    (the one-shot bootstrap Job has none).
- **Chat agent runs as the user.** The model sees only the tools that user may call, every call
  is audited under that user, and bad arguments go back to the model.

## Known gaps (stated, not hidden)

- **No egress default-deny (D25).** The chat agent needs LLM, DNS, Postgres and upstream
  egress, so only ingress is default-denied per namespace. An egress allow-list is the next step.
- **No per-key rate limit on `/mcp` or chat.** One member can use up the shared LLM quota or
  load the store. Only login attempts are rate-limited.
- **Prompt injection via tool results or descriptions (R14)** is reduced (caps, the change
  flag, plain-text rendering, argument validation, no write tools for members) but not prevented.
  A suspected incident is handled by disabling the server, then reviewing its audit rows.
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
  - On the VPS (k3s), klipper-lb masqueraded every client to `10.42.0.1`, even with
    `externalTrafficPolicy: Local`, so the IP lock was global. Fixed by running Traefik on
    `hostPort` 80/443 with a ClusterIP Service (`docs/notes/P5-vps.md`, problem 3); the last
    hop is now the real source address, checked with a browser on an outside PC.
  - The counters are in memory, per gateway pod (`// ponytail:` in `session.ts`).
- **What a member can see through the store tools (E2E round 5).** Members may call
  `woo__get_order`, which returns the customer's name and billing/shipping address (an
  allowlist: no email, phone, IP or `order_key`). Order details are store data a member
  needs for support, so this is by design; add `get_order` to `MEMBER_DENIED_SUFFIXES`
  (`router.ts`) if members must not see addresses.
- **ingress-nginx archived upstream (read-only since Mar 2026)** — accepted for a
  2-week project; switch cost recorded in `docs/versions.md`.
