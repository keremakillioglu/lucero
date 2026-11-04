import { RC_APPS, rcGet, rcProject } from '../vendors.js';
import { inTransaction, insertRows, lit, saveRaw } from '../warehouse.js';
import { shiftDay, sleep, today } from '../tasks.js';

export const lookbackDays = 7;

const CHARTS = [
  'revenue',
  'mrr',
  'arr',
  'actives',
  'actives_new',
  'trials',
  'trials_new',
  'churn',
  'customers_new',
  'refunds',
  'non-subscription_purchases',
  'customers_active',
  'mrr_movement',
  'refund_rate',
  'conversion_to_paying',
  'trial_conversion_rate',
  'ltv_per_customer',
  'ltv_per_paying_customer',
];
/** Charts whose values keep maturing after the day (conversion/LTV windows up to 30 days) */
const MATURING_CHARTS = new Set(['conversion_to_paying', 'trial_conversion_rate', 'ltv_per_customer', 'ltv_per_paying_customer']);
const MATURING_DAYS = 35;
/** Cohort x period charts; re-pulled in full every run because every cohort keeps gaining periods */
const COHORT_CHARTS = ['cohort_explorer', 'subscription_retention'];
const HISTORY_START = '2019-01-01';
/** Chart -> segments to break it down by (supported segments differ per chart) */
const SEGMENTED_CHARTS = {
  revenue: ['country', 'store'],
  actives: ['first_country', 'store'],
  trials_new: ['country', 'store'],
  customers_new: ['country', 'platform'],
};
const SEGMENT_LIMIT = 50;
/** RevenueCat allows 25 requests/minute per key */
const REQUEST_SPACING_MS = 2600;
const MAX_JSON_BYTES = 1 << 29;

const snake = (sql) => `trim(lower(regexp_replace(${sql}, '[^A-Za-z0-9]+', '_', 'g')), '_')`;

const earliest = (a, b) => (a < b ? a : b);

function chartJobs(from, to) {
  const plain = CHARTS.map((chart) => ({
    chart,
    segmentBy: '',
    from: MATURING_CHARTS.has(chart) ? earliest(from, shiftDay(to, -MATURING_DAYS)) : from,
  }));
  const segmented = Object.entries(SEGMENTED_CHARTS).flatMap(([chart, segments]) =>
    segments.map((segmentBy) => ({ chart, segmentBy, from })),
  );
  const cohorts = COHORT_CHARTS.map((chart) => ({ chart, segmentBy: '', from: HISTORY_START, cohort: true }));
  return [...plain, ...segmented, ...cohorts];
}

function cohortLoadSql(app, chart, path) {
  return `INSERT INTO revenuecat.cohort_points (app, chart, cohort_date, cohort_label, period, period_name, value)
    SELECT ${lit(app)}, ${lit(chart)},
      CAST(epoch_ms(TRY_CAST(v.cohort AS BIGINT) * 1000) AS DATE),
      CASE WHEN TRY_CAST(v.cohort AS BIGINT) IS NULL THEN CAST(v.cohort AS VARCHAR) END,
      v.period, periods[v.period + 1].display_name, TRY_CAST(v.value AS DOUBLE)
    FROM (SELECT periods, unnest("values") AS v FROM read_json(${lit(path)}, maximum_object_size = ${MAX_JSON_BYTES}, columns = {periods: 'STRUCT(display_name VARCHAR)[]', "values": 'STRUCT(cohort VARCHAR, period INTEGER, value VARCHAR)[]'}))
    WHERE TRY_CAST(v.value AS DOUBLE) IS NOT NULL`;
}

function loadSql(app, { chart, segmentBy }, path) {
  const segment = segmentBy ? 'segments[v.segment + 1].display_name' : `'Total'`;
  const filter = segmentBy ? 'WHERE NOT coalesce(segments[v.segment + 1].is_total, false) AND v.value <> 0' : '';
  const source = segmentBy ? 'measures, segments' : 'measures';
  return `INSERT INTO revenuecat.chart_points (app, chart, segment_by, segment, date, measure, value, incomplete)
    SELECT ${lit(app)}, ${lit(chart.replaceAll('-', '_'))}, ${lit(segmentBy)}, ${segment},
      CAST(epoch_ms(v.cohort * 1000) AS DATE), ${snake('measures[v.measure + 1].display_name')},
      v.value, v.incomplete
    FROM (SELECT ${source}, unnest("values") AS v FROM read_json(${lit(path)}, maximum_object_size = ${MAX_JSON_BYTES}))
    ${filter}`;
}

/** Fetches every chart job for one app sequentially to respect the per-key rate limit */
async function fetchApp(app, from, to) {
  const project = await rcProject(app);
  const results = [];
  for (const job of chartJobs(from, to)) {
    const body = await rcGet(app, `/projects/${project.id}/charts/${job.chart}`, {
      start_date: job.from,
      end_date: to,
      resolution: 0,
      currency: 'USD',
      ...(job.segmentBy ? { segment: job.segmentBy, limit_num_segments: SEGMENT_LIMIT } : {}),
    });
    const suffix = job.segmentBy ? `.${job.segmentBy}` : '';
    const path = saveRaw(`revenuecat/${app}/${job.chart}${suffix}/${job.from}_${to}.json`, body);
    results.push({ ...job, path, count: JSON.parse(body).values?.length ?? 0 });
    await sleep(REQUEST_SPACING_MS);
  }
  const overview = await rcGet(app, `/projects/${project.id}/metrics/overview`, { currency: 'USD' });
  saveRaw(`revenuecat/${app}/overview/${today()}.json`, overview);
  return { app, project, results, overview: JSON.parse(overview).metrics };
}

async function loadApp(conn, { app, project, results, overview }, from, to) {
  const snapshotDate = today();
  await inTransaction(conn, async () => {
    await conn.run(`DELETE FROM revenuecat.projects WHERE app = ${lit(app)}`);
    await insertRows(conn, 'revenuecat.projects', ['app', 'project_id', 'name'], [
      { app, project_id: project.id, name: project.name },
    ]);
    await conn.run(`DELETE FROM revenuecat.overview WHERE app = ${lit(app)} AND snapshot_date = ${lit(snapshotDate)}`);
    await insertRows(
      conn,
      'revenuecat.overview',
      ['snapshot_date', 'app', 'metric', 'name', 'value', 'unit', 'period'],
      overview.map((m) => ({ snapshot_date: snapshotDate, app, metric: m.id, name: m.name, value: m.value, unit: m.unit, period: m.period })),
    );
  });
  let total = 0;
  for (const job of results) {
    if (job.cohort) {
      await inTransaction(conn, async () => {
        await conn.run(`DELETE FROM revenuecat.cohort_points WHERE app = ${lit(app)} AND chart = ${lit(job.chart)}`);
        if (job.count > 0) await conn.run(cohortLoadSql(app, job.chart, job.path));
      });
      total += job.count;
      continue;
    }
    await inTransaction(conn, async () => {
      await conn.run(`DELETE FROM revenuecat.chart_points
        WHERE app = ${lit(app)} AND chart = ${lit(job.chart.replaceAll('-', '_'))} AND segment_by = ${lit(job.segmentBy)}
          AND date BETWEEN ${lit(job.from)} AND ${lit(to)}`);
      if (job.count > 0) await conn.run(loadSql(app, job, job.path));
    });
    total += job.count;
  }
  return total;
}

export async function sync({ conn, from, to, log }) {
  const fetched = await Promise.allSettled(RC_APPS.map((app) => fetchApp(app, from, to)));
  let total = 0;
  const failures = [];
  for (const [i, outcome] of fetched.entries()) {
    if (outcome.status === 'rejected') {
      failures.push(`${RC_APPS[i]}: ${outcome.reason.message}`);
      continue;
    }
    total += await loadApp(conn, outcome.value, from, to);
    log(`revenuecat.${RC_APPS[i]}: ${outcome.value.results.length} charts`);
  }
  if (failures.length > 0) throw new Error(`RevenueCat apps failed (others loaded): ${failures.join('; ')}`);
  return { rows: total };
}
