import jwt from 'jsonwebtoken';
import { gunzipSync } from 'node:zlib';

export const ADJUST_TOKEN = process.env.ADJUST_API;
export const RC_KEYS = Object.fromEntries(
  Object.entries(process.env)
    .filter(([key, value]) => /^RC_[A-Z0-9]+$/.test(key) && value)
    .map(([key, value]) => [key.slice(3).toLowerCase(), value]),
);
export const RC_APPS = Object.keys(RC_KEYS).sort();
export const ASC_KEY = process.env.APP_STORE_CONNECT_SALES;
export const ASC_KEY_ID = process.env.APP_STORE_CONNECT_KEY_ID;
export const ASC_ISSUER_ID = process.env.APP_STORE_CONNECT_ISSUER_ID;
export const ASC_VENDOR = process.env.APP_STORE_CONNECT_VENDOR_NUMBER;
export const ASC_ENABLED = Boolean(ASC_KEY && ASC_KEY_ID && ASC_ISSUER_ID);

const BASE = 'https://automate.adjust.com/reports-service';
const RC_BASE = 'https://api.revenuecat.com/v2';
const ASC_BASE = 'https://api.appstoreconnect.apple.com/v1';
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUrl(base, params = {}) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

/** Fetches with retries on network errors, rate limits and transient 5xx, honoring Retry-After */
async function request(label, url, headers) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (res.ok) return res;
    if (!RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) {
      const text = await res.text();
      throw Object.assign(new Error(`${label} API ${res.status}: ${text.slice(0, 600)}`), { status: res.status });
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
  }
}

export async function adjustGet(path, params) {
  const res = await request('Adjust', buildUrl(`${BASE}/${path}`, params), {
    Authorization: `Bearer ${ADJUST_TOKEN}`,
  });
  return res.text();
}

export async function rcGet(app, path, params = {}) {
  const token = RC_KEYS[app];
  if (!token) {
    throw new Error(`Unknown RevenueCat app "${app}". Available: ${RC_APPS.join(', ')}`);
  }
  const res = await request('RevenueCat', buildUrl(`${RC_BASE}${path}`, params), {
    Authorization: `Bearer ${token}`,
  });
  return res.text();
}

const rcProjects = new Map();

export async function rcProject(app) {
  if (rcProjects.has(app)) return rcProjects.get(app);
  const { items } = JSON.parse(await rcGet(app, '/projects'));
  const project = items[0];
  if (!project?.id) throw new Error(`No RevenueCat project visible to the "${app}" API key`);
  rcProjects.set(app, project);
  return project;
}

function ascJwt() {
  const pem = `-----BEGIN PRIVATE KEY-----\n${ASC_KEY.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
  return jwt.sign({ aud: 'appstoreconnect-v1' }, pem, {
    algorithm: 'ES256',
    issuer: ASC_ISSUER_ID,
    keyid: ASC_KEY_ID,
    expiresIn: '10m',
  });
}

/** Returns the gzipped report body as delivered by Apple */
export async function ascGetGzip(path, params = {}) {
  const res = await request('App Store Connect', buildUrl(`${ASC_BASE}${path}`, params), {
    Authorization: `Bearer ${ascJwt()}`,
    Accept: 'application/a-gzip',
  });
  return Buffer.from(await res.arrayBuffer());
}

export async function ascGet(path, params = {}, raw = false) {
  if (raw) return gunzipSync(await ascGetGzip(path, params)).toString('utf8');
  return ascGetUrl(buildUrl(`${ASC_BASE}${path}`, params));
}

async function ascGetUrl(url) {
  const res = await request('App Store Connect', url, { Authorization: `Bearer ${ascJwt()}` });
  return res.text();
}

/** Collects `data` across every page of an App Store Connect list endpoint, stopping early when `until(item)` is true */
export async function ascList(path, params = {}, until = () => false) {
  const items = [];
  let url = buildUrl(`${ASC_BASE}${path}`, params);
  while (url) {
    const page = JSON.parse(await ascGetUrl(url));
    const stopAt = page.data.findIndex(until);
    items.push(...(stopAt === -1 ? page.data : page.data.slice(0, stopAt)));
    url = stopAt === -1 ? page.links?.next : null;
  }
  return items;
}

/** Downloads a pre-signed App Store Connect report segment (no auth header) */
export async function ascDownload(url) {
  const res = await request('App Store Connect download', url, {});
  return Buffer.from(await res.arrayBuffer());
}

/** Latest Sales and Trends report format version per report type (SALES takes none) */
const REPORT_VERSIONS = { SUBSCRIPTION: '1_4', SUBSCRIPTION_EVENT: '1_4', SUBSCRIBER: '1_3' };

export function salesReportParams(reportType, frequency, reportDate, vendor) {
  return {
    'filter[frequency]': frequency,
    'filter[reportType]': reportType,
    'filter[reportSubType]': reportType === 'SUBSCRIBER' ? 'DETAILED' : 'SUMMARY',
    'filter[reportDate]': reportDate,
    'filter[vendorNumber]': vendor,
    ...(REPORT_VERSIONS[reportType] ? { 'filter[version]': REPORT_VERSIONS[reportType] } : {}),
  };
}
