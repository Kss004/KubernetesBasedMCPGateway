import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ordersArgs } from '../src/orders.js';

describe('ordersArgs (dashboard Orders page)', () => {
  it('defaults to page 1 of 20, all statuses', () => {
    assert.deepEqual(ordersArgs(new URLSearchParams('')), { page: 1, per_page: 20 });
  });
  it('maps status and whole-day dates to woo__list_orders arguments', () => {
    assert.deepEqual(ordersArgs(new URLSearchParams('page=3&per_page=50&status=completed&from=2026-10-01&to=2026-10-21')), {
      page: 3,
      per_page: 50,
      status: 'completed',
      after: '2026-10-01T00:00:00',
      before: '2026-10-21T23:59:59',
    });
  });
  it('rejects bad input instead of passing it upstream', () => {
    for (const q of ['per_page=500', 'page=0', 'status=hacked', 'from=2026-10-01T00:00:00', 'from=yesterday'])
      assert.throws(() => ordersArgs(new URLSearchParams(q)), q);
  });
});
