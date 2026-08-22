import type { MCPServer } from 'librechat-data-provider';

export type CellValue = string | number | boolean | null;
export type DataRow = Record<string, CellValue>;

export type Dataset = {
  path: string;
  rows: DataRow[];
};

export type TableData = {
  rows: DataRow[];
  columns: string[];
  numericColumns: string[];
  xKey: string | null;
  yKeys: string[];
};

export type ViewDisplay = 'auto' | 'line' | 'bar' | 'table' | 'json';

export type ViewConfig = {
  id: string;
  serverName: string;
  toolName: string;
  argsText: string;
  display: ViewDisplay;
  title?: string;
  datasetPath?: string;
  xKey?: string;
  yKeys?: string[];
};

export const MAX_SERIES = 8;
const MAX_DATASETS = 8;
const MAX_SCAN_DEPTH = 5;
const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/;
const TIME_KEY_PATTERN = /date|day|time|month|week|year|period/i;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toCell = (value: unknown): CellValue => {
  if (value == null) {
    return null;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
};

const toRows = (rawRows: Record<string, unknown>[]): DataRow[] =>
  rawRows.map((raw) => {
    const row: DataRow = {};
    for (const [key, value] of Object.entries(raw)) {
      row[key] = toCell(value);
    }
    return row;
  });

function collectDatasets(value: unknown, path: string, depth: number, found: Dataset[]): void {
  if (found.length >= MAX_DATASETS || depth > MAX_SCAN_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    const objects = value.filter(isPlainObject);
    if (objects.length > 0) {
      found.push({ path, rows: toRows(objects) });
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectDatasets(child, path === '$' ? `$.${key}` : `${path}.${key}`, depth + 1, found);
  }
}

/** Parses a tool result string and extracts every array of objects as a selectable dataset */
export function extractDatasets(resultText: string): Dataset[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return [];
  }
  const found: Dataset[] = [];
  collectDatasets(parsed, '$', 0, found);
  return found;
}

export const toNumber = (value: CellValue): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && NUMERIC_PATTERN.test(value.trim())) {
    return Number(value);
  }
  return null;
};

const isNumericColumn = (rows: DataRow[], column: string): boolean => {
  let present = 0;
  let numeric = 0;
  for (const row of rows) {
    const value = row[column];
    if (value == null || value === '') {
      continue;
    }
    present += 1;
    if (toNumber(value) != null) {
      numeric += 1;
    }
  }
  return present > 0 && numeric / present >= 0.8;
};

export function isTimeLike(rows: DataRow[], xKey: string | null): boolean {
  if (!xKey) {
    return false;
  }
  if (TIME_KEY_PATTERN.test(xKey)) {
    return true;
  }
  const sample = rows.find((row) => typeof row[xKey] === 'string')?.[xKey];
  return typeof sample === 'string' && !Number.isNaN(Date.parse(sample));
}

/** Builds chart metadata from rows, honoring user-selected axes when provided */
export function buildTable(rows: DataRow[], xOverride?: string, yOverride?: string[]): TableData {
  const columnSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columnSet.add(key);
    }
  }
  const columns = [...columnSet];
  const numericColumns = columns.filter((column) => isNumericColumn(rows, column));
  const labelColumns = columns.filter((column) => !numericColumns.includes(column));
  const timeColumn = labelColumns.find((column) => isTimeLike(rows, column));
  const autoX = timeColumn ?? labelColumns[0] ?? columns[0] ?? null;
  const xKey = xOverride != null && columns.includes(xOverride) ? xOverride : autoX;

  const validOverrides = yOverride?.filter((column) => numericColumns.includes(column));
  const autoY = numericColumns.filter((column) => column !== xKey);
  const yKeys = (validOverrides?.length ? validOverrides : autoY).slice(0, MAX_SERIES);

  return { rows, columns, numericColumns, xKey, yKeys };
}

export const formatCompact = (value: number): string =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

export const createViewConfig = (servers: Array<[string, MCPServer]>): ViewConfig => {
  const [serverName, server] = servers[0] ?? ['', undefined];
  return {
    id: crypto.randomUUID(),
    serverName,
    toolName: server?.tools[0]?.name ?? '',
    argsText: '{}',
    display: 'auto',
  };
};
