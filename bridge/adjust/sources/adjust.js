import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { adjustGet } from '../vendors.js';
import { days, mapLimit, shiftDay } from '../tasks.js';
import { RAW_DIR, inTransaction, insertRows, lit, saveRaw } from '../warehouse.js';

/** Cohort revenue keeps maturing for 30 days after install, so re-pull that whole window */
export const lookbackDays = 35;

const MAX_JSON_BYTES = 1 << 29;
/** Days fetched before being loaded, so an interrupted backfill keeps everything up to the last batch */
const BATCH_DAYS = 30;
const CONCURRENCY = Number(process.env.ADJUST_CONCURRENCY) || 3;
/** Optional comma-separated report names (e.g. ADJUST_REPORTS=cohorts) for one-off re-pulls */
const ONLY_REPORTS = process.env.ADJUST_REPORTS ? new Set(process.env.ADJUST_REPORTS.split(',')) : null;

/** table column -> Adjust metric id */
const DETAIL_METRICS = {
  impressions: 'impressions',
  clicks: 'clicks',
  installs: 'installs',
  reattributions: 'reattributions',
  reinstalls: 'reinstalls',
  uninstalls: 'uninstalls',
  sessions: 'sessions',
  events: 'events',
  revenue_events: 'revenue_events',
  cost: 'cost',
  network_cost: 'network_cost',
  iap_revenue: 'revenue',
  ad_revenue: 'ad_revenue',
  all_revenue: 'all_revenue',
};

const ACTIVE_METRICS = { daus: 'daus', waus: 'waus', maus: 'maus' };

const COHORT_DAYS = [0, 1, 3, 6, 7, 13, 14, 29, 30];
/** Adjust has no data before this; the weekly cohort refresh re-pulls from here */
const HISTORY_START = '2022-08-01';

/** Cumulative revenue from users who installed on `date`, within N days of install */
const COHORT_METRICS = {
  installs: 'installs',
  cost: 'cost',
  ...Object.fromEntries(COHORT_DAYS.map((d) => [`iap_revenue_d${d}`, `revenue_total_d${d}`])),
  ...Object.fromEntries(COHORT_DAYS.map((d) => [`all_revenue_d${d}`, `all_revenue_total_d${d}`])),
  iap_revenue_to_date: 'cohort_revenue',
  all_revenue_to_date: 'cohort_all_revenue',
};

const RETENTION_DAYS = [1, 3, 7, 14, 30];

/** Users from the install cohort active on day N, and the cohort size that day's rate is measured against */
const RETENTION_METRICS = {
  installs: 'installs',
  ...Object.fromEntries(RETENTION_DAYS.map((d) => [`retained_users_d${d}`, `retained_users_d${d}`])),
  ...Object.fromEntries(RETENTION_DAYS.map((d) => [`cohort_size_d${d}`, `cohort_size_d${d}`])),
};

const SKAN_METRICS = {
  skad_installs: 'skad_installs',
  skad_total_installs: 'skad_total_installs',
  skad_reinstalls: 'skad_reinstalls',
  skad_conversion_value_total: 'skad_conversion_value_total',
  skad_qualifiers: 'skad_qualifiers',
};

const CREATIVE_METRICS = {
  impressions: 'impressions',
  clicks: 'clicks',
  installs: 'installs',
  cost: 'cost',
  iap_revenue: 'revenue',
  ad_revenue: 'ad_revenue',
  all_revenue: 'all_revenue',
};

const ATTRIBUTION_DIMENSIONS = {
  app_token: 'app_token',
  country: 'country_code',
  os_name: 'os_name',
  partner: 'partner_name',
  campaign: 'campaign',
};

const REPORTS = [
  {
    name: 'daily',
    table: 'adjust.daily',
    dimensions: ATTRIBUTION_DIMENSIONS,
    metrics: DETAIL_METRICS,
  },
  {
    name: 'cohorts',
    table: 'adjust.cohorts',
    dimensions: ATTRIBUTION_DIMENSIONS,
    metrics: COHORT_METRICS,
    /** To-date revenue keeps growing for every cohort, so old responses are never reused and history is re-pulled weekly */
    neverSettles: true,
  },
  {
    name: 'app_daily',
    table: 'adjust.app_daily',
    dimensions: { app_token: 'app_token' },
    metrics: ACTIVE_METRICS,
  },
  {
    name: 'retention',
    table: 'adjust.retention',
    dimensions: ATTRIBUTION_DIMENSIONS,
    metrics: RETENTION_METRICS,
  },
  {
    name: 'skan',
    table: 'adjust.skan',
    dimensions: { app_token: 'app_token', partner: 'partner_name', campaign: 'campaign' },
    metrics: SKAN_METRICS,
  },
  {
    name: 'creatives',
    table: 'adjust.creatives',
    dimensions: {
      app_token: 'app_token',
      os_name: 'os_name',
      partner: 'partner_name',
      campaign: 'campaign',
      adgroup: 'adgroup',
      creative: 'creative',
    },
    metrics: CREATIVE_METRICS,
  },
];

const IOS_STORE_ID = /^\d+$/;
const ANDROID_PACKAGE = /^[a-z][\w]*(\.[\w]+)+$/i;

/** Picks each app's main iOS and Android store id by installs over the past year */
async function fetchStoreIds() {
  const body = await adjustGet('report', {
    dimensions: 'app_token,store_id',
    metrics: 'installs',
    date_period: '-365d:-1d',
    sort: '-installs',
  });
  saveRaw('adjust/store_ids/latest.json', body);
  const ids = new Map();
  for (const { app_token, store_id } of JSON.parse(body).rows) {
    const entry = ids.get(app_token) ?? {};
    if (!entry.ios && IOS_STORE_ID.test(store_id)) entry.ios = store_id;
    if (!entry.android && ANDROID_PACKAGE.test(store_id)) entry.android = store_id;
    ids.set(app_token, entry);
  }
  return ids;
}

async function syncApps(conn) {
  const body = await adjustGet('filters_data', { required_filters: 'apps' });
  saveRaw('adjust/apps/latest.json', body);
  const storeIds = await fetchStoreIds();
  const rows = JSON.parse(body).apps.map((a) => ({
    app_token: a.id,
    name: a.name,
    currency: a.currency?.code,
    ios_store_id: a.platforms?.ios?.store_id || storeIds.get(a.id)?.ios || null,
    android_store_id: a.platforms?.android?.store_id || storeIds.get(a.id)?.android || null,
  }));
  await inTransaction(conn, async () => {
    await conn.run('DELETE FROM adjust.apps');
    await insertRows(conn, 'adjust.apps', Object.keys(rows[0]), rows);
  });
}

/** Days older than the lookback window no longer change, so an already downloaded response is reused */
async function fetchDay(report, day, settledBefore) {
  const rawPath = join(RAW_DIR, `adjust/${report.name}/${day}.json.gz`);
  if (!report.neverSettles && day < settledBefore && existsSync(rawPath)) {
    const count = JSON.parse(gunzipSync(readFileSync(rawPath)).toString('utf8')).rows.length;
    return { day, count, path: rawPath };
  }
  const body = await adjustGet('report', {
    dimensions: ['day', ...Object.values(report.dimensions)].join(','),
    metrics: Object.values(report.metrics).join(','),
    date_period: `${day}:${day}`,
    utc_offset: '+00:00',
    currency: 'USD',
  });
  const count = JSON.parse(body).rows.length;
  return { day, count, path: saveRaw(`adjust/${report.name}/${day}.json`, body) };
}

function loadSql(report, path) {
  const columns = ['date', ...Object.keys(report.dimensions), ...Object.keys(report.metrics)];
  const exprs = [
    'CAST(r.day AS DATE)',
    ...Object.values(report.dimensions).map((field) => `r.${field}`),
    ...Object.values(report.metrics).map((field) => `TRY_CAST(r.${field} AS DOUBLE)`),
  ];
  return `INSERT INTO ${report.table} (${columns.join(', ')})
    SELECT ${exprs.join(', ')}
    FROM (SELECT unnest(rows) AS r FROM read_json(${lit(path)}, maximum_object_size = ${MAX_JSON_BYTES}))`;
}

/** The first scheduled run on Sundays (UTC) */
function isWeeklyRefreshRun(now = new Date()) {
  return now.getUTCDay() === 0 && now.getUTCHours() < 18;
}

export async function sync({ conn, from, to, log }) {
  await syncApps(conn);
  let total = 0;
  const settledBefore = shiftDay(to, -lookbackDays);
  const fullRefresh = isWeeklyRefreshRun();
  for (const report of REPORTS.filter((r) => !ONLY_REPORTS || ONLY_REPORTS.has(r.name))) {
    const window = days(report.neverSettles && fullRefresh && HISTORY_START < from ? HISTORY_START : from, to);
    for (let i = 0; i < window.length; i += BATCH_DAYS) {
      const batch = window.slice(i, i + BATCH_DAYS);
      const fetched = await mapLimit(batch, CONCURRENCY, (day) => fetchDay(report, day, settledBefore));
      for (const { day, count, path } of fetched) {
        await inTransaction(conn, async () => {
          await conn.run(`DELETE FROM ${report.table} WHERE date = ${lit(day)}`);
          if (count > 0) await conn.run(loadSql(report, path));
        });
        total += count;
      }
    }
    log(`adjust.${report.name}: ${window.length} days`);
  }
  return { rows: total };
}
