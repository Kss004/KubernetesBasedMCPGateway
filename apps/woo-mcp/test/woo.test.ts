// Pins the OAuth1 signature WooCommerce 11.2.1 accepts, including its
// double-encoding of signed pairs (ISO datetimes break without it).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signRequest } from '../src/woo.ts';

describe('signRequest', () => {
  it('signs over double-encoded pairs with the public home URL', () => {
    process.env.WP_HOME_URL = 'http://shop.localhost';
    const out = signRequest('GET', '/wp-json/wc/v3/orders', { after: '2026-10-17T00:00:00' }, 'ck_x', 'cs_y');
    const q = new URL(out, 'http://x').searchParams;
    const nonce = q.get('oauth_nonce')!;
    const ts = q.get('oauth_timestamp')!;
    // Hand-written expected base string: ':' -> %3A, then the joined "k=v" encoded again (%253A, %3D).
    const base =
      'GET&http%3A%2F%2Fshop.localhost%2Fwp-json%2Fwc%2Fv3%2Forders&' +
      [
        'after%3D2026-10-17T00%253A00%253A00',
        'oauth_consumer_key%3Dck_x',
        `oauth_nonce%3D${nonce}`,
        'oauth_signature_method%3DHMAC-SHA256',
        `oauth_timestamp%3D${ts}`,
      ].join('%26');
    const want = createHmac('sha256', 'cs_y&').update(base).digest('base64');
    assert.equal(q.get('oauth_signature'), want);
    assert.equal(q.get('after'), '2026-10-17T00:00:00'); // query value itself sent once-encoded
  });
});
