import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runQuery } from './warehouse.js';
import { getModel, searchModels } from './semantic.js';

const SCHEMAS = ['core', 'adjust', 'appstore', 'revenuecat', 'meta'];
const SCHEMA_LIST = SCHEMAS.map((s) => `'${s}'`).join(', ');
const MAX_ROWS = 1000;
const SEARCH_LIMIT = 6;

const INSTRUCTIONS = `Lucero company data warehouse (DuckDB SQL dialect), synced nightly from Adjust, App Store Connect and RevenueCat.
Start with search_models to find the tables for a question (it searches the Apache Ossie semantic model: descriptions, synonyms and caveats per table), then get_model for the chosen table's fields, units, time basis and joins, then query. list_tables and describe_table remain for browsing.
Prefer core.app_daily for cross-vendor questions (installs, ad spend, revenue, MRR, trials per app per day) and core.apps for app identity.
Cohort revenue by install date (d0/d3/d6/d13/d29) is in adjust.cohorts; adjust.daily has revenue by the date it occurred.
Adjust also has retention (retained users by install date), skan (iOS SKAdNetwork installs) and creatives (per ad group/creative).
App Store: subscriber_events (per anonymized subscriber), sales_yearly (history older than 365 days), reviews, and analytics_* tables (store impressions/page views, downloads by source, sessions, installs/deletions, purchases, crashes).
RevenueCat: chart_points (long format; includes conversion, LTV, refund rate, MRR movement) and cohort_points (cohort explorer by month since first seen).
Read table comments: they say which metrics are additive and which are point-in-time (never SUM point-in-time metrics like mrr, actives, daus across dates).
Data is complete through yesterday; for today's numbers use the live vendor tools instead.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

const errorResult = (err) => ({
  isError: true,
  content: [
    {
      type: 'text',
      text: err.code === 'ENOENT' ? 'The warehouse has not been built yet (no sync has completed).' : String(err.message ?? err),
    },
  ],
});

const withErrors = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return errorResult(err);
  }
};

const LIST_TABLES_SQL = `
  WITH objects AS (
    SELECT schema_name || '.' || table_name AS name, 'table' AS kind, comment FROM duckdb_tables() WHERE schema_name IN (${SCHEMA_LIST})
    UNION ALL
    SELECT schema_name || '.' || view_name, 'view', comment FROM duckdb_views() WHERE NOT internal AND schema_name IN (${SCHEMA_LIST})
  )
  SELECT o.name, o.kind, c.first_date, c.last_date, c.row_count, o.comment
  FROM objects o LEFT JOIN meta.coverage c ON c.table_name = o.name
  ORDER BY list_position([${SCHEMA_LIST}], split_part(o.name, '.', 1)), o.name`;

export function buildWarehouseServer() {
  const server = new McpServer({ name: 'warehouse', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'list_tables',
    {
      title: 'List warehouse tables',
      description:
        'List every table and view in the company data warehouse with its description, date coverage and row count, plus the last successful sync per source. Call this first.',
      inputSchema: {},
    },
    withErrors(async () => {
      const [tables, freshness] = await Promise.all([
        runQuery(LIST_TABLES_SQL, { maxRows: 200 }),
        runQuery('SELECT * FROM meta.freshness ORDER BY source', { maxRows: 50 }),
      ]);
      return json({ tables: tables.rows, freshness: freshness.rows });
    }),
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe a warehouse table',
      description: 'Columns, types and column descriptions for one table or view, plus 5 sample rows.',
      inputSchema: {
        table: z.string().describe('Qualified name from list_tables, e.g. "core.app_daily" or "adjust.daily"'),
      },
    },
    withErrors(async ({ table }) => {
      const [schema, name] = table.split('.');
      if (!SCHEMAS.includes(schema) || !name) throw new Error(`Unknown table "${table}". Use list_tables.`);
      const columns = await runQuery(
        `SELECT column_name, data_type, comment FROM duckdb_columns()
         WHERE schema_name = '${schema}' AND table_name = '${name.replaceAll("'", "''")}' ORDER BY column_index`,
        { maxRows: 500 },
      );
      if (columns.rows.length === 0) throw new Error(`Unknown table "${table}". Use list_tables.`);
      const sample = await runQuery(`SELECT * FROM "${schema}"."${name.replaceAll('"', '""')}" LIMIT 5`, { maxRows: 5 });
      return json({ table, columns: columns.rows, sample: sample.rows });
    }),
  );

  server.registerTool(
    'search_models',
    {
      title: 'Search the semantic model',
      description:
        'Find the warehouse tables relevant to a question, ranked by the Apache Ossie semantic model (table descriptions, synonyms such as "spend" or "W0", caveats on units and time basis). Returns each table with its synonyms, caveats and columns. Call this first.',
      inputSchema: {
        query: z.string().describe('The question or keywords, e.g. "W0 cohorted ROAS by campaign" or "Apple proceeds USD"'),
        limit: z.number().int().min(1).max(20).optional().describe(`Max tables (default ${SEARCH_LIMIT})`),
      },
    },
    withErrors(async ({ query, limit }) => json(searchModels(query, limit ?? SEARCH_LIMIT))),
  );

  server.registerTool(
    'get_model',
    {
      title: 'Get a table\'s semantic model',
      description:
        'The Apache Ossie dataset for one warehouse table: every field with its type, description and synonyms, the table\'s caveats (units, currency, time basis, point-in-time vs additive), keys, and its relationships to other tables (join columns).',
      inputSchema: {
        table: z.string().describe('Warehouse table from search_models, e.g. "adjust.cohorts"'),
      },
    },
    withErrors(async ({ table }) => json(getModel(table))),
  );

  server.registerTool(
    'query',
    {
      title: 'Run a read-only SQL query',
      description: `Run one read-only DuckDB SQL query against the warehouse and get rows back as JSON. Aggregate in SQL rather than fetching raw rows. Returns at most ${MAX_ROWS} rows (truncated flag tells you if more exist); 30s timeout.`,
      inputSchema: {
        sql: z.string().describe('A single DuckDB SQL SELECT/WITH query'),
        max_rows: z.number().int().min(1).max(MAX_ROWS).optional().describe('Row cap (default 200)'),
      },
    },
    withErrors(async ({ sql, max_rows }) => json(await runQuery(sql, { maxRows: max_rows ?? 200 }))),
  );

  return server;
}
