import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { DuckDBInstance, DuckDBTypeId } from '@duckdb/node-api';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

export const WAREHOUSE_DIR = process.env.WAREHOUSE_DIR || '/var/lib/lucero';
export const RAW_DIR = join(WAREHOUSE_DIR, 'raw');
const DB_PATH = join(WAREHOUSE_DIR, 'warehouse.duckdb');
export const READ_PATH = join(WAREHOUSE_DIR, 'warehouse.read.duckdb');
const SCHEMA_PATH = new URL('./schema.sql', import.meta.url);
const RETIRE_DELAY_MS = 120_000;

/** Locked-down settings: read-only, no file/network access, settings cannot be changed by queries */
const READ_CONFIG = {
  access_mode: 'READ_ONLY',
  enable_external_access: 'false',
  autoload_known_extensions: 'false',
  autoinstall_known_extensions: 'false',
  memory_limit: '1GB',
  threads: '2',
  lock_configuration: 'true',
};

export const lit = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** Writes a vendor response under raw/ (gzipping unless already gzipped) and returns its path */
export function saveRaw(relPath, body, { gzipped = false } = {}) {
  const path = join(RAW_DIR, `${relPath}.gz`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipped ? body : gzipSync(body));
  return path;
}

export async function openWriter() {
  mkdirSync(WAREHOUSE_DIR, { recursive: true });
  const instance = await DuckDBInstance.create(DB_PATH);
  const conn = await instance.connect();
  await conn.run(readFileSync(SCHEMA_PATH, 'utf8'));
  return { instance, conn };
}

export async function inTransaction(conn, fn) {
  await conn.run('BEGIN TRANSACTION');
  try {
    const result = await fn();
    await conn.run('COMMIT');
    return result;
  } catch (err) {
    await conn.run('ROLLBACK');
    throw err;
  }
}

/** Multi-row parameterized insert for small reference tables */
export async function insertRows(conn, table, columns, rows) {
  if (rows.length === 0) return;
  const width = columns.length;
  const tuples = rows.map((_, i) => `(${columns.map((__, j) => `$${i * width + j + 1}`).join(', ')})`);
  const values = rows.flatMap((row) => columns.map((column) => row[column] ?? null));
  await conn.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, values);
}

/** Writes a compacted copy of the warehouse and atomically swaps it in for readers */
export async function publish(conn) {
  const tmp = `${READ_PATH}.tmp`;
  rmSync(tmp, { force: true });
  await conn.run(`ATTACH ${lit(tmp)} AS pub; COPY FROM DATABASE warehouse TO pub; DETACH pub;`);
  renameSync(tmp, READ_PATH);
}

let reader = null;

/** Returns a read-only instance of the published copy, reopening it after each publish */
async function readerInstance() {
  const { mtimeMs } = statSync(READ_PATH);
  if (reader?.mtimeMs === mtimeMs) return reader.ready;
  const previous = reader;
  reader = { mtimeMs, ready: DuckDBInstance.create(READ_PATH, READ_CONFIG) };
  if (previous) {
    setTimeout(() => previous.ready.then((instance) => instance.closeSync()).catch(() => {}), RETIRE_DELAY_MS).unref();
  }
  return reader.ready;
}

/** Types the JSON reader renders as strings to stay lossless; charts and models want numbers */
const WIDE_INTEGER_TYPES = new Set([
  DuckDBTypeId.BIGINT,
  DuckDBTypeId.UBIGINT,
  DuckDBTypeId.HUGEINT,
  DuckDBTypeId.UHUGEINT,
]);
const NUMERIC_TEXT_TYPES = new Set([...WIDE_INTEGER_TYPES, DuckDBTypeId.DECIMAL]);

/** Parses a numeric string unless the value would lose precision as a JS number */
const toNumber = (value, integer) => {
  if (typeof value !== 'string') return value;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number))) return value;
  return number;
};

/** Columns whose JSON values are numeric strings, with whether they hold integers */
const numericTextColumns = (result) =>
  result.columnNames().flatMap((name, i) => {
    const typeId = result.columnTypeId(i);
    return NUMERIC_TEXT_TYPES.has(typeId) ? [[name, WIDE_INTEGER_TYPES.has(typeId)]] : [];
  });

const withNumbers = (row, columns) => {
  const next = { ...row };
  for (const [name, integer] of columns) next[name] = toNumber(row[name], integer);
  return next;
};

export async function runQuery(sql, { maxRows = 200, timeoutMs = 30_000 } = {}) {
  const instance = await readerInstance();
  const conn = await instance.connect();
  const timer = setTimeout(() => conn.interrupt(), timeoutMs);
  try {
    const result = await conn.streamAndReadUntil(sql, maxRows + 1);
    const rows = result.getRowObjectsJson();
    const numeric = numericTextColumns(result);
    result.closeSync();
    return {
      columns: result.columnNames(),
      rows: rows.slice(0, maxRows).map((row) => (numeric.length ? withNumbers(row, numeric) : row)),
      truncated: rows.length > maxRows || !result.done,
    };
  } finally {
    clearTimeout(timer);
    conn.closeSync();
  }
}
