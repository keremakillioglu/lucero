import { mapLimit, shiftDay } from '../tasks.js';
import { inTransaction, insertRows, lit, saveRaw } from '../warehouse.js';
import { ASC_ENABLED, ascDownload, ascList } from '../vendors.js';

/** Unused: instances are loaded once each, whatever the date window */
export const lookbackDays = 1;

const S = 'text';
const N = 'number';
const D = 'date';

const COMMON = [
  ['Date', 'date', D],
  ['App Name', 'app_name', S],
  ['App Apple Identifier', 'app_apple_id', S],
];

/** App Analytics report name -> table and [CSV header, column, kind] mapping */
const REPORTS = {
  'App Downloads Standard': {
    table: 'appstore.analytics_downloads',
    columns: [
      ...COMMON,
      ['Download Type', 'download_type', S],
      ['App Version', 'app_version', S],
      ['Device', 'device', S],
      ['Platform Version', 'platform_version', S],
      ['Source Type', 'source_type', S],
      ['Page Type', 'page_type', S],
      ['Pre-Order', 'pre_order', S],
      ['Territory', 'territory', S],
      ['Counts', 'counts', N],
    ],
  },
  'App Store Discovery and Engagement Standard': {
    table: 'appstore.analytics_engagement',
    columns: [
      ...COMMON,
      ['Event', 'event', S],
      ['Page Type', 'page_type', S],
      ['Source Type', 'source_type', S],
      ['Engagement Type', 'engagement_type', S],
      ['Device', 'device', S],
      ['Platform Version', 'platform_version', S],
      ['Territory', 'territory', S],
      ['Counts', 'counts', N],
      ['Unique Counts', 'unique_counts', N],
    ],
  },
  'App Sessions Standard': {
    table: 'appstore.analytics_sessions',
    columns: [
      ...COMMON,
      ['App Version', 'app_version', S],
      ['Device', 'device', S],
      ['Platform Version', 'platform_version', S],
      ['Source Type', 'source_type', S],
      ['Page Type', 'page_type', S],
      ['App Download Date', 'app_download_date', D],
      ['Territory', 'territory', S],
      ['Sessions', 'sessions', N],
      ['Total Session Duration', 'total_session_duration', N],
      ['Unique Devices', 'unique_devices', N],
    ],
  },
  'App Store Installation and Deletion Standard': {
    table: 'appstore.analytics_installs',
    columns: [
      ...COMMON,
      ['Event', 'event', S],
      ['Download Type', 'download_type', S],
      ['App Version', 'app_version', S],
      ['Device', 'device', S],
      ['Platform Version', 'platform_version', S],
      ['Source Type', 'source_type', S],
      ['Page Type', 'page_type', S],
      ['App Download Date', 'app_download_date', D],
      ['Territory', 'territory', S],
      ['Counts', 'counts', N],
      ['Unique Devices', 'unique_devices', N],
    ],
  },
  'App Store Purchases Standard': {
    table: 'appstore.analytics_purchases',
    columns: [
      ...COMMON,
      ['Purchase Type', 'purchase_type', S],
      ['Content Name', 'content_name', S],
      ['Content Apple Identifier', 'content_apple_id', S],
      ['Payment Method', 'payment_method', S],
      ['Device', 'device', S],
      ['Platform Version', 'platform_version', S],
      ['Source Type', 'source_type', S],
      ['Page Type', 'page_type', S],
      ['App Download Date', 'app_download_date', D],
      ['Pre-Order', 'pre_order', S],
      ['Territory', 'territory', S],
      ['Purchases', 'purchases', N],
      ['Proceeds in USD', 'proceeds_usd', N],
      ['Sales in USD', 'sales_usd', N],
      ['Paying Users', 'paying_users', N],
    ],
  },
  'App Crashes': {
    table: 'appstore.analytics_crashes',
    columns: [
      ...COMMON,
      ['App Version', 'app_version', S],
      ['Device', 'device', S],
      ['Platform Version', 'platform_version', S],
      ['Crashes', 'crashes', N],
      ['Unique Devices', 'unique_devices', N],
    ],
  },
};

const ONGOING = 'ONGOING';
const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

function columnExpr(header, kind) {
  const value = `nullif(trim(${quoteIdent(header)}), '')`;
  if (kind === N) return `TRY_CAST(${value} AS DOUBLE)`;
  if (kind === D) return `TRY_CAST(${value} AS DATE)`;
  return value;
}

/** The first ONGOING file holds the day before its processing date in full (earlier days only partially) */
const ONGOING_LAG_DAYS = 1;

/**
 * Each app's dates are split at `cutoff` (first ONGOING processing date minus the lag): snapshot rows fill
 * dates before it, ONGOING rows dates from it on, so a day never comes from both request types.
 */
function loadSql(report, instance, paths, cutoff) {
  const columns = ['access_type', 'instance_id', 'processing_date', ...report.columns.map(([, column]) => column)];
  const exprs = [
    lit(instance.accessType),
    lit(instance.id),
    `DATE ${lit(instance.processingDate)}`,
    ...report.columns.map(([header, , kind]) => columnExpr(header, kind)),
  ];
  const date = 'TRY_CAST("Date" AS DATE)';
  const cutoffFilter = !cutoff
    ? ''
    : `WHERE ${date} ${instance.accessType === ONGOING ? '>=' : '<'} DATE ${lit(cutoff)}`;
  return `INSERT INTO ${report.table} (${columns.join(', ')})
    SELECT ${exprs.join(', ')}
    FROM read_csv([${paths.map(lit).join(', ')}], delim = '\t', header = true, all_varchar = true, quote = '', escape = '', null_padding = true, union_by_name = true, compression = 'gzip')
    ${cutoffFilter}`;
}

/** Every DAILY instance of the reports we keep, across all of an app's report requests */
async function listInstances(appId) {
  const requests = await ascList(`/apps/${appId}/analyticsReportRequests`, { limit: 200 });
  const perRequest = await mapLimit(requests, 2, async (request) => {
    const reports = await ascList(`/analyticsReportRequests/${request.id}/reports`, { limit: 200 });
    const kept = reports.filter((report) => REPORTS[report.attributes.name]);
    const perReport = await mapLimit(kept, 2, async (report) => {
      const instances = await ascList(`/analyticsReports/${report.id}/instances`, {
        limit: 200,
        'filter[granularity]': 'DAILY',
      });
      return instances.map((instance) => ({
        id: instance.id,
        appId,
        reportName: report.attributes.name,
        accessType: request.attributes.accessType,
        processingDate: instance.attributes.processingDate,
      }));
    });
    return perReport.flat();
  });
  return perRequest.flat();
}

async function fetchInstance(instance) {
  const segments = await ascList(`/analyticsReportInstances/${instance.id}/segments`, { limit: 200 });
  const paths = await mapLimit(segments, 2, async (segment, i) => {
    const gz = await ascDownload(segment.attributes.url);
    return saveRaw(`appstore/analytics/${instance.appId}/${instance.id}-${i}.csv`, gz, { gzipped: true });
  });
  return { ...instance, paths };
}

export async function sync({ conn, log }) {
  if (!ASC_ENABLED) throw new Error('App Store Connect credentials missing');
  const appIds = (await conn.runAndReadAll('SELECT apple_id FROM appstore.apps')).getRows().map(([id]) => id);
  const loaded = new Set(
    (await conn.runAndReadAll('SELECT instance_id FROM appstore.analytics_instances')).getRows().map(([id]) => id),
  );
  const instances = (await mapLimit(appIds, 4, listInstances)).flat().filter((instance) => !loaded.has(instance.id));
  const firstOngoing = new Map(
    (await conn.runAndReadAll(`SELECT app_apple_id, CAST(min(processing_date) AS VARCHAR) FROM appstore.analytics_instances
      WHERE access_type = ${lit(ONGOING)} GROUP BY 1`)).getRows(),
  );
  for (const instance of instances) {
    if (instance.accessType !== ONGOING) continue;
    const current = firstOngoing.get(instance.appId);
    if (!current || instance.processingDate < current) firstOngoing.set(instance.appId, instance.processingDate);
  }
  let total = 0;
  for (const instance of instances) {
    const fetched = await fetchInstance(instance);
    const report = REPORTS[instance.reportName];
    const first = firstOngoing.get(instance.appId);
    const cutoff = first ? shiftDay(first, -ONGOING_LAG_DAYS) : null;
    await inTransaction(conn, async () => {
      if (fetched.paths.length > 0) await conn.run(loadSql(report, fetched, fetched.paths, cutoff));
      const [[rows]] = (
        await conn.runAndReadAll(`SELECT count(*) FROM ${report.table} WHERE instance_id = ${lit(instance.id)}`)
      ).getRows();
      await insertRows(conn, 'appstore.analytics_instances', ['instance_id', 'app_apple_id', 'report', 'access_type', 'processing_date', 'rows', 'loaded_at'], [
        {
          instance_id: instance.id,
          app_apple_id: instance.appId,
          report: instance.reportName,
          access_type: instance.accessType,
          processing_date: instance.processingDate,
          rows: Number(rows),
          loaded_at: new Date().toISOString(),
        },
      ]);
      total += Number(rows);
    });
  }
  log(`analytics: ${instances.length} new report instances across ${appIds.length} apps`);
  return { rows: total };
}
