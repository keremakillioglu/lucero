import { gunzipSync } from 'node:zlib';
import { days, mapLimit, shiftDay } from '../tasks.js';
import { inTransaction, insertRows, lit, saveRaw } from '../warehouse.js';
import { ASC_ENABLED, ASC_VENDOR, ascGet, ascGetGzip, ascList, salesReportParams } from '../vendors.js';

export const lookbackDays = 3;

/** Apple keeps daily reports for 365 days; older days only exist inside the yearly report */
const DAILY_RETENTION_DAYS = 365;

const S = 'text';
const N = 'number';
const MDY = 'mdy';
const YMD = 'ymd';

/** Report type -> target table and [TSV header, column, kind] mapping */
const REPORTS = {
  SALES: {
    table: 'appstore.sales',
    columns: [
      ['Provider Country', 'provider_country', S],
      ['SKU', 'sku', S],
      ['Developer', 'developer', S],
      ['Title', 'title', S],
      ['Version', 'version', S],
      ['Product Type Identifier', 'product_type', S],
      ['Units', 'units', N],
      ['Developer Proceeds', 'developer_proceeds', N],
      ['Begin Date', 'begin_date', MDY],
      ['End Date', 'end_date', MDY],
      ['Customer Currency', 'customer_currency', S],
      ['Country Code', 'country', S],
      ['Currency of Proceeds', 'proceeds_currency', S],
      ['Apple Identifier', 'apple_id', S],
      ['Customer Price', 'customer_price', N],
      ['Promo Code', 'promo_code', S],
      ['Parent Identifier', 'parent_identifier', S],
      ['Subscription', 'subscription', S],
      ['Period', 'period', S],
      ['Category', 'category', S],
      ['CMB', 'cmb', S],
      ['Device', 'device', S],
      ['Supported Platforms', 'supported_platforms', S],
      ['Proceeds Reason', 'proceeds_reason', S],
      ['Preserved Pricing', 'preserved_pricing', S],
      ['Client', 'client', S],
      ['Order Type', 'order_type', S],
    ],
  },
  SUBSCRIPTION: {
    table: 'appstore.subscriptions',
    columns: [
      ['App Name', 'app_name', S],
      ['App Apple ID', 'app_apple_id', S],
      ['Subscription Name', 'subscription_name', S],
      ['Subscription Apple ID', 'subscription_apple_id', S],
      ['Subscription Group ID', 'subscription_group_id', S],
      ['Standard Subscription Duration', 'duration', S],
      ['Subscription Offer Name', 'offer_name', S],
      ['Promotional Offer ID', 'promotional_offer_id', S],
      ['Customer Price', 'customer_price', N],
      ['Customer Currency', 'customer_currency', S],
      ['Developer Proceeds', 'developer_proceeds', N],
      ['Proceeds Currency', 'proceeds_currency', S],
      ['Preserved Pricing', 'preserved_pricing', S],
      ['Proceeds Reason', 'proceeds_reason', S],
      ['Client', 'client', S],
      ['Device', 'device', S],
      ['State', 'state', S],
      ['Country', 'country', S],
      ['Active Standard Price Subscriptions', 'active_standard', N],
      ['Active Free Trial Introductory Offer Subscriptions', 'active_free_trial_intro', N],
      ['Active Pay Up Front Introductory Offer Subscriptions', 'active_pay_up_front_intro', N],
      ['Active Pay As You Go Introductory Offer Subscriptions', 'active_pay_as_you_go_intro', N],
      ['Free Trial Promotional Offer Subscriptions', 'free_trial_promo', N],
      ['Pay Up Front Promotional Offer Subscriptions', 'pay_up_front_promo', N],
      ['Pay As You Go Promotional Offer Subscriptions', 'pay_as_you_go_promo', N],
      ['Free Trial Offer Code Subscriptions', 'free_trial_offer_code', N],
      ['Pay Up Front Offer Code Subscriptions', 'pay_up_front_offer_code', N],
      ['Pay As You Go Offer Code Subscriptions', 'pay_as_you_go_offer_code', N],
      ['Free Trial Win-back Offers', 'free_trial_winback', N],
      ['Pay Up Front Win-back Offers', 'pay_up_front_winback', N],
      ['Pay As You Go Win-back Offers', 'pay_as_you_go_winback', N],
      ['Billing Retry', 'billing_retry', N],
      ['Grace Period', 'grace_period', N],
      ['Subscribers', 'subscribers', N],
    ],
  },
  SUBSCRIPTION_EVENT: {
    table: 'appstore.subscription_events',
    columns: [
      ['Event Date', 'event_date', YMD],
      ['Event', 'event', S],
      ['App Name', 'app_name', S],
      ['App Apple ID', 'app_apple_id', S],
      ['Subscription Name', 'subscription_name', S],
      ['Subscription Apple ID', 'subscription_apple_id', S],
      ['Subscription Group ID', 'subscription_group_id', S],
      ['Standard Subscription Duration', 'duration', S],
      ['Subscription Offer Name', 'offer_name', S],
      ['Promotional Offer ID', 'promotional_offer_id', S],
      ['Subscription Offer Type', 'offer_type', S],
      ['Subscription Offer Duration', 'offer_duration', S],
      ['Marketing Opt-In', 'marketing_opt_in', S],
      ['Marketing Opt-In Duration', 'marketing_opt_in_duration', S],
      ['Preserved Pricing', 'preserved_pricing', S],
      ['Proceeds Reason', 'proceeds_reason', S],
      ['Consecutive Paid Periods', 'consecutive_paid_periods', N],
      ['Original Start Date', 'original_start_date', YMD],
      ['Client', 'client', S],
      ['Device', 'device', S],
      ['State', 'state', S],
      ['Country', 'country', S],
      ['Previous Subscription Name', 'previous_subscription_name', S],
      ['Previous Subscription Apple ID', 'previous_subscription_apple_id', S],
      ['Days Before Canceling', 'days_before_canceling', N],
      ['Cancellation Reason', 'cancellation_reason', S],
      ['Days Canceled', 'days_canceled', N],
      ['Quantity', 'quantity', N],
      ['Paid Service Days Recovered', 'paid_service_days_recovered', N],
    ],
  },
  SUBSCRIBER: {
    table: 'appstore.subscriber_events',
    columns: [
      ['Event Date', 'event_date', YMD],
      ['App Name', 'app_name', S],
      ['App Apple ID', 'app_apple_id', S],
      ['Subscription Name', 'subscription_name', S],
      ['Subscription Apple ID', 'subscription_apple_id', S],
      ['Subscription Group ID', 'subscription_group_id', S],
      ['Standard Subscription Duration', 'duration', S],
      ['Subscription Offer Name', 'offer_name', S],
      ['Promotional Offer ID', 'promotional_offer_id', S],
      ['Subscription Offer Type', 'offer_type', S],
      ['Subscription Offer Duration', 'offer_duration', S],
      ['Marketing Opt-In Duration', 'marketing_opt_in_duration', S],
      ['Customer Price', 'customer_price', N],
      ['Customer Currency', 'customer_currency', S],
      ['Developer Proceeds', 'developer_proceeds', N],
      ['Proceeds Currency', 'proceeds_currency', S],
      ['Preserved Pricing', 'preserved_pricing', S],
      ['Proceeds Reason', 'proceeds_reason', S],
      ['Client', 'client', S],
      ['Device', 'device', S],
      ['Country', 'country', S],
      ['Subscriber ID', 'subscriber_id', S],
      ['Subscriber ID Reset', 'subscriber_id_reset', S],
      ['Refund', 'refund', S],
      ['Purchase Date', 'purchase_date', YMD],
      ['Units', 'units', N],
    ],
  },
};

/** Yearly SALES reports are kept by Apple indefinitely; they are the only App Store history older than 365 days */
const YEARLY = { ...REPORTS.SALES, table: 'appstore.sales_yearly' };
const FIRST_YEAR = 2008;

const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

function columnExpr(header, kind, present) {
  if (!present.has(header)) return 'NULL';
  const value = `nullif(trim(${quoteIdent(header)}), '')`;
  if (kind === N) return `TRY_CAST(${value} AS DOUBLE)`;
  if (kind === MDY) return `CAST(TRY_STRPTIME(${value}, '%m/%d/%Y') AS DATE)`;
  if (kind === YMD) return `TRY_CAST(${value} AS DATE)`;
  return value;
}

function loadSql(report, [keyColumn, keyExpr], path, headers) {
  const present = new Set(headers);
  const columns = [keyColumn, ...report.columns.map(([, column]) => column)];
  const exprs = [keyExpr, ...report.columns.map(([header, , kind]) => columnExpr(header, kind, present))];
  return `INSERT INTO ${report.table} (${columns.join(', ')})
    SELECT ${exprs.join(', ')}
    FROM read_csv(${lit(path)}, delim = '\t', header = true, all_varchar = true, quote = '', escape = '', null_padding = true, compression = 'gzip')`;
}

async function syncApps(conn) {
  const body = await ascGet('/apps', { 'fields[apps]': 'name,bundleId,sku', limit: 200 });
  saveRaw('appstore/apps/latest.json', body);
  const rows = JSON.parse(body).data.map((a) => ({
    apple_id: a.id,
    name: a.attributes.name,
    bundle_id: a.attributes.bundleId,
    sku: a.attributes.sku,
  }));
  await inTransaction(conn, async () => {
    await conn.run('DELETE FROM appstore.apps');
    await insertRows(conn, 'appstore.apps', Object.keys(rows[0]), rows);
  });
}

/** Downloads one report; returns null when Apple has no report for that period (404) or has expired it (410) */
async function fetchReport(type, frequency, day) {
  try {
    const gz = await ascGetGzip('/salesReports', salesReportParams(type, frequency, day, ASC_VENDOR));
    const [header, ...lines] = gunzipSync(gz).toString('utf8').split('\n');
    const count = lines.filter((line) => line.trim()).length;
    const folder = frequency === 'DAILY' ? type.toLowerCase() : `${type.toLowerCase()}_${frequency.toLowerCase()}`;
    const path = saveRaw(`appstore/${folder}/${day}.tsv`, gz, { gzipped: true });
    return { day, count, path, headers: header.split('\t').map((h) => h.trim()) };
  } catch (err) {
    if (err.status === 404 || err.status === 410) return null;
    throw err;
  }
}

export async function sync({ conn, from, to, log }) {
  if (!ASC_ENABLED || !ASC_VENDOR) throw new Error('App Store Connect credentials or vendor number missing');
  await syncApps(conn);
  let total = 0;
  const oldestDaily = shiftDay(to, -(DAILY_RETENTION_DAYS - 1));
  const dailyFrom = from < oldestDaily ? oldestDaily : from;
  for (const [type, report] of Object.entries(REPORTS)) {
    const fetched = await mapLimit(days(dailyFrom, to), 4, (day) => fetchReport(type, 'DAILY', day));
    const available = fetched.filter(Boolean);
    for (const { day, count, path, headers } of available) {
      await inTransaction(conn, async () => {
        await conn.run(`DELETE FROM ${report.table} WHERE report_date = ${lit(day)}`);
        if (count > 0) await conn.run(loadSql(report, ['report_date', `DATE ${lit(day)}`], path, headers));
      });
      total += count;
    }
    log(`appstore.${type}: ${available.length} days loaded, ${fetched.length - available.length} not available`);
  }
  total += await syncYearly(conn, from, to, log);
  total += await syncReviews(conn, from, log);
  return { rows: total };
}

/** Completed years overlapping the window, plus the year before (a daily run early in January still refreshes last year) */
async function syncYearly(conn, from, to, log) {
  const lastYear = Number(to.slice(0, 4)) - 1;
  const firstYear = Math.max(FIRST_YEAR, Number(from.slice(0, 4)) - 1);
  const years = Array.from({ length: Math.max(lastYear - firstYear + 1, 0) }, (_, i) => String(firstYear + i));
  const fetched = (await mapLimit(years, 4, (year) => fetchReport('SALES', 'YEARLY', year))).filter(Boolean);
  let total = 0;
  for (const { day: year, count, path, headers } of fetched) {
    await inTransaction(conn, async () => {
      await conn.run(`DELETE FROM ${YEARLY.table} WHERE report_year = ${Number(year)}`);
      if (count > 0) await conn.run(loadSql(YEARLY, ['report_year', String(Number(year))], path, headers));
    });
    total += count;
  }
  log(`appstore.SALES yearly: ${fetched.length} of ${years.length} years available`);
  return total;
}

const REVIEW_COLUMNS = ['review_id', 'app_apple_id', 'created_at', 'rating', 'title', 'body', 'reviewer_nickname', 'territory'];

/** Reviews created on or after `from` (UTC), newest first, for every app */
async function syncReviews(conn, from, log) {
  const appIds = (await conn.runAndReadAll('SELECT apple_id FROM appstore.apps')).getRows().map(([id]) => id);
  const perApp = await mapLimit(appIds, 4, async (appId) => {
    const reviews = await ascList(
      `/apps/${appId}/customerReviews`,
      { sort: '-createdDate', limit: 200, 'fields[customerReviews]': 'rating,title,body,reviewerNickname,createdDate,territory' },
      (review) => review.attributes.createdDate.slice(0, 10) < from,
    );
    return reviews.map((r) => ({
      review_id: r.id,
      app_apple_id: appId,
      created_at: r.attributes.createdDate,
      rating: r.attributes.rating,
      title: r.attributes.title,
      body: r.attributes.body,
      reviewer_nickname: r.attributes.reviewerNickname,
      territory: r.attributes.territory,
    }));
  });
  const rows = perApp.flat();
  saveRaw(`appstore/reviews/${from}_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(rows));
  await inTransaction(conn, async () => {
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await conn.run(`DELETE FROM appstore.reviews WHERE review_id IN (${batch.map((r) => lit(r.review_id)).join(', ')})`);
      await insertRows(conn, 'appstore.reviews', REVIEW_COLUMNS, batch);
    }
  });
  log(`appstore.reviews: ${rows.length} reviews since ${from}`);
  return rows.length;
}
