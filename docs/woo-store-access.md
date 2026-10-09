# woo-mcp store access: REST, and why (T2.5)

woo-mcp talks to WordPress over the WooCommerce REST API (`/wp-json/wc/v3`),
not WP-CLI and not direct SQL.

Why REST: it is the documented public contract, needs no exec into the
WordPress pod, works from a separate Deployment, and needs only the key pair
already in the `store-woo-rest` Secret. WP-CLI would require sharing the
docroot PVC plus a database client in the image; SQL would bypass all
WooCommerce business logic (totals, stock, status transitions).

Transport facts that constrain the client (all read from WC 11.2.1 source,
`includes/class-wc-rest-authentication.php`, not from memory):

- Basic auth and bare query-string keys work **only over HTTPS**
  (`authenticate()`, line 212: `if (is_ssl())`). Our in-cluster traffic is
  plain HTTP, so both return 401 here — verified, not assumed.
- Over HTTP, WooCommerce requires **OAuth 1.0a one-legged** (HMAC-SHA256,
  key `consumer_secret&`, params in the query string).
- Quirk that cost a debugging session: `normalize_parameters()` encodes
  keys/values and `join_with_equals_sign()` encodes the joined `k=v` **again**.
  Values without special chars are unaffected by the second pass, so
  `list_products` worked while `list_orders(after=<ISO datetime>)` failed
  with "Invalid signature". `apps/woo-mcp/src/woo.ts:signedPair` replicates
  the double encoding exactly.
- Base URL for fetch is the Service DNS (`http://store-wordpress`,
  same namespace); the signature base and the `Host` header use the public
  home URL (`http://shop.localhost`), which is what the server reconstructs
  via `get_home_url()`. (`fetch` cannot set `Host` — forbidden header —
  so the client uses `node:http`.)
