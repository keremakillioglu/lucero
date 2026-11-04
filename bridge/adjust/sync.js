import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as adjust from './sources/adjust.js';
import * as analytics from './sources/analytics.js';
import * as appstore from './sources/appstore.js';
import * as revenuecat from './sources/revenuecat.js';
import { insertRows, openWriter, publish } from './warehouse.js';
import { shiftDay, today } from './tasks.js';

const SOURCES = { adjust, appstore, analytics, revenuecat };

const { values: args } = parseArgs({
  options: {
    source: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
  },
});

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
for (const key of ['from', 'to']) {
  if (args[key] && !DAY_PATTERN.test(args[key])) {
    console.error(`--${key} must be YYYY-MM-DD`);
    process.exit(2);
  }
}

const selected = args.source ? args.source.split(',') : Object.keys(SOURCES);
const unknown = selected.filter((name) => !SOURCES[name]);
if (unknown.length > 0) {
  console.error(`Unknown source(s): ${unknown.join(', ')}. Available: ${Object.keys(SOURCES).join(', ')}`);
  process.exit(2);
}

const to = args.to ?? shiftDay(today(), -1);
const log = (message) => console.log(`[sync] ${message}`);

async function runSource(conn, runId, name) {
  const source = SOURCES[name];
  const from = args.from ?? shiftDay(to, -(source.lookbackDays - 1));
  const startedAt = new Date().toISOString();
  log(`${name}: ${from} → ${to}`);
  const record = (fields) =>
    insertRows(conn, 'meta.sync_runs', ['run_id', 'source', 'date_from', 'date_to', 'rows', 'status', 'error', 'started_at', 'finished_at'], [
      { run_id: runId, source: name, date_from: from, date_to: to, started_at: startedAt, finished_at: new Date().toISOString(), ...fields },
    ]);
  try {
    const { rows } = await source.sync({ conn, from, to, log });
    await record({ rows, status: 'ok' });
    log(`${name}: ok, ${rows} rows`);
    return true;
  } catch (err) {
    console.error(`[sync] ${name} failed:`, err);
    await record({ rows: 0, status: 'failed', error: String(err.message ?? err).slice(0, 2000) });
    return false;
  }
}

const { instance, conn } = await openWriter();
await conn.run("SET TimeZone = 'UTC'");
const runId = randomUUID();
const outcomes = [];
for (const name of selected) {
  outcomes.push(await runSource(conn, runId, name));
}
await publish(conn);
log('published read copy');
conn.closeSync();
instance.closeSync();
process.exit(outcomes.every(Boolean) ? 0 : 1);
