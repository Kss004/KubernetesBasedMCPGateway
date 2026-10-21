// The five WooCommerce tools (T2.3). Descriptions stay short and factual.
// create_product defaults to publish: drafts never reach the storefront (DoD).
// list_orders takes after/before so "orders today" is answerable.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { wooRequest, wooList, type WooConfig } from './woo.js';

interface WProduct {
  id: number;
  name: string;
  status: string;
  prices?: { price?: string };
  price?: string;
  stock_status?: string;
}
interface WOrder {
  id: number;
  status: string;
  total: string;
  currency?: string;
  date_created: string;
  payment_method_title?: string;
}

const slimProduct = (p: WProduct) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  price: p.prices?.price ?? p.price,
  stock: p.stock_status,
});
const slimOrder = (o: WOrder) => ({
  id: o.id,
  status: o.status,
  total: o.total,
  currency: o.currency,
  created: o.date_created,
  payment: o.payment_method_title,
});

// get_order: an allowlist, not the raw order. The raw one carries order_key (opens the
// order-received page), customer IP, user agent, email, phone and meta_data (E2E L12).
type WAddr = { first_name?: string; last_name?: string; address_1?: string; city?: string; state?: string; postcode?: string; country?: string };
const addr = (a?: WAddr) =>
  a && {
    name: `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim(),
    address_1: a.address_1,
    city: a.city,
    state: a.state,
    postcode: a.postcode,
    country: a.country,
  };
export const orderDetail = (o: WOrder & {
  currency?: string;
  shipping_total?: string;
  total_tax?: string;
  line_items?: Array<{ name?: string; quantity?: number; total?: string }>;
  billing?: WAddr;
  shipping?: WAddr;
}) => ({
  ...slimOrder(o),
  currency: o.currency,
  shipping_total: o.shipping_total,
  total_tax: o.total_tax,
  items: (o.line_items ?? []).map((i) => ({ name: i.name, quantity: i.quantity, total: i.total })),
  billing: addr(o.billing),
  shipping: addr(o.shipping),
});

// Store currency (Settings -> General), read once. Bare amounts made the model guess the
// currency; every price and total now travels with its ISO code.
export type Currency = { code: string; symbol: string };
let currency: Promise<Currency> | null = null;
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
export function storeCurrency(cfg: WooConfig): Promise<Currency> {
  currency ??= wooRequest<{ code?: string; symbol?: string }>(cfg, 'GET', '/wp-json/wc/v3/data/currencies/current')
    .then((c) => ({ code: c.code ?? '', symbol: decode(c.symbol ?? '') }))
    .catch((e) => {
      currency = null; // retry next call instead of caching the failure
      throw e;
    });
  return currency;
}

// E2E round 5 bug 1: the model added up order totals itself and got them wrong every time.
// count/total cover every order matching the filters (all pages, in cents so no float drift);
// orders is just the requested page. complete=false only past MAX_SUM_ORDERS.
export const MAX_SUM_ORDERS = 1000;
export const orderSummary = (
  all: WOrder[],
  pageOrders: WOrder[],
  paging: { page: number; perPage: number; totalOrders: number; totalPages: number },
  cur: Currency,
) => {
  const cents = all.reduce((sum, o) => sum + Math.round(Number(o.total) * 100), 0);
  return {
    currency: cur.code,
    symbol: cur.symbol,
    count: paging.totalOrders,
    total: (cents / 100).toFixed(2),
    complete: all.length >= paging.totalOrders,
    page: paging.page,
    per_page: paging.perPage,
    total_pages: paging.totalPages,
    orders: pageOrders.map(slimOrder),
  };
};

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });

export function registerTools(server: McpServer, cfg: WooConfig): void {
  server.registerTool(
    'list_products',
    {
      description:
        'List store products with id, name, price and stock status. Prices are in the returned currency; page/total_pages/total_products describe paging.',
      inputSchema: {
        search: z.string().optional(),
        status: z.enum(['publish', 'draft', 'any']).optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => {
      const page = args.page ?? 1;
      const perPage = args.per_page ?? 20;
      const [res, cur] = await Promise.all([
        wooList<WProduct>(cfg, '/wp-json/wc/v3/products', {
          ...(args.search ? { search: args.search } : {}),
          ...(args.status && args.status !== 'any' ? { status: args.status } : {}),
          page: String(page),
          per_page: String(perPage),
        }),
        storeCurrency(cfg),
      ]);
      return text({
        currency: cur.code,
        symbol: cur.symbol,
        page,
        per_page: perPage,
        total_pages: res.totalPages,
        total_products: res.total,
        products: res.items.map(slimProduct),
      });
    },
  );

  server.registerTool(
    'create_product',
    {
      description: 'Create a store product. Publishes immediately by default.',
      inputSchema: {
        name: z.string().min(1),
        price: z.string().min(1),
        description: z.string().optional(),
        status: z.enum(['publish', 'draft']).default('publish'),
      },
    },
    async (args) => {
      const [p, cur] = await Promise.all([
        wooRequest<WProduct>(cfg, 'POST', '/wp-json/wc/v3/products', {}, {
          name: args.name,
          type: 'simple',
          regular_price: args.price,
          description: args.description ?? '',
          status: args.status,
        }),
        storeCurrency(cfg),
      ]);
      return text({ ...slimProduct(p), currency: cur.code });
    },
  );

  server.registerTool(
    'list_orders',
    {
      description:
        'List orders, filterable by date range and status. count and total (with currency) cover ALL matching orders across every page; orders holds only the requested page (page/total_pages).',
      inputSchema: {
        after: z.string().optional(),
        before: z.string().optional(),
        status: z.string().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => {
      const page = args.page ?? 1;
      const perPage = args.per_page ?? 100;
      const filters = {
        ...(args.after ? { after: args.after } : {}),
        ...(args.before ? { before: args.before } : {}),
        ...(args.status ? { status: args.status } : {}),
      };
      const path = '/wp-json/wc/v3/orders';
      const [res, cur] = await Promise.all([
        wooList<WOrder>(cfg, path, { ...filters, page: String(page), per_page: String(perPage) }),
        storeCurrency(cfg),
      ]);
      // Totals over every matching order: reuse this page when it already holds them all,
      // else walk the filter in 100s (one request per 100 orders, capped at MAX_SUM_ORDERS).
      let all = res.items;
      if (res.total > res.items.length) {
        all = [];
        for (let p = 1; p <= Math.ceil(Math.min(res.total, MAX_SUM_ORDERS) / 100); p++) {
          const chunk = await wooList<WOrder>(cfg, path, { ...filters, page: String(p), per_page: '100' });
          all.push(...chunk.items);
          if (chunk.items.length < 100) break;
        }
      }
      return text(
        orderSummary(all, res.items, { page, perPage, totalOrders: res.total, totalPages: res.totalPages }, cur),
      );
    },
  );

  server.registerTool(
    'get_order',
    {
      description: 'Fetch one order with totals, items and addresses.',
      inputSchema: { id: z.number().int().min(1) },
    },
    async (args) => text(orderDetail(await wooRequest(cfg, 'GET', `/wp-json/wc/v3/orders/${args.id}`))),
  );

  server.registerTool(
    'update_order_status',
    {
      description: 'Change an order status, e.g. processing to completed.',
      inputSchema: {
        id: z.number().int().min(1),
        status: z.enum([
          'pending',
          'processing',
          'on-hold',
          'completed',
          'cancelled',
          'refunded',
          'failed',
        ]),
      },
    },
    async (args) =>
      text(
        slimOrder(
          await wooRequest<WOrder>(cfg, 'PUT', `/wp-json/wc/v3/orders/${args.id}`, {}, {
            status: args.status,
          }),
        ),
      ),
  );
}
