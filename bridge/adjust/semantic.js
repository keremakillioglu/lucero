import { join } from 'node:path';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { WAREHOUSE_DIR } from './warehouse.js';

/** Built by bridge/semantic/build.py: one Apache Ossie dataset per warehouse table, FTS5-indexed */
const INDEX_PATH = join(WAREHOUSE_DIR, 'semantic', 'semantic.sqlite');
/** BM25 column weights: source, synonyms, description, instructions, fields */
const BM25_WEIGHTS = '4, 8, 3, 2, 2';
const TOKEN = /[\p{L}\p{N}]+/gu;
const DESCRIPTION_LIMIT = 400;
const COLUMN_PREVIEW = 40;

let index = null;

/** Opens the index read-only, reopening it after each rebuild (the build swaps the file atomically) */
function openIndex() {
  const stat = statSync(INDEX_PATH, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error('The semantic layer has not been built yet (run bridge/semantic/build.py).');
  }
  const { mtimeMs } = stat;
  if (index?.mtimeMs === mtimeMs) return index.db;
  index?.db.close();
  index = { mtimeMs, db: new DatabaseSync(INDEX_PATH, { readOnly: true }) };
  return index.db;
}

const toMatch = (query) =>
  [...new Set(query.toLowerCase().match(TOKEN) ?? [])].map((token) => `"${token}"`).join(' OR ');

const truncate = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** Ranks warehouse tables for a natural-language query by their Ossie metadata */
export function searchModels(query, limit) {
  const match = toMatch(query);
  if (!match) return [];
  const rows = openIndex()
    .prepare(
      `SELECT m.source, m.doc_json, bm25(fts, ${BM25_WEIGHTS}) AS score
       FROM fts JOIN models m ON m.id = fts.rowid
       WHERE fts MATCH ? ORDER BY score LIMIT ?`,
    )
    .all(match, limit);
  return rows.map(({ source, doc_json }) => {
    const { dataset } = JSON.parse(doc_json);
    const context = typeof dataset.ai_context === 'object' ? dataset.ai_context : {};
    return {
      table: source,
      description: truncate(dataset.description ?? '', DESCRIPTION_LIMIT),
      synonyms: context.synonyms ?? [],
      instructions: context.instructions,
      columns: (dataset.fields ?? []).slice(0, COLUMN_PREVIEW).map((field) => field.name),
    };
  });
}

/** Full Ossie dataset (fields with types, descriptions, synonyms) plus its relationships */
export function getModel(table) {
  const row = openIndex().prepare('SELECT doc_json FROM models WHERE source = ?').get(table);
  if (!row) throw new Error(`No semantic model for "${table}". Use search_models.`);
  return JSON.parse(row.doc_json);
}
