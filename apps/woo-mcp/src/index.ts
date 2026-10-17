// woo-mcp entry: shared stateless shell + WooCommerce tools.
import { serve } from 'mcp-mini';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';
import type { WooConfig } from './woo.js';

const wooCfg: WooConfig = {
  serviceBase: process.env.WP_BASE ?? 'http://store-wordpress',
  homeBase: process.env.WP_HOME_URL ?? 'http://shop.localhost',
  consumerKey: process.env.REST_CONSUMER_KEY ?? '',
  consumerSecret: process.env.REST_CONSUMER_SECRET ?? '',
  timeoutMs: Number(process.env.WOO_TIMEOUT_MS ?? 10000),
};

// Fail closed: this server holds the store's REST keys, so never run unauthenticated.
if (!process.env.WOO_MCP_TOKEN) throw new Error('WOO_MCP_TOKEN is required');

serve({
  name: 'woo-mcp',
  version: '0.1.0',
  port: Number(process.env.PORT ?? 3000),
  bearerToken: process.env.WOO_MCP_TOKEN,
  register: (server: McpServer) => registerTools(server, wooCfg),
});
