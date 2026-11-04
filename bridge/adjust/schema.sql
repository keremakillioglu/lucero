CREATE SCHEMA IF NOT EXISTS meta;
CREATE SCHEMA IF NOT EXISTS adjust;
CREATE SCHEMA IF NOT EXISTS appstore;
CREATE SCHEMA IF NOT EXISTS revenuecat;
CREATE SCHEMA IF NOT EXISTS core;

-- meta ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta.sync_runs (
  run_id VARCHAR,
  source VARCHAR,
  date_from DATE,
  date_to DATE,
  rows BIGINT,
  status VARCHAR,
  error VARCHAR,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
COMMENT ON TABLE meta.sync_runs IS 'One row per source per sync run. status: ok | failed. Use to check data freshness.';

-- adjust -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS adjust.apps (
  app_token VARCHAR PRIMARY KEY,
  name VARCHAR,
  currency VARCHAR,
  ios_store_id VARCHAR,
  android_store_id VARCHAR
);
COMMENT ON TABLE adjust.apps IS 'Apps in the Adjust account. ios_store_id is the Apple app id (joins appstore.apps.apple_id).';

CREATE TABLE IF NOT EXISTS adjust.daily (
  date DATE,
  app_token VARCHAR,
  country VARCHAR,
  os_name VARCHAR,
  partner VARCHAR,
  campaign VARCHAR,
  impressions DOUBLE,
  clicks DOUBLE,
  installs DOUBLE,
  reattributions DOUBLE,
  reinstalls DOUBLE,
  uninstalls DOUBLE,
  sessions DOUBLE,
  events DOUBLE,
  revenue_events DOUBLE,
  cost DOUBLE,
  network_cost DOUBLE,
  iap_revenue DOUBLE,
  ad_revenue DOUBLE,
  all_revenue DOUBLE
);
COMMENT ON TABLE adjust.daily IS 'Adjust attribution KPIs per UTC day x app x country x OS x partner x campaign. All metrics are additive (safe to SUM). Money in USD. partner "Organic" = organic installs. Re-synced for the trailing 7 days to absorb late attribution/cost.';
COMMENT ON COLUMN adjust.daily.country IS 'ISO 3166-1 alpha-2, lowercase';
COMMENT ON COLUMN adjust.daily.cost IS 'Ad spend in USD (Adjust "cost")';
COMMENT ON COLUMN adjust.daily.network_cost IS 'Ad spend reported by the ad network API, USD';
COMMENT ON COLUMN adjust.daily.iap_revenue IS 'In-app purchase revenue tracked via Adjust SDK, USD (Adjust "revenue")';
COMMENT ON COLUMN adjust.daily.all_revenue IS 'iap_revenue + ad_revenue, USD';

CREATE TABLE IF NOT EXISTS adjust.cohorts (
  date DATE,
  app_token VARCHAR,
  country VARCHAR,
  os_name VARCHAR,
  partner VARCHAR,
  campaign VARCHAR,
  installs DOUBLE,
  cost DOUBLE,
  iap_revenue_d0 DOUBLE,
  iap_revenue_d3 DOUBLE,
  iap_revenue_d6 DOUBLE,
  iap_revenue_d13 DOUBLE,
  iap_revenue_d29 DOUBLE,
  all_revenue_d0 DOUBLE,
  all_revenue_d3 DOUBLE,
  all_revenue_d6 DOUBLE,
  all_revenue_d13 DOUBLE,
  all_revenue_d29 DOUBLE
);
COMMENT ON TABLE adjust.cohorts IS 'Adjust COHORT revenue by INSTALL date (UTC) x app x country x OS x partner x campaign, USD. Revenue here is attributed to the install date; adjust.daily attributes revenue to the day it occurred. *_dN = cumulative revenue from users who installed on date, earned within N days of install (d0 = install day). Available N: 0, 1, 3, 6, 7, 13, 14, 29, 30 (W0 = d6 = first 7 days counting the install day, W1 = d13, D30 = d29). *_to_date = everything earned since install. For recent install dates the dN window has not fully elapsed yet, so values are still accumulating; the trailing 35 days are re-synced nightly. All columns additive.';
ALTER TABLE adjust.cohorts ADD COLUMN IF NOT EXISTS iap_revenue_d1 DOUBLE;
ALTER TABLE adjust.cohorts ADD COLUMN IF NOT EXISTS iap_revenue_d7 DOUBLE;
ALTER TABLE adjust.cohorts ADD COLUMN IF NOT EXISTS iap_revenue_d14 DOUBLE;
ALTER TABLE adjust.cohorts ADD COLUMN IF NOT EXISTS iap_revenue_d30 DOUBLE;
ALTER TABLE adjust.cohorts ADD COLUMN IF NOT EXISTS all_revenue_d1 DOUBLE;
ALTER TABLE adjust.cohorts ADD COLUMN IF NOT EXISTS all_revenue_d7 DOUBLE;
ALTER TABLE adjust.cohorts ADD COLUMN IF NOT EXISTS all_revenue_d14 DOUBLE;
ALTER TABLE adjust.cohorts ADD COLUMN IF NOT EXISTS all_revenue_d30 DOUBLE;
ALTER TABLE adjust.cohorts ADD COLUMN IF NOT EXISTS iap_revenue_to_date DOUBLE;
ALTER TABLE adjust.cohorts ADD COLUMN IF NOT EXISTS all_revenue_to_date DOUBLE;
COMMENT ON COLUMN adjust.cohorts.iap_revenue_to_date IS 'Cumulative in-app purchase revenue from users who installed on date, from install until the last sync (Adjust cohort_revenue). Keeps growing; refreshed for all install dates weekly (Sunday) and for the trailing 35 days nightly.';
COMMENT ON COLUMN adjust.cohorts.all_revenue_to_date IS 'Cumulative revenue incl. ad revenue from users who installed on date, from install until the last sync (Adjust cohort_all_revenue). Same refresh as iap_revenue_to_date.';
COMMENT ON COLUMN adjust.cohorts.iap_revenue_d7 IS 'Cumulative in-app purchase revenue within 7 days after the install day (Adjust revenue_total_d7; d6 is install day plus 6)';
COMMENT ON COLUMN adjust.cohorts.all_revenue_d7 IS 'Cumulative revenue incl. ad revenue within 7 days after the install day (Adjust all_revenue_total_d7)';
COMMENT ON COLUMN adjust.cohorts.iap_revenue_d6 IS 'W0 cohort in-app purchase revenue (Adjust revenue_total_d6 = revenue_total_w0)';
COMMENT ON COLUMN adjust.cohorts.all_revenue_d6 IS 'W0 cohort revenue incl. ad revenue (Adjust all_revenue_total_d6)';
COMMENT ON COLUMN adjust.cohorts.cost IS 'Ad spend on the install date, USD (same as adjust.daily.cost)';

CREATE TABLE IF NOT EXISTS adjust.app_daily (
  date DATE,
  app_token VARCHAR,
  daus DOUBLE,
  waus DOUBLE,
  maus DOUBLE
);
COMMENT ON TABLE adjust.app_daily IS 'Active-user counts per UTC day x app. NOT additive: never SUM across days; average or take one day.';

CREATE TABLE IF NOT EXISTS adjust.retention (
  date DATE,
  app_token VARCHAR,
  country VARCHAR,
  os_name VARCHAR,
  partner VARCHAR,
  campaign VARCHAR,
  installs DOUBLE,
  retained_users_d1 DOUBLE,
  retained_users_d3 DOUBLE,
  retained_users_d7 DOUBLE,
  retained_users_d14 DOUBLE,
  retained_users_d30 DOUBLE,
  cohort_size_d1 DOUBLE,
  cohort_size_d3 DOUBLE,
  cohort_size_d7 DOUBLE,
  cohort_size_d14 DOUBLE,
  cohort_size_d30 DOUBLE
);
COMMENT ON TABLE adjust.retention IS 'Adjust user retention by INSTALL date (UTC) x app x country x OS x partner x campaign. retained_users_dN = users from the install cohort who were active N days after install; cohort_size_dN = Adjust cohort size used for day N (only users whose day N has elapsed). Counts are additive. Recent install dates are still maturing; the trailing 35 days are re-synced.';
COMMENT ON COLUMN adjust.retention.installs IS 'Installs on the install date (cohort size before maturity)';

CREATE TABLE IF NOT EXISTS adjust.skan (
  date DATE,
  app_token VARCHAR,
  partner VARCHAR,
  campaign VARCHAR,
  skad_installs DOUBLE,
  skad_total_installs DOUBLE,
  skad_reinstalls DOUBLE,
  skad_conversion_value_total DOUBLE,
  skad_qualifiers DOUBLE
);
COMMENT ON TABLE adjust.skan IS 'Apple SKAdNetwork (privacy-preserving iOS attribution) postbacks per UTC day x app x partner x campaign, as reported to Adjust. Additive. iOS only; no country or OS breakdown.';
COMMENT ON COLUMN adjust.skan.skad_installs IS 'SKAN new installs';
COMMENT ON COLUMN adjust.skan.skad_total_installs IS 'SKAN installs plus reinstalls';
COMMENT ON COLUMN adjust.skan.skad_conversion_value_total IS 'Adjust metric skad_conversion_value_total (SKAN postbacks with a conversion value)';
COMMENT ON COLUMN adjust.skan.skad_qualifiers IS 'Adjust metric skad_qualifiers (SKAN postbacks that met the qualifying conversion setup)';

CREATE TABLE IF NOT EXISTS adjust.creatives (
  date DATE,
  app_token VARCHAR,
  os_name VARCHAR,
  partner VARCHAR,
  campaign VARCHAR,
  adgroup VARCHAR,
  creative VARCHAR,
  impressions DOUBLE,
  clicks DOUBLE,
  installs DOUBLE,
  cost DOUBLE,
  iap_revenue DOUBLE,
  ad_revenue DOUBLE,
  all_revenue DOUBLE
);
COMMENT ON TABLE adjust.creatives IS 'Adjust KPIs per UTC day x app x OS x partner x campaign x ad group x creative, USD. Additive. No country breakdown (use adjust.daily for country). Names include the network id in parentheses.';

-- appstore -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS appstore.apps (
  apple_id VARCHAR PRIMARY KEY,
  name VARCHAR,
  bundle_id VARCHAR,
  sku VARCHAR
);
COMMENT ON TABLE appstore.apps IS 'Apps on App Store Connect.';

CREATE TABLE IF NOT EXISTS appstore.sales (
  report_date DATE,
  provider_country VARCHAR,
  sku VARCHAR,
  developer VARCHAR,
  title VARCHAR,
  version VARCHAR,
  product_type VARCHAR,
  units DOUBLE,
  developer_proceeds DOUBLE,
  begin_date DATE,
  end_date DATE,
  customer_currency VARCHAR,
  country VARCHAR,
  proceeds_currency VARCHAR,
  apple_id VARCHAR,
  customer_price DOUBLE,
  promo_code VARCHAR,
  parent_identifier VARCHAR,
  subscription VARCHAR,
  period VARCHAR,
  category VARCHAR,
  cmb VARCHAR,
  device VARCHAR,
  supported_platforms VARCHAR,
  proceeds_reason VARCHAR,
  preserved_pricing VARCHAR,
  client VARCHAR,
  order_type VARCHAR
);
COMMENT ON TABLE appstore.sales IS 'Apple Sales and Trends daily SALES report (Pacific-time days). One row per product x country x device x price point. developer_proceeds is PER UNIT in proceeds_currency: total proceeds = units * developer_proceeds. Currencies are mixed; do not sum money across proceeds_currency.';
COMMENT ON COLUMN appstore.sales.product_type IS 'Apple product type id. App downloads: 1,1F,1T,F1. Redownloads: 3,3F,3T,F3. Updates: 7,7F,7T,F7. IAP/subscriptions: IA1,IA9,IAY,IAC,FI1 etc.';
COMMENT ON COLUMN appstore.sales.apple_id IS 'Apple id of the product (the app for downloads, the in-app product for IAPs)';
COMMENT ON COLUMN appstore.sales.parent_identifier IS 'For in-app products: SKU of the parent app (joins appstore.apps.sku)';
COMMENT ON COLUMN appstore.sales.units IS 'Units; negative for refunds';

CREATE TABLE IF NOT EXISTS appstore.subscriptions (
  report_date DATE,
  app_name VARCHAR,
  app_apple_id VARCHAR,
  subscription_name VARCHAR,
  subscription_apple_id VARCHAR,
  subscription_group_id VARCHAR,
  duration VARCHAR,
  offer_name VARCHAR,
  promotional_offer_id VARCHAR,
  customer_price DOUBLE,
  customer_currency VARCHAR,
  developer_proceeds DOUBLE,
  proceeds_currency VARCHAR,
  preserved_pricing VARCHAR,
  proceeds_reason VARCHAR,
  client VARCHAR,
  device VARCHAR,
  state VARCHAR,
  country VARCHAR,
  active_standard DOUBLE,
  active_free_trial_intro DOUBLE,
  active_pay_up_front_intro DOUBLE,
  active_pay_as_you_go_intro DOUBLE,
  free_trial_promo DOUBLE,
  pay_up_front_promo DOUBLE,
  pay_as_you_go_promo DOUBLE,
  free_trial_offer_code DOUBLE,
  pay_up_front_offer_code DOUBLE,
  pay_as_you_go_offer_code DOUBLE,
  free_trial_winback DOUBLE,
  pay_up_front_winback DOUBLE,
  pay_as_you_go_winback DOUBLE,
  billing_retry DOUBLE,
  grace_period DOUBLE,
  subscribers DOUBLE
);
COMMENT ON TABLE appstore.subscriptions IS 'Apple daily SUBSCRIPTION report: snapshot of active subscriptions at end of report_date (Pacific). Point-in-time counts: SUM within one report_date, never across dates.';
COMMENT ON COLUMN appstore.subscriptions.active_standard IS 'Active paying subscriptions at standard price';
COMMENT ON COLUMN appstore.subscriptions.active_free_trial_intro IS 'Active subscriptions in a free-trial introductory offer';

CREATE TABLE IF NOT EXISTS appstore.subscription_events (
  report_date DATE,
  event_date DATE,
  event VARCHAR,
  app_name VARCHAR,
  app_apple_id VARCHAR,
  subscription_name VARCHAR,
  subscription_apple_id VARCHAR,
  subscription_group_id VARCHAR,
  duration VARCHAR,
  offer_name VARCHAR,
  promotional_offer_id VARCHAR,
  offer_type VARCHAR,
  offer_duration VARCHAR,
  marketing_opt_in VARCHAR,
  marketing_opt_in_duration VARCHAR,
  preserved_pricing VARCHAR,
  proceeds_reason VARCHAR,
  consecutive_paid_periods DOUBLE,
  original_start_date DATE,
  client VARCHAR,
  device VARCHAR,
  state VARCHAR,
  country VARCHAR,
  previous_subscription_name VARCHAR,
  previous_subscription_apple_id VARCHAR,
  days_before_canceling DOUBLE,
  cancellation_reason VARCHAR,
  days_canceled DOUBLE,
  quantity DOUBLE,
  paid_service_days_recovered DOUBLE
);
COMMENT ON TABLE appstore.subscription_events IS 'Apple daily SUBSCRIPTION_EVENT report: counts (quantity) of subscription events such as Start Introductory Offer, Paid Subscription from Introductory Offer, Renew, Cancel, Refund. Additive: SUM(quantity).';

CREATE TABLE IF NOT EXISTS appstore.subscriber_events (
  report_date DATE,
  event_date DATE,
  app_name VARCHAR,
  app_apple_id VARCHAR,
  subscription_name VARCHAR,
  subscription_apple_id VARCHAR,
  subscription_group_id VARCHAR,
  duration VARCHAR,
  offer_name VARCHAR,
  promotional_offer_id VARCHAR,
  offer_type VARCHAR,
  offer_duration VARCHAR,
  marketing_opt_in_duration VARCHAR,
  customer_price DOUBLE,
  customer_currency VARCHAR,
  developer_proceeds DOUBLE,
  proceeds_currency VARCHAR,
  preserved_pricing VARCHAR,
  proceeds_reason VARCHAR,
  client VARCHAR,
  device VARCHAR,
  country VARCHAR,
  subscriber_id VARCHAR,
  subscriber_id_reset VARCHAR,
  refund VARCHAR,
  purchase_date DATE,
  units DOUBLE
);
COMMENT ON TABLE appstore.subscriber_events IS 'Apple daily SUBSCRIBER report (Pacific days): one row per paid subscription transaction or refund, with an anonymized subscriber id. Lets you follow one subscriber across renewals. Apple keeps daily reports for 365 days only.';
COMMENT ON COLUMN appstore.subscriber_events.subscriber_id IS 'Anonymized, app-scoped subscriber id generated by Apple; not linkable to a person';
COMMENT ON COLUMN appstore.subscriber_events.subscriber_id_reset IS 'Yes when the subscriber reset their id, so earlier rows for this person carry a different subscriber_id';
COMMENT ON COLUMN appstore.subscriber_events.refund IS 'Yes for refund rows (units negative)';
COMMENT ON COLUMN appstore.subscriber_events.developer_proceeds IS 'Per unit, in proceeds_currency';

CREATE TABLE IF NOT EXISTS appstore.sales_yearly (
  report_year INTEGER,
  provider_country VARCHAR,
  sku VARCHAR,
  developer VARCHAR,
  title VARCHAR,
  version VARCHAR,
  product_type VARCHAR,
  units DOUBLE,
  developer_proceeds DOUBLE,
  begin_date DATE,
  end_date DATE,
  customer_currency VARCHAR,
  country VARCHAR,
  proceeds_currency VARCHAR,
  apple_id VARCHAR,
  customer_price DOUBLE,
  promo_code VARCHAR,
  parent_identifier VARCHAR,
  subscription VARCHAR,
  period VARCHAR,
  category VARCHAR,
  cmb VARCHAR,
  device VARCHAR,
  supported_platforms VARCHAR,
  proceeds_reason VARCHAR,
  preserved_pricing VARCHAR,
  client VARCHAR,
  order_type VARCHAR
);
COMMENT ON TABLE appstore.sales_yearly IS 'Apple YEARLY SALES report, one per completed calendar year: same columns as appstore.sales but totalled over the year. The only App Store sales history older than 365 days. Do not combine with appstore.sales for the same period.';

CREATE TABLE IF NOT EXISTS appstore.reviews (
  review_id VARCHAR PRIMARY KEY,
  app_apple_id VARCHAR,
  created_at TIMESTAMPTZ,
  rating INTEGER,
  title VARCHAR,
  body VARCHAR,
  reviewer_nickname VARCHAR,
  territory VARCHAR
);
COMMENT ON TABLE appstore.reviews IS 'App Store customer reviews (written ratings with text) for every app. Star-only ratings are not included.';
COMMENT ON COLUMN appstore.reviews.territory IS 'App Store storefront, ISO 3166-1 alpha-3 (e.g. USA)';

CREATE TABLE IF NOT EXISTS appstore.analytics_instances (
  instance_id VARCHAR PRIMARY KEY,
  app_apple_id VARCHAR,
  report VARCHAR,
  access_type VARCHAR,
  processing_date DATE,
  rows BIGINT,
  loaded_at TIMESTAMPTZ
);
COMMENT ON TABLE appstore.analytics_instances IS 'Bookkeeping: App Analytics report instances already loaded into the appstore.analytics_* tables.';

CREATE TABLE IF NOT EXISTS appstore.analytics_downloads (
  access_type VARCHAR, instance_id VARCHAR, processing_date DATE,
  date DATE, app_name VARCHAR, app_apple_id VARCHAR,
  download_type VARCHAR, app_version VARCHAR, device VARCHAR, platform_version VARCHAR,
  source_type VARCHAR, page_type VARCHAR, pre_order VARCHAR, territory VARCHAR,
  counts DOUBLE
);
COMMENT ON TABLE appstore.analytics_downloads IS 'Apple App Analytics "App Downloads": first-time downloads, redownloads and updates per day x app x source x territory x device. Additive SUM(counts).';
COMMENT ON COLUMN appstore.analytics_downloads.access_type IS 'Apple report type: ONE_TIME_SNAPSHOT rows are the historical backfill through 2026-09-21, ONGOING rows are the daily reports from 2026-09-22 on. The two never overlap by date, so SUM across both.';

CREATE TABLE IF NOT EXISTS appstore.analytics_engagement (
  access_type VARCHAR, instance_id VARCHAR, processing_date DATE,
  date DATE, app_name VARCHAR, app_apple_id VARCHAR,
  event VARCHAR, page_type VARCHAR, source_type VARCHAR, engagement_type VARCHAR,
  device VARCHAR, platform_version VARCHAR, territory VARCHAR,
  counts DOUBLE, unique_counts DOUBLE
);
COMMENT ON TABLE appstore.analytics_engagement IS 'Apple App Analytics "App Store Discovery and Engagement": App Store impressions, product page views and taps per day x app x source x page type x territory x device. counts is additive; unique_counts is not additive across rows or days.';
COMMENT ON COLUMN appstore.analytics_engagement.access_type IS 'Apple report type: ONE_TIME_SNAPSHOT rows are the historical backfill through 2026-09-21, ONGOING rows are the daily reports from 2026-09-22 on. The two never overlap by date, so SUM across both.';

CREATE TABLE IF NOT EXISTS appstore.analytics_sessions (
  access_type VARCHAR, instance_id VARCHAR, processing_date DATE,
  date DATE, app_name VARCHAR, app_apple_id VARCHAR,
  app_version VARCHAR, device VARCHAR, platform_version VARCHAR, source_type VARCHAR,
  page_type VARCHAR, app_download_date DATE, territory VARCHAR,
  sessions DOUBLE, total_session_duration DOUBLE, unique_devices DOUBLE
);
COMMENT ON TABLE appstore.analytics_sessions IS 'Apple App Analytics "App Sessions" from users who opted in to share data with developers. sessions and total_session_duration (seconds) are additive; unique_devices is not additive across rows or days.';
COMMENT ON COLUMN appstore.analytics_sessions.access_type IS 'Apple report type: ONE_TIME_SNAPSHOT rows are the historical backfill through 2026-09-21, ONGOING rows are the daily reports from 2026-09-22 on. The two never overlap by date, so SUM across both.';

CREATE TABLE IF NOT EXISTS appstore.analytics_installs (
  access_type VARCHAR, instance_id VARCHAR, processing_date DATE,
  date DATE, app_name VARCHAR, app_apple_id VARCHAR,
  event VARCHAR, download_type VARCHAR, app_version VARCHAR, device VARCHAR, platform_version VARCHAR,
  source_type VARCHAR, page_type VARCHAR, app_download_date DATE, territory VARCHAR,
  counts DOUBLE, unique_devices DOUBLE
);
COMMENT ON TABLE appstore.analytics_installs IS 'Apple App Analytics "App Store Installation and Deletion": installs and deletions (event) per day, from opted-in users. counts is additive; unique_devices is not.';
COMMENT ON COLUMN appstore.analytics_installs.access_type IS 'Apple report type: ONE_TIME_SNAPSHOT rows are the historical backfill through 2026-09-21, ONGOING rows are the daily reports from 2026-09-22 on. The two never overlap by date, so SUM across both.';

CREATE TABLE IF NOT EXISTS appstore.analytics_purchases (
  access_type VARCHAR, instance_id VARCHAR, processing_date DATE,
  date DATE, app_name VARCHAR, app_apple_id VARCHAR,
  purchase_type VARCHAR, content_name VARCHAR, content_apple_id VARCHAR, payment_method VARCHAR,
  device VARCHAR, platform_version VARCHAR, source_type VARCHAR, page_type VARCHAR,
  app_download_date DATE, pre_order VARCHAR, territory VARCHAR,
  purchases DOUBLE, proceeds_usd DOUBLE, sales_usd DOUBLE, paying_users DOUBLE
);
COMMENT ON TABLE appstore.analytics_purchases IS 'Apple App Analytics "App Store Purchases": in-app purchases and paid downloads per day with the acquisition source of the buyer, USD. purchases, proceeds_usd, sales_usd are additive; paying_users is not.';
COMMENT ON COLUMN appstore.analytics_purchases.access_type IS 'Apple report type: ONE_TIME_SNAPSHOT rows are the historical backfill through 2026-09-21, ONGOING rows are the daily reports from 2026-09-22 on. The two never overlap by date, so SUM across both.';

CREATE TABLE IF NOT EXISTS appstore.analytics_crashes (
  access_type VARCHAR, instance_id VARCHAR, processing_date DATE,
  date DATE, app_name VARCHAR, app_apple_id VARCHAR,
  app_version VARCHAR, device VARCHAR, platform_version VARCHAR,
  crashes DOUBLE, unique_devices DOUBLE
);
COMMENT ON TABLE appstore.analytics_crashes IS 'Apple App Analytics "App Crashes" per day x app version x device x OS version, from opted-in users. crashes is additive; unique_devices is not.';
COMMENT ON COLUMN appstore.analytics_crashes.access_type IS 'Apple report type: ONE_TIME_SNAPSHOT rows are the historical backfill through 2026-09-21, ONGOING rows are the daily reports from 2026-09-22 on. The two never overlap by date, so SUM across both.';

-- revenuecat ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS revenuecat.projects (
  app VARCHAR PRIMARY KEY,
  project_id VARCHAR,
  name VARCHAR
);
COMMENT ON TABLE revenuecat.projects IS 'RevenueCat projects, one per app slug (babylab, celebs, ...).';

CREATE TABLE IF NOT EXISTS revenuecat.chart_points (
  app VARCHAR,
  chart VARCHAR,
  segment_by VARCHAR,
  segment VARCHAR,
  date DATE,
  measure VARCHAR,
  value DOUBLE,
  incomplete BOOLEAN
);
COMMENT ON TABLE revenuecat.chart_points IS 'RevenueCat Charts API, daily resolution, money in USD. Long format: filter by chart AND measure. segment_by = '''' means the unsegmented total (segment = ''Total''); otherwise one row per segment value with ''Other'' for the top-50 long tail; segmented rows with value 0 are omitted. Segments: revenue by country/store, actives by first_country/store, trials_new by country/store, customers_new by country/platform. Never add segmented rows to the total. incomplete = period still in progress. Stock charts (mrr, arr, actives, trials) are point-in-time: do not SUM across dates.';
COMMENT ON COLUMN revenuecat.chart_points.chart IS 'revenue, mrr, arr, actives, actives_new, trials, trials_new, churn, customers_new, refunds, non_subscription_purchases, customers_active, mrr_movement, refund_rate, conversion_to_paying, trial_conversion_rate, ltv_per_customer, ltv_per_paying_customer. The last four are by customer first-seen or trial-start date and keep maturing for up to 30 days.';
COMMENT ON COLUMN revenuecat.chart_points.measure IS 'snake_case measure name, e.g. revenue/transactions (revenue), mrr, actives, new_trials, new_customers, churn_rate/churned_actives (churn), refunded_revenue';

CREATE TABLE IF NOT EXISTS revenuecat.overview (
  snapshot_date DATE,
  app VARCHAR,
  metric VARCHAR,
  name VARCHAR,
  value DOUBLE,
  unit VARCHAR,
  period VARCHAR
);
COMMENT ON TABLE revenuecat.overview IS 'Daily snapshot of the RevenueCat overview endpoint (active trials, active subscriptions, MRR, revenue last 28d, new customers, active users) as of snapshot_date (UTC).';

CREATE TABLE IF NOT EXISTS revenuecat.cohort_points (
  app VARCHAR,
  chart VARCHAR,
  cohort_date DATE,
  cohort_label VARCHAR,
  period INTEGER,
  period_name VARCHAR,
  value DOUBLE
);
COMMENT ON TABLE revenuecat.cohort_points IS 'RevenueCat cohort charts, full history re-pulled every sync. cohort_explorer: per first-seen day cohort, period 0 = new customers, then revenue in USD for Month 0, Month 1, ... after first seen. subscription_retention: subscriptions retained by period. cohort_label is set instead of cohort_date for aggregate rows such as Total.';
COMMENT ON COLUMN revenuecat.cohort_points.period_name IS 'Display name of the period, e.g. New customers, Month 0, Month 1';

-- core ---------------------------------------------------------------------

CREATE OR REPLACE VIEW core.apps AS
WITH j AS (
  SELECT *, lower(regexp_replace(name, '[^A-Za-z0-9]+', '', 'g')) AS app_key
  FROM adjust.apps
),
a AS (
  SELECT *,
    trim(regexp_extract(name, '^(.*?)((\s*[:|]|\s+[-–—])\s+.*)?$', 1)) AS short_name,
    lower(regexp_replace(regexp_extract(name, '^(.*?)((\s*[:|]|\s+[-–—])\s+.*)?$', 1), '[^A-Za-z0-9]+', '', 'g')) AS app_key
  FROM appstore.apps
),
matched AS (
  SELECT
    coalesce(j.app_key, a.app_key) AS app_key,
    coalesce(j.name, a.short_name) AS name,
    j.app_token AS adjust_token,
    coalesce(a.apple_id, j.ios_store_id) AS apple_id,
    a.name AS app_store_name,
    a.bundle_id,
    a.sku,
    j.android_store_id,
    r.app AS rc_app,
    r.project_id AS rc_project_id
  FROM j
  FULL OUTER JOIN a ON a.apple_id = j.ios_store_id OR (j.ios_store_id IS NULL AND a.app_key = j.app_key)
  LEFT JOIN revenuecat.projects r ON r.app = coalesce(j.app_key, a.app_key)
)
SELECT
  CASE
    WHEN adjust_token IS NULL AND count(*) OVER (PARTITION BY app_key) > 1 THEN app_key || '_' || apple_id
    ELSE app_key
  END AS app_id,
  * EXCLUDE (app_key)
FROM matched;
COMMENT ON VIEW core.apps IS 'Cross-vendor app identity: app_id plus the Adjust token, Apple id/sku, and RevenueCat slug for each app. Adjust is matched to Apple by store id (from Adjust installs), falling back to normalized app name.';

CREATE OR REPLACE VIEW core.app_daily AS
WITH adj AS (
  SELECT a.app_id, d.date,
    sum(d.installs) AS installs,
    sum(d.cost) AS ad_spend,
    sum(d.ad_revenue) AS ad_revenue,
    sum(d.iap_revenue) AS adjust_iap_revenue,
    sum(d.sessions) AS sessions
  FROM adjust.daily d JOIN core.apps a ON a.adjust_token = d.app_token
  GROUP BY ALL
),
dau AS (
  SELECT a.app_id, d.date, d.daus
  FROM adjust.app_daily d JOIN core.apps a ON a.adjust_token = d.app_token
),
rc AS (
  SELECT a.app_id, p.date,
    sum(p.value) FILTER (WHERE p.chart = 'revenue' AND p.measure = 'revenue') AS rc_revenue,
    sum(p.value) FILTER (WHERE p.chart = 'mrr' AND p.measure = 'mrr') AS mrr,
    sum(p.value) FILTER (WHERE p.chart = 'actives' AND p.measure = 'actives') AS active_subscriptions,
    sum(p.value) FILTER (WHERE p.chart = 'trials_new' AND p.measure = 'new_trials') AS new_trials,
    sum(p.value) FILTER (WHERE p.chart = 'customers_new' AND p.measure = 'new_customers') AS new_customers
  FROM revenuecat.chart_points p JOIN core.apps a ON a.rc_app = p.app
  WHERE p.segment_by = ''
  GROUP BY ALL
),
asc_sales AS (
  SELECT a.app_id, s.report_date AS date,
    sum(s.units) FILTER (WHERE s.product_type IN ('1', '1F', '1T', 'F1')) AS app_store_downloads
  FROM appstore.sales s JOIN core.apps a ON a.apple_id = s.apple_id
  GROUP BY ALL
)
SELECT app_id, date,
  sum(installs) AS installs,
  sum(app_store_downloads) AS app_store_downloads,
  sum(ad_spend) AS ad_spend,
  sum(rc_revenue) AS rc_revenue,
  sum(ad_revenue) AS ad_revenue,
  sum(adjust_iap_revenue) AS adjust_iap_revenue,
  sum(mrr) AS mrr,
  sum(active_subscriptions) AS active_subscriptions,
  sum(new_trials) AS new_trials,
  sum(new_customers) AS new_customers,
  sum(daus) AS daus,
  sum(sessions) AS sessions
FROM (
  SELECT * FROM adj
  UNION ALL BY NAME SELECT * FROM dau
  UNION ALL BY NAME SELECT * FROM rc
  UNION ALL BY NAME SELECT * FROM asc_sales
)
GROUP BY ALL;
COMMENT ON VIEW core.app_daily IS 'One row per app_id x date joining all vendors. installs/ad_spend/ad_revenue/daus from Adjust (UTC, USD); rc_revenue/mrr/active_subscriptions/new_trials/new_customers from RevenueCat (UTC, USD, gross revenue minus refunds); app_store_downloads from Apple (Pacific day). mrr, active_subscriptions, daus are point-in-time: do not SUM across dates.';

CREATE OR REPLACE VIEW meta.coverage AS
SELECT 'adjust.daily' AS table_name, min(date) AS first_date, max(date) AS last_date, count(*) AS row_count FROM adjust.daily
UNION ALL SELECT 'adjust.cohorts', min(date), max(date), count(*) FROM adjust.cohorts
UNION ALL SELECT 'adjust.app_daily', min(date), max(date), count(*) FROM adjust.app_daily
UNION ALL SELECT 'appstore.sales', min(report_date), max(report_date), count(*) FROM appstore.sales
UNION ALL SELECT 'appstore.subscriptions', min(report_date), max(report_date), count(*) FROM appstore.subscriptions
UNION ALL SELECT 'appstore.subscription_events', min(report_date), max(report_date), count(*) FROM appstore.subscription_events
UNION ALL SELECT 'revenuecat.chart_points', min(date), max(date), count(*) FROM revenuecat.chart_points
UNION ALL SELECT 'revenuecat.overview', min(snapshot_date), max(snapshot_date), count(*) FROM revenuecat.overview
UNION ALL SELECT 'revenuecat.cohort_points', min(cohort_date), max(cohort_date), count(*) FROM revenuecat.cohort_points
UNION ALL SELECT 'adjust.retention', min(date), max(date), count(*) FROM adjust.retention
UNION ALL SELECT 'adjust.skan', min(date), max(date), count(*) FROM adjust.skan
UNION ALL SELECT 'adjust.creatives', min(date), max(date), count(*) FROM adjust.creatives
UNION ALL SELECT 'appstore.subscriber_events', min(report_date), max(report_date), count(*) FROM appstore.subscriber_events
UNION ALL SELECT 'appstore.sales_yearly', make_date(min(report_year), 1, 1), make_date(max(report_year), 12, 31), count(*) FROM appstore.sales_yearly
UNION ALL SELECT 'appstore.reviews', min(created_at)::DATE, max(created_at)::DATE, count(*) FROM appstore.reviews
UNION ALL SELECT 'appstore.analytics_downloads', min(date), max(date), count(*) FROM appstore.analytics_downloads
UNION ALL SELECT 'appstore.analytics_engagement', min(date), max(date), count(*) FROM appstore.analytics_engagement
UNION ALL SELECT 'appstore.analytics_sessions', min(date), max(date), count(*) FROM appstore.analytics_sessions
UNION ALL SELECT 'appstore.analytics_installs', min(date), max(date), count(*) FROM appstore.analytics_installs
UNION ALL SELECT 'appstore.analytics_purchases', min(date), max(date), count(*) FROM appstore.analytics_purchases
UNION ALL SELECT 'appstore.analytics_crashes', min(date), max(date), count(*) FROM appstore.analytics_crashes;
COMMENT ON VIEW meta.coverage IS 'Date range and row count per table.';

CREATE OR REPLACE VIEW meta.freshness AS
SELECT source, last_ok_at, status AS last_status, error AS last_error
FROM (
  SELECT *, max(finished_at) FILTER (WHERE status = 'ok') OVER (PARTITION BY source) AS last_ok_at
  FROM meta.sync_runs
)
QUALIFY row_number() OVER (PARTITION BY source ORDER BY started_at DESC) = 1;
COMMENT ON VIEW meta.freshness IS 'Last successful sync per source and the status of the most recent attempt.';
