// WooCommerce REST client over plain HTTP inside the cluster.
// Auth: OAuth 1.0a one-legged (HMAC-SHA256). Basic/query-string ck+cs only
// work over HTTPS (WC 11.2.1 class-wc-rest-authentication.php:212), and this
// traffic never leaves the cluster. Base URL for fetch is the WordPress
// Service DNS; the signature base uses the public home URL (what the server
// reconstructs via get_home_url); Host header satisfies WP's Host check.
// WC picks the signing scheme from is_ssl() (class-wc-rest-authentication.php:581),
// so with an https home URL we send X-Forwarded-Proto: https, which the
// official WordPress image's wp-config.php maps to HTTPS=on.
// node:http instead of fetch: fetch forbids setting the Host header.
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';

export interface WooConfig {
  serviceBase: string; // e.g. http://store-wordpress
  homeBase: string; // e.g. http://shop.localhost (signing base + Host)
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
}

const phpEncode = (s: string): string =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%7E/g, '~');

// WooCommerce double-encodes signed pairs: normalize_parameters() encodes
// keys/values, then join_with_equals_sign() encodes the joined "k=v" AGAIN.
// Values without special chars (e.g. dates) are unaffected, which is why this
// only bites on ISO datetimes. Replicates wc-rest-functions.php exactly.
const signedPair = (k: string, v: string): string => phpEncode(`${phpEncode(k)}=${phpEncode(v)}`);

export function signRequest(
  method: string,
  path: string,
  query: Record<string, string>,
  key: string,
  secret: string,
): string {
  const params: Record<string, string> = {
    ...query,
    oauth_consumer_key: key,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const sorted = Object.keys(params).sort(); // byte order, like uksort(strcmp)
  const paramString = sorted.map((k) => signedPair(k, params[k])).join('%26');
  const home = (process.env.WP_HOME_URL ?? 'http://shop.localhost').replace(/\/$/, '');
  const baseString = `${method.toUpperCase()}&${phpEncode(home + path)}&${paramString}`;
  const sig = createHmac('sha256', secret + '&')
    .update(baseString)
    .digest('base64');
  const signed = new URLSearchParams({ ...params, oauth_signature: sig });
  return `${path}?${signed.toString()}`;
}

export function wooRequest<T>(
  cfg: WooConfig,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  query: Record<string, string> = {},
  body?: unknown,
): Promise<T> {
  const signedPath = signRequest(method, path, query, cfg.consumerKey, cfg.consumerSecret);
  const url = new URL(signedPath, cfg.serviceBase);
  const home = new URL(cfg.homeBase);
  const host = home.host;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: {
          Host: host,
          Accept: 'application/json',
          ...(home.protocol === 'https:' ? { 'X-Forwarded-Proto': 'https' } : {}),
          ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            return reject(new Error(`woo: non-JSON response ${(res.statusCode ?? 0)}: ${text.slice(0, 200)}`));
          }
          if ((res.statusCode ?? 500) >= 300) {
            const msg =
              (json as { message?: string } | null)?.message ?? text.slice(0, 200);
            return reject(new Error(`woo: ${(res.statusCode ?? 0)} ${msg}`));
          }
          resolve(json as T);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(cfg.timeoutMs, () => req.destroy(new Error('woo: timeout')));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
