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

describe('orderDetail', () => {
  it('keeps totals, items and addresses; drops order_key and customer PII', async () => {
    const { orderDetail } = await import('../src/tools.ts');
    const raw = {
      id: 26, status: 'processing', total: '20.00', date_created: '2026-10-19T10:45:00',
      payment_method_title: 'Cash on delivery', currency: 'USD', shipping_total: '0.00', total_tax: '0.00',
      order_key: 'wc_order_secret', customer_ip_address: '10.0.0.1', customer_user_agent: 'x', cart_hash: 'h',
      billing: { first_name: 'A', last_name: 'V', address_1: '1 St', city: 'X', state: 'CA', postcode: '90001', country: 'US', email: 'a@b.c', phone: '555' },
      line_items: [{ name: 'Test Lamp', quantity: 1, total: '20.00', sku: 'z', meta_data: [] }],
      meta_data: [{ key: 'k', value: 'v' }],
    };
    const out = orderDetail(raw as never);
    const s = JSON.stringify(out);
    for (const bad of ['wc_order_secret', '10.0.0.1', 'a@b.c', '555', 'meta_data', 'cart_hash']) assert.ok(!s.includes(bad), bad);
    assert.deepEqual(out.items, [{ name: 'Test Lamp', quantity: 1, total: '20.00' }]);
    assert.equal(out.billing?.name, 'A V');
    assert.equal(out.total, '20.00');
  });
});

describe('orderSummary (paging + currency)', () => {
  const o = (id: number, total: string) => ({ id, status: 'processing', total, currency: 'USD', date_created: 'x' });
  const usd = { code: 'USD', symbol: '$' };
  it('totals every matching order, in cents, and returns only the requested page', async () => {
    const { orderSummary } = await import('../src/tools.ts');
    const all = [...Array.from({ length: 12 }, (_, i) => o(i + 1, '9.99')), o(13, '20.00'), o(14, '21.50')];
    const s = orderSummary(all, all.slice(5, 10), { page: 2, perPage: 5, totalOrders: 14, totalPages: 3 }, usd);
    assert.equal(s.count, 14);
    assert.equal(s.total, '161.38'); // 12 x 9.99 + 20.00 + 21.50, the true total
    assert.equal(s.complete, true);
    assert.equal(s.currency, 'USD');
    assert.deepEqual([s.page, s.per_page, s.total_pages], [2, 5, 3]);
    assert.deepEqual(s.orders.map((x) => x.id), [6, 7, 8, 9, 10]);
    assert.equal(s.orders[0].currency, 'USD');
  });
  it('flags an incomplete total when not every order was summed', async () => {
    const { orderSummary } = await import('../src/tools.ts');
    const s = orderSummary([o(1, '1.00')], [o(1, '1.00')], { page: 1, perPage: 1, totalOrders: 2000, totalPages: 2000 }, usd);
    assert.equal(s.complete, false);
    assert.equal(s.count, 2000);
  });
});
