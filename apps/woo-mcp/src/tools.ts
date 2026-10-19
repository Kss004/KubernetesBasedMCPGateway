// The five WooCommerce tools (T2.3). Descriptions stay short and factual.
// create_product defaults to publish: drafts never reach the storefront (DoD).
// list_orders takes after/before so "orders today" is answerable.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { wooRequest, type WooConfig } from './woo.js';

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

// E2E round 5 bug 1: the model added up order totals itself and got them wrong every time.
// Return the count and total computed here (in cents, so no float drift) next to the orders.
export const orderSummary = (orders: WOrder[], perPage: number) => {
  const cents = orders.reduce((sum, o) => sum + Math.round(Number(o.total) * 100), 0);
  return {
    count: orders.length,
    total: (cents / 100).toFixed(2),
    complete: orders.length < perPage, // false: there may be more pages
    orders: orders.map(slimOrder),
  };
};

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });

export function registerTools(server: McpServer, cfg: WooConfig): void {
  server.registerTool(
    'list_products',
    {
      description: 'List store products with id, name, price and stock status.',
      inputSchema: {
        search: z.string().optional(),
        status: z.enum(['publish', 'draft', 'any']).optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      text(
        ((await wooRequest<WProduct[]>(cfg, 'GET', '/wp-json/wc/v3/products', {
          ...(args.search ? { search: args.search } : {}),
          ...(args.status && args.status !== 'any' ? { status: args.status } : {}),
          page: String(args.page ?? 1),
          per_page: String(args.per_page ?? 20),
        })) as WProduct[]).map(slimProduct),
      ),
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
    async (args) =>
      text(
        slimProduct(
          await wooRequest<WProduct>(cfg, 'POST', '/wp-json/wc/v3/products', {}, {
            name: args.name,
            type: 'simple',
            regular_price: args.price,
            description: args.description ?? '',
            status: args.status,
          }),
        ),
      ),
  );

  server.registerTool(
    'list_orders',
    {
      description:
        'List orders, filterable by date range and status. Returns count and total (sum of order totals) for the returned orders; complete=false means more pages exist.',
      inputSchema: {
        after: z.string().optional(),
        before: z.string().optional(),
        status: z.string().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => {
      const perPage = args.per_page ?? 100; // a whole day in one page, so count and total cover it
      const orders = (await wooRequest<WOrder[]>(cfg, 'GET', '/wp-json/wc/v3/orders', {
        ...(args.after ? { after: args.after } : {}),
        ...(args.before ? { before: args.before } : {}),
        ...(args.status ? { status: args.status } : {}),
        page: String(args.page ?? 1),
        per_page: String(perPage),
      })) as WOrder[];
      return text(orderSummary(orders, perPage));
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
