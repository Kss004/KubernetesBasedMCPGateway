// Store orders, one page at a time (GET /api/orders -> woo__list_orders, audited server-side).
// Totals in the summary cover every order that matches the filters, not just this page.
import { useCallback, useEffect, useState } from 'react';
import { api, guard } from './api.js';

const STATUSES = ['any', 'pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'];
const SIZES = [10, 20, 50, 100];

const money = (amount, code) => {
  const n = Number(amount);
  if (!code || !Number.isFinite(n)) return amount ?? '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(n);
  } catch {
    return `${amount} ${code}`;
  }
};

export default function Orders({ setStatus }) {
  const [filters, setFilters] = useState({ status: 'any', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);
  const [data, setData] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ page: String(page), per_page: String(perPage), status: filters.status });
      if (filters.from) q.set('from', filters.from);
      if (filters.to) q.set('to', filters.to);
      setData(await api(`/api/orders?${q}`));
    } finally {
      setBusy(false);
    }
  }, [page, perPage, filters]);

  useEffect(() => {
    guard(setStatus, load)();
  }, [load, setStatus]);

  const setFilter = (k) => (e) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };
  const pages = Math.max(data?.total_pages ?? 1, 1);
  const orders = data?.orders ?? [];

  return (
    <section>
      <div className="row">
        <label>
          Status
          <select value={filters.status} onChange={setFilter('status')}>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" value={filters.from} onChange={setFilter('from')} />
        </label>
        <label>
          To
          <input type="date" value={filters.to} onChange={setFilter('to')} />
        </label>
        <button onClick={guard(setStatus, load)} disabled={busy}>
          Refresh
        </button>
      </div>

      {data && (
        <p className="orders-summary">
          <strong>{data.count}</strong> {data.count === 1 ? 'order' : 'orders'} ·{' '}
          <strong>{money(data.total, data.currency)}</strong> total{data.currency ? ` (${data.currency})` : ''}
          {!data.complete && <span className="muted"> · total covers the first 1,000 orders</span>}
        </p>
      )}

      <table className={busy ? 'is-loading' : ''}>
        <thead>
          <tr>
            <th>Order</th>
            <th>Date</th>
            <th>Status</th>
            <th className="num">Total</th>
            <th>Payment</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td className="mono">#{o.id}</td>
              <td>{o.created_gmt ? new Date(`${o.created_gmt}Z`).toLocaleString() : o.created || '—'}</td>
              <td>
                <span className={`pill ord-${o.status}`}>{o.status}</span>
              </td>
              <td className="num">{money(o.total, o.currency || data?.currency)}</td>
              <td>{o.payment || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data === null && <p className="muted">Loading…</p>}
      {data !== null && orders.length === 0 && <p className="muted">No orders match these filters.</p>}

      <div className="pager">
        <button onClick={() => setPage(1)} disabled={busy || page <= 1}>
          « First
        </button>
        <button onClick={() => setPage((p) => p - 1)} disabled={busy || page <= 1}>
          ‹ Prev
        </button>
        <span className="pager-pos">
          Page <strong>{Math.min(page, pages)}</strong> of {pages}
        </span>
        <button onClick={() => setPage((p) => p + 1)} disabled={busy || page >= pages}>
          Next ›
        </button>
        <button onClick={() => setPage(pages)} disabled={busy || page >= pages}>
          Last »
        </button>
        <label className="pager-size">
          Per page
          <select
            value={perPage}
            onChange={(e) => {
              setPerPage(Number(e.target.value));
              setPage(1);
            }}
          >
            {SIZES.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
