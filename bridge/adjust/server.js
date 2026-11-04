import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildWarehouseServer } from './sql.js';
import {
  ADJUST_TOKEN,
  ASC_ENABLED,
  ASC_VENDOR,
  RC_APPS,
  adjustGet,
  ascGet,
  rcGet,
  rcProject,
  salesReportParams,
} from './vendors.js';

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const BRIDGE_TOKEN = process.env.MCP_BRIDGE_TOKEN;

if (!BRIDGE_TOKEN || !ADJUST_TOKEN) {
  console.error('MCP_BRIDGE_TOKEN and ADJUST_API must be set');
  process.exit(1);
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v.join(',') : v));

function buildServer() {
  const server = new McpServer({ name: 'adjust-reports', version: '1.0.0' });

  server.registerTool(
    'list_apps',
    {
      title: 'List Adjust apps',
      description:
        'List all apps in the Adjust account with their app tokens, platforms, store IDs, and currency. App tokens are needed to filter reports to specific apps.',
      inputSchema: {},
    },
    async () => {
      const raw = await adjustGet('filters_data', { required_filters: 'apps' });
      const { apps } = JSON.parse(raw);
      const slim = apps.map((a) => ({
        app_token: a.id,
        name: a.name,
        currency: a.currency?.code,
        platforms: Object.fromEntries(
          Object.entries(a.platforms || {})
            .filter(([, p]) => p && p.configured)
            .map(([k, p]) => [k, p.store_id]),
        ),
      }));
      return textResult(JSON.stringify(slim, null, 2));
    },
  );

  server.registerTool(
    'list_filters',
    {
      title: 'List available metrics, dimensions, or events',
      description:
        'Discover what can be queried: metrics (e.g. installs, sessions, revenue, maus, daus), dimensions (e.g. app, day, week, month, country, os_name, partner, campaign, adgroup, creative), events, and cohort metrics. Use before building a report if unsure of exact field names.',
      inputSchema: {
        section: z
          .enum(['overview_metrics', 'dimensions', 'events', 'cohort_maturity', 'cost_metrics', 'skad_metrics'])
          .describe('Which catalog to fetch'),
        app_token__in: csv.optional().describe('Limit catalog to specific app tokens (comma-separated)'),
      },
    },
    async ({ section, app_token__in }) => {
      const raw = await adjustGet('filters_data', { required_filters: section, app_token__in });
      return textResult(raw);
    },
  );

  server.registerTool(
    'run_report',
    {
      title: 'Run an Adjust aggregate report',
      description:
        'Query aggregated KPIs across apps. Returns JSON rows plus totals. Examples: installs per app last 30 days (dimensions=app, metrics=installs, date_period=-30d:-1d); daily revenue by country for one app (dimensions=day,country metrics=all_revenue app_token__in=<token>).',
      inputSchema: {
        metrics: csv.describe(
          'Comma-separated metrics, e.g. "installs,sessions,all_revenue,maus,daus". Use list_filters(section=overview_metrics) to discover.',
        ),
        dimensions: csv.describe(
          'Comma-separated dimensions, e.g. "app,day" or "app,country,os_name". Time dimensions: hour, day, week, month, year.',
        ),
        date_period: z
          .string()
          .describe(
            'Date range: "YYYY-MM-DD:YYYY-MM-DD", relative like "-30d:-1d" or "-6m:-1d", or "this_month", "last_month".',
          ),
        app_token__in: csv.optional().describe('Filter to specific app tokens (comma-separated). Omit for all apps.'),
        country__in: csv.optional().describe('Filter by ISO country codes, e.g. "US,GB,TR"'),
        os_name__in: csv.optional().describe('Filter by OS, e.g. "ios,android"'),
        partner__in: csv.optional().describe('Filter by ad network partner slugs'),
        currency: z.string().optional().describe('Report currency code, e.g. "USD" (default: account setting)'),
        sort: z.string().optional().describe('Sort field, prefix with "-" for descending, e.g. "-installs"'),
        utc_offset: z.string().optional().describe('Timezone offset like "+03:00"'),
      },
    },
    async ({ metrics, dimensions, date_period, ...rest }) => {
      const raw = await adjustGet('report', { metrics, dimensions, date_period, ...rest });
      return textResult(raw);
    },
  );

  return server;
}

function buildRcServer() {
  const server = new McpServer({ name: 'revenuecat-reports', version: '2.0.0' });
  const appParam = z.enum(RC_APPS).describe(`Which app's RevenueCat project to query. One of: ${RC_APPS.join(', ')}`);

  server.registerTool(
    'list_apps',
    {
      title: 'List RevenueCat apps',
      description:
        `List the RevenueCat apps available on this server (${RC_APPS.join(', ')}) with their project ids and names. Use the returned app slug as the "app" argument for the other tools.`,
      inputSchema: {},
    },
    async () => {
      const rows = await Promise.all(
        RC_APPS.map(async (app) => {
          try {
            const project = await rcProject(app);
            return { app, project_id: project.id, project_name: project.name };
          } catch (err) {
            return { app, error: err.message };
          }
        }),
      );
      return textResult(JSON.stringify(rows, null, 2));
    },
  );

  server.registerTool(
    'overview_metrics',
    {
      title: 'RevenueCat overview metrics',
      description:
        'Current snapshot KPIs for one app: active trials, active subscriptions, MRR, revenue (last 28 days), new customers, active users. Values are current-state, not historical time series.',
      inputSchema: { app: appParam },
    },
    async ({ app }) => textResult(await rcGet(app, `/projects/${(await rcProject(app)).id}/metrics/overview`)),
  );

  server.registerTool(
    'list_resources',
    {
      title: 'List RevenueCat catalog resources',
      description:
        'List apps, products, entitlements, or offerings configured in one app\'s project. Supports pagination via starting_after (pass the last item id from the previous page).',
      inputSchema: {
        app: appParam,
        kind: z.enum(['apps', 'products', 'entitlements', 'offerings']).describe('Resource type to list'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size (default 20)'),
        starting_after: z.string().optional().describe('Item id to paginate after'),
      },
    },
    async ({ app, kind, limit, starting_after }) =>
      textResult(await rcGet(app, `/projects/${(await rcProject(app)).id}/${kind}`, { limit, starting_after })),
  );

  server.registerTool(
    'get_customer',
    {
      title: 'Look up a RevenueCat customer',
      description:
        'Fetch one customer by app user ID from one app\'s project, including their active entitlements, subscriptions, and recent purchases. Requires the exact customer/app user id.',
      inputSchema: {
        app: appParam,
        customer_id: z.string().describe('The RevenueCat app user ID'),
      },
    },
    async ({ app, customer_id }) => {
      const pid = (await rcProject(app)).id;
      const encoded = encodeURIComponent(customer_id);
      const [customer, subscriptions, purchases] = await Promise.all([
        rcGet(app, `/projects/${pid}/customers/${encoded}`),
        rcGet(app, `/projects/${pid}/customers/${encoded}/subscriptions`).catch((e) => JSON.stringify({ error: e.message })),
        rcGet(app, `/projects/${pid}/customers/${encoded}/purchases`).catch((e) => JSON.stringify({ error: e.message })),
      ]);
      return textResult(JSON.stringify({ customer: JSON.parse(customer), subscriptions: JSON.parse(subscriptions), purchases: JSON.parse(purchases) }, null, 2));
    },
  );

  return server;
}

function buildAscServer() {
  const server = new McpServer({ name: 'appstore-sales', version: '1.0.0' });

  server.registerTool(
    'list_apps',
    {
      title: 'List App Store apps',
      description: 'List apps on the App Store Connect account with their Apple app IDs, names, bundle IDs, and SKUs.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Max apps to return (default 50)'),
      },
    },
    async ({ limit }) => {
      const raw = await ascGet('/apps', { 'fields[apps]': 'name,bundleId,sku,primaryLocale', limit: limit ?? 50 });
      const { data } = JSON.parse(raw);
      const slim = data.map((a) => ({ apple_id: a.id, ...a.attributes }));
      return textResult(JSON.stringify(slim, null, 2));
    },
  );

  server.registerTool(
    'sales_report',
    {
      title: 'Download an App Store sales report',
      description:
        'Fetch Sales and Trends reports as TSV. reportType SALES (units/proceeds per app per day), SUBSCRIPTION (active subs snapshot), SUBSCRIBER (subscriber-level detail), SUBSCRIPTION_EVENT (renewals/cancellations). Daily reports are available for the last ~365 days, roughly 1 day behind real time.',
      inputSchema: {
        report_type: z
          .enum(['SALES', 'SUBSCRIPTION', 'SUBSCRIBER', 'SUBSCRIPTION_EVENT'])
          .describe('Which report family'),
        frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).describe('Report granularity'),
        report_date: z
          .string()
          .describe('Date of the report: YYYY-MM-DD for DAILY/WEEKLY, YYYY-MM for MONTHLY, YYYY for YEARLY'),
        vendor_number: z
          .string()
          .optional()
          .describe('Vendor number (from App Store Connect > Payments and Financial Reports). Optional if configured server-side.'),
        max_rows: z.number().int().min(1).max(5000).optional().describe('Cap returned TSV rows (default 500)'),
      },
    },
    async ({ report_type, frequency, report_date, vendor_number, max_rows }) => {
      const vendor = vendor_number || ASC_VENDOR;
      if (!vendor) {
        throw new Error(
          'No vendor number: pass vendor_number, or set APP_STORE_CONNECT_VENDOR_NUMBER on the bridge. Find it at App Store Connect > Payments and Financial Reports (top of page).',
        );
      }
      const tsv = await ascGet('/salesReports', salesReportParams(report_type, frequency, report_date, vendor), true);
      const cap = max_rows ?? 500;
      const lines = tsv.split('\n');
      const body = lines.slice(0, cap + 1).join('\n');
      const note = lines.length > cap + 1 ? `\n[truncated: showing ${cap} of ${lines.length - 1} rows]` : '';
      return textResult(body + note);
    },
  );

  return server;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${BRIDGE_TOKEN}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

const mounted = [];

/** Serves a stateless MCP server (fresh instance per request) at `path` */
function mount(path, build, label) {
  mounted.push(path);
  app.post(path, async (req, res) => {
    try {
      const server = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`${label} MCP request failed:`, err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });
}

mount('/mcp', buildServer, 'Adjust');
if (RC_APPS.length > 0) mount('/rc/mcp', buildRcServer, 'RC');
if (ASC_ENABLED) mount('/asc/mcp', buildAscServer, 'ASC');
mount('/wh/mcp', buildWarehouseServer, 'Warehouse');

app.get(mounted, (_req, res) => res.status(405).set('Allow', 'POST').end());
app.delete(mounted, (_req, res) => res.status(405).set('Allow', 'POST').end());

app.listen(PORT, '0.0.0.0', () => {
  console.log(`adjust-mcp-bridge listening on :${PORT}`);
});
