"""
Build the Lucero semantic layer: one Apache Ossie model of the warehouse plus a search index.

  1. Read tables, views, columns, comments and primary keys from the published read copy
     (warehouse.read.duckdb, opened read-only).
  2. Layer the curated context.yaml on top: synonyms, caveats, field descriptions, unique keys
     and relationships. No KPI formulas: metric definitions are owned by the business.
  3. Build an `ossie.OssieDocument` and run the official validator (validation/validate.py at the
     pinned Ossie commit): JSON Schema, unique names, references, arity, SQL syntax.
  4. Write <out>/lucero.ossie.yaml and <out>/semantic.sqlite, an FTS5 (BM25) index with one row per
     dataset, following Vesper's Ossie baseline (baselines/ossie/build_lakeqa.py).

The index is written to a temp file and renamed, so readers never see a partial build.

Usage: .venv/bin/python build.py [--warehouse PATH] [--out DIR]
"""

import argparse
import importlib.util
import json
import os
import sqlite3
import sys
from pathlib import Path

import duckdb
import yaml
from ossie import (
    OssieAIContextObject,
    OssieDataset,
    OssieDataType,
    OssieDialect,
    OssieDialectExpression,
    OssieDimension,
    OssieDocument,
    OssieExpression,
    OssieField,
    OssieRelationship,
)

WAREHOUSE_DIR = Path(os.environ.get("WAREHOUSE_DIR", "/var/lib/lucero"))
HERE = Path(__file__).resolve().parent
SCHEMAS = ("core", "adjust", "appstore", "revenuecat", "meta")
NUMERIC = {OssieDataType.INTEGER, OssieDataType.DECIMAL, OssieDataType.FLOAT}
DATASET_KEYS = {"synonyms", "instructions", "fields", "primary_key", "unique_keys"}
FIELD_KEYS = {"synonyms", "description"}

TYPE_MAP = {
    "VARCHAR": OssieDataType.STRING,
    "BOOLEAN": OssieDataType.BOOLEAN,
    "DATE": OssieDataType.DATE,
    "TIME": OssieDataType.TIME,
    "TIMESTAMP": OssieDataType.DATE_TIME,
    "TIMESTAMP WITH TIME ZONE": OssieDataType.DATE_TIME_TZ,
    "DOUBLE": OssieDataType.FLOAT,
    "FLOAT": OssieDataType.FLOAT,
    "TINYINT": OssieDataType.INTEGER,
    "SMALLINT": OssieDataType.INTEGER,
    "INTEGER": OssieDataType.INTEGER,
    "BIGINT": OssieDataType.INTEGER,
    "HUGEINT": OssieDataType.INTEGER,
    "UTINYINT": OssieDataType.INTEGER,
    "USMALLINT": OssieDataType.INTEGER,
    "UINTEGER": OssieDataType.INTEGER,
    "UBIGINT": OssieDataType.INTEGER,
}


def ossie_type(duck_type: str) -> OssieDataType:
    if duck_type.startswith("DECIMAL"):
        return OssieDataType.DECIMAL
    return TYPE_MAP.get(duck_type, OssieDataType.OPAQUE)


def dataset_name(table: str) -> str:
    """Ossie names stay single-part (model-scoped references use dataset.field)."""
    return table.replace(".", "_")


def quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def ai_context(synonyms=None, instructions=None):
    if not synonyms and not instructions:
        return None
    return OssieAIContextObject(
        synonyms=tuple(synonyms) if synonyms else None,
        instructions=" ".join(instructions.split()) if instructions else None,
    )


def read_catalog(warehouse: Path):
    con = duckdb.connect(str(warehouse), read_only=True)
    schemas = ", ".join(f"'{s}'" for s in SCHEMAS)
    objects = con.execute(
        f"""SELECT schema_name || '.' || table_name, comment FROM duckdb_tables() WHERE schema_name IN ({schemas})
            UNION ALL
            SELECT schema_name || '.' || view_name, comment FROM duckdb_views()
            WHERE NOT internal AND schema_name IN ({schemas})
            ORDER BY 1"""
    ).fetchall()
    columns = {}
    for table, name, dtype, comment in con.execute(
        f"""SELECT schema_name || '.' || table_name, column_name, data_type, comment FROM duckdb_columns()
            WHERE schema_name IN ({schemas}) ORDER BY schema_name, table_name, column_index"""
    ).fetchall():
        columns.setdefault(table, []).append((name, dtype, comment))
    primary_keys = {
        table: list(cols)
        for table, cols in con.execute(
            f"""SELECT schema_name || '.' || table_name, constraint_column_names FROM duckdb_constraints()
                WHERE constraint_type = 'PRIMARY KEY' AND schema_name IN ({schemas})"""
        ).fetchall()
    }
    con.close()
    return objects, columns, primary_keys


def build_field(name, dtype, comment, curated):
    datatype = ossie_type(dtype)
    return OssieField(
        name=name,
        expression=OssieExpression(
            dialects=[OssieDialectExpression(dialect=OssieDialect.ANSI_SQL, expression=quote(name))]
        ),
        datatype=datatype,
        dimension=None if datatype in NUMERIC else OssieDimension(),
        description=curated.get("description") or comment,
        ai_context=ai_context(curated.get("synonyms")),
    )


def check_context_keys(curated_sets) -> list[str]:
    """Unknown keys usually mean a YAML slip (e.g. an unquoted comma inside `{ ... }`)."""
    errors = []
    for table, curated in curated_sets.items():
        curated = curated or {}
        errors += [f"{table}: unknown key {key!r}" for key in sorted(set(curated) - DATASET_KEYS)]
        for field, spec in (curated.get("fields") or {}).items():
            errors += [f"{table}.{field}: unknown key {key!r}" for key in sorted(set(spec or {}) - FIELD_KEYS)]
    return errors


def build_document(objects, columns, primary_keys, context, warnings):
    curated_sets = context.get("datasets", {})
    known = {table for table, _ in objects}
    for table in sorted(set(curated_sets) - known):
        warnings.append(f"context.yaml describes {table}, which is not in the warehouse")

    datasets = []
    for table, comment in objects:
        curated = curated_sets.get(table) or {}
        curated_fields = curated.get("fields") or {}
        table_columns = columns.get(table, [])
        names = {name for name, _, _ in table_columns}
        for field in sorted(set(curated_fields) - names):
            warnings.append(f"context.yaml describes {table}.{field}, which is not a column")
        datasets.append(
            OssieDataset(
                name=dataset_name(table),
                source=table,
                primary_key=primary_keys.get(table) or curated.get("primary_key"),
                unique_keys=curated.get("unique_keys"),
                description=comment,
                ai_context=ai_context(curated.get("synonyms"), curated.get("instructions")),
                fields=[
                    build_field(name, dtype, col_comment, curated_fields.get(name) or {})
                    for name, dtype, col_comment in table_columns
                ],
            )
        )

    relationships = []
    for from_table, from_columns, to_table, to_columns in context.get("relationships", []):
        if from_table not in known or to_table not in known:
            warnings.append(f"skipped relationship {from_table} -> {to_table}: table missing")
            continue
        relationships.append(
            OssieRelationship(
                name=f"{dataset_name(from_table)}__{dataset_name(to_table)}",
                from_dataset=dataset_name(from_table),
                to=dataset_name(to_table),
                from_columns=from_columns,
                to_columns=to_columns,
            )
        )

    model = context["model"]
    return OssieDocument(
        name=model["name"],
        description=" ".join(model["description"].split()),
        ai_context=ai_context(instructions=model.get("instructions")),
        datasets=datasets,
        relationships=relationships,
    )


def official_validate(document: OssieDocument) -> list[str]:
    """Runs validation/validate.py from the pinned Ossie checkout on the serialized document."""
    ossie_dir = WAREHOUSE_DIR / "semantic" / "ossie-src"
    spec = importlib.util.spec_from_file_location("ossie_validate", ossie_dir / "validation" / "validate.py")
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    schema = json.loads((ossie_dir / "core-spec" / "ossie-schema.json").read_text())
    data = yaml.safe_load(document.to_ossie_yaml())
    return validator.validate_document(data, schema)


def search_row(dataset: OssieDataset, relationships):
    context = dataset.ai_context if isinstance(dataset.ai_context, OssieAIContextObject) else None
    field_text = " ".join(
        " ".join(
            filter(
                None,
                [
                    f.name,
                    f.description,
                    " ".join(f.ai_context.synonyms or ())
                    if isinstance(f.ai_context, OssieAIContextObject)
                    else None,
                ],
            )
        )
        for f in dataset.fields or []
    )
    related = [r for r in relationships if dataset.name in (r.from_dataset, r.to)]
    doc = {
        "dataset": dataset.model_dump(mode="json", by_alias=True, exclude_none=True),
        "relationships": [r.model_dump(mode="json", by_alias=True, exclude_none=True) for r in related],
    }
    return (
        dataset.source,
        dataset.name,
        " ".join(context.synonyms or ()) if context else "",
        dataset.description or "",
        (context.instructions or "") if context else "",
        field_text,
        json.dumps(doc),
    )


def write_index(document: OssieDocument, path: Path):
    tmp = path.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript(
        """CREATE TABLE models (id INTEGER PRIMARY KEY, source TEXT UNIQUE, name TEXT, doc_json TEXT);
           CREATE VIRTUAL TABLE fts USING fts5(source, synonyms, description, instructions, fields,
             tokenize = 'porter unicode61');
           CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);"""
    )
    relationships = document.relationships or []
    for id_, dataset in enumerate(document.datasets, start=1):
        source, name, synonyms, description, instructions, fields, doc = search_row(dataset, relationships)
        con.execute("INSERT INTO models VALUES (?, ?, ?, ?)", (id_, source, name, doc))
        con.execute(
            "INSERT INTO fts (rowid, source, synonyms, description, instructions, fields) VALUES (?, ?, ?, ?, ?, ?)",
            (id_, source.replace(".", " ").replace("_", " "), synonyms, description, instructions, fields),
        )
    model_context = document.ai_context
    con.executemany(
        "INSERT INTO meta VALUES (?, ?)",
        [
            ("model_name", document.name),
            ("model_description", document.description or ""),
            ("model_instructions", model_context.instructions if isinstance(model_context, OssieAIContextObject) else ""),
            ("ossie_version", document.version),
        ],
    )
    con.commit()
    con.close()
    tmp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--warehouse", type=Path, default=WAREHOUSE_DIR / "warehouse.read.duckdb")
    parser.add_argument("--out", type=Path, default=WAREHOUSE_DIR / "semantic")
    args = parser.parse_args()

    context = yaml.safe_load((HERE / "context.yaml").read_text())
    key_errors = check_context_keys(context.get("datasets", {}))
    if key_errors:
        for error in key_errors:
            print(f"[semantic] context.yaml: {error}", file=sys.stderr)
        sys.exit(1)
    warnings: list[str] = []
    document = build_document(*read_catalog(args.warehouse), context, warnings)
    for warning in warnings:
        print(f"[semantic] warning: {warning}")

    errors = official_validate(document)
    if errors:
        for error in errors:
            print(f"[semantic] invalid: {error}", file=sys.stderr)
        sys.exit(1)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "lucero.ossie.yaml").write_text(document.to_ossie_yaml())
    write_index(document, args.out / "semantic.sqlite")
    fields = sum(len(d.fields or []) for d in document.datasets)
    print(
        f"[semantic] ossie {document.version}: {len(document.datasets)} datasets, {fields} fields, "
        f"{len(document.relationships or [])} relationships -> {args.out}"
    )


if __name__ == "__main__":
    main()
