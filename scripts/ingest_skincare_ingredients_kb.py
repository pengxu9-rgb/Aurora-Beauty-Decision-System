#!/usr/bin/env python3
"""
Aurora Ingredient Research KB ingester (DB direct, idempotent, auditable).

Design goals:
- Always self-check DB before writing.
- Dry-run first, then commit.
- Idempotent: re-running with the same inputs produces no duplicates.
- Safe by default: if an existing PK has different content, STOP unless --allow-overwrite.

Usage (recommended):
  cd client
  export DATABASE_URL="postgresql://..."
  .venv-worker/bin/python scripts/ingest_skincare_ingredients_kb.py --dry-run --data-dir "/Users/.../Aurora KB" --report-path reports/aurora_kb_self_check.md
  .venv-worker/bin/python scripts/ingest_skincare_ingredients_kb.py --commit  --data-dir "/Users/.../Aurora KB" --log-path logs/kb_ingestion_log.csv
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


def die(msg: str) -> None:
    print(f"[ERROR] {msg}", file=sys.stderr)
    raise SystemExit(1)


def warn(msg: str) -> None:
    print(f"[WARN] {msg}", file=sys.stderr)


def info(msg: str) -> None:
    print(f"[INFO] {msg}")


def now_iso() -> str:
    return dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).isoformat()


def safe_schema_name(raw: str) -> str:
    s = (raw or "public").strip()
    if not s:
        return "public"
    if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", s):
        die(f"Invalid schema name: {raw!r}")
    return s


def q_ident(ident: str) -> str:
    if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", ident):
        die(f"Unsafe identifier: {ident!r}")
    return f'"{ident}"'


def table_ref(schema: str, table: str) -> str:
    return f"{q_ident(schema)}.{q_ident(table)}"


def strip_schema_query_param(db_url: str) -> str:
    """
    Prisma allows DATABASE_URL like: postgresql://.../db?schema=public
    psycopg2 rejects `schema=` as a DSN option. Strip it for Python connections.
    """
    p = urlparse(db_url)
    if not p.query:
        return db_url
    q = [(k, v) for (k, v) in parse_qsl(p.query, keep_blank_values=True) if k.lower() != "schema"]
    return urlunparse(p._replace(query=urlencode(q)))


def maybe_load_dotenv_var(var_name: str, dotenv_path: Path) -> Optional[str]:
    if not dotenv_path.exists():
        return None
    for line in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() != var_name:
            continue
        return v.strip().strip("'").strip('"')
    return None


def normalize_cell(v: Any) -> Any:
    if v is None:
        return None
    s = str(v).strip()
    if s == "":
        return None
    if s.lower() in {"nan", "null", "none"}:
        return None
    return s


def normalize_int(v: Any) -> Optional[int]:
    s = normalize_cell(v)
    if s is None:
        return None
    try:
        return int(str(s))
    except Exception:
        return None


def read_csv_rows(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        die(f"CSV not found: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            return []
        rows: List[Dict[str, Any]] = []
        for row in reader:
            rows.append({k: normalize_cell(v) for k, v in row.items()})
        return rows


def write_csv_log_row(log_path: Path, row: Dict[str, Any]) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    is_new = not log_path.exists()
    with log_path.open("a", encoding="utf-8", newline="") as f:
        fieldnames = ["table", "primary_key", "status", "error", "timestamp"]
        w = csv.DictWriter(f, fieldnames=fieldnames)
        if is_new:
            w.writeheader()
        w.writerow({k: row.get(k) for k in fieldnames})


@dataclass(frozen=True)
class TableSpec:
    table: str
    filename: str
    pk: str
    columns: List[str]
    renames: Dict[str, str]
    required_ingredient_id: bool = False
    generate_pk: Optional[str] = None  # "ingredient_products_product_id"


TABLE_SPECS: List[TableSpec] = [
    TableSpec(
        table="ingredients_master",
        filename="ingredients_top100.csv",
        pk="ingredient_id",
        columns=[
            "ingredient_id",
            "inci_name",
            "zh_name",
            "synonyms",
            "categories",
            "primary_benefits",
            "evidence_grade",
            "market_presence_notes",
            "social_buzz_notes",
            "representative_products",
        ],
        renames={"name_inci": "inci_name", "name_cn": "zh_name", "aliases": "synonyms"},
        required_ingredient_id=False,
    ),
    TableSpec(
        table="ingredient_products",
        filename="ingredient_top_products.csv",
        pk="product_id",
        columns=[
            "product_id",
            "ingredient_id",
            "product_rank",
            "brand",
            "product_name",
            "size",
            "price_range",
            "key_claims",
            "ingredient_form_or_percent_if_known",
            "skin_types",
            "where_it_sells",
            "evidence_links",
        ],
        renames={},
        required_ingredient_id=True,
        generate_pk="ingredient_products_product_id",
    ),
    TableSpec(
        table="social_themes",
        filename="ingredient_social_themes.csv",
        pk="theme_id",
        columns=[
            "theme_id",
            "ingredient_id",
            "theme_label",
            "sentiment",
            "what_users_report",
            "common_conditions",
            "channels_covered",
            "takeaway",
        ],
        renames={},
        required_ingredient_id=True,
    ),
    TableSpec(
        table="ingredient_suitability_rules",
        filename="ingredient_suitability_rules.csv",
        pk="ingredient_id",
        columns=[
            "ingredient_id",
            "good_for",
            "caution_for",
            "avoid_for",
            "pairing_recommended",
            "pairing_conflicts",
            "layering_am_pm",
            "frequency",
            "order_notes",
            "build_tolerance_notes",
            "safety_notes",
            "regulatory_notes",
        ],
        renames={},
        required_ingredient_id=True,
    ),
    TableSpec(
        table="ingredient_claims",
        filename="ingredient_claims.csv",
        pk="claim_id",
        columns=[
            "claim_id",
            "ingredient_id",
            "claim_text",
            "claim_type",
            "report_location",
            "needs_citation",
            "suggested_source_types",
        ],
        renames={},
        required_ingredient_id=False,  # allow null ingredient_id (global claims)
    ),
    # Optional (empty is OK)
    TableSpec(
        table="ingredient_papers",
        filename="ingredient_papers.csv",
        pk="paper_id",
        columns=[
            "paper_id",
            "ingredient_id",
            "citation",
            "year",
            "study_type",
            "n",
            "concentration_or_formulation",
            "duration",
            "outcomes",
            "limitations",
            "doi_or_link",
            "evidence_level",
        ],
        renames={},
        required_ingredient_id=True,
    ),
    TableSpec(
        table="ingredient_brand_claims",
        filename="ingredient_brand_claims.csv",
        pk="claim_id",
        columns=[
            "claim_id",
            "ingredient_id",
            "claim_summary",
            "common_wording_examples",
            "alignment_with_science",
            "source_url",
        ],
        renames={},
        required_ingredient_id=True,
    ),
    TableSpec(
        table="ingredient_social_quotes",
        filename="ingredient_social_quotes.csv",
        pk="quote_id",
        columns=[
            "quote_id",
            "ingredient_id",
            "theme_id",
            "channel",
            "short_quote",
            "context",
            "sentiment",
            "url",
        ],
        renames={},
        required_ingredient_id=True,
    ),
]


def apply_renames(rows: List[Dict[str, Any]], renames: Dict[str, str]) -> List[Dict[str, Any]]:
    if not renames:
        return rows
    out: List[Dict[str, Any]] = []
    for r in rows:
        nr = dict(r)
        for src, dst in renames.items():
            if src in nr and dst not in nr:
                nr[dst] = nr.get(src)
            if src in nr:
                nr.pop(src, None)
        out.append(nr)
    return out


def ensure_pk(rows: List[Dict[str, Any]], spec: TableSpec) -> List[Dict[str, Any]]:
    if spec.generate_pk != "ingredient_products_product_id":
        return rows
    out: List[Dict[str, Any]] = []
    for r in rows:
        nr = dict(r)
        if not nr.get("product_id"):
            iid = normalize_cell(nr.get("ingredient_id"))
            rank = normalize_int(nr.get("product_rank"))
            if not iid or rank is None:
                die("ingredient_products: cannot generate product_id (missing ingredient_id or product_rank)")
            nr["product_id"] = f"{iid}_p{rank:02d}"
        out.append(nr)
    return out


def validate_primary_key(rows: List[Dict[str, Any]], pk: str, table: str) -> None:
    seen = {}
    for idx, r in enumerate(rows):
        v = normalize_cell(r.get(pk))
        if not v:
            die(f"{table}: empty primary key '{pk}' at row_index={idx}")
        if v in seen:
            die(f"{table}: duplicate primary key '{pk}' value={v!r} at row_index={idx} (first_seen_row_index={seen[v]})")
        seen[v] = idx


def validate_required_columns(rows: List[Dict[str, Any]], columns: Sequence[str], table: str) -> None:
    if not rows:
        return
    missing = [c for c in columns if c not in rows[0].keys()]
    if missing:
        die(f"{table}: missing required columns: {missing}")


def validate_refs(rows: List[Dict[str, Any]], ingredient_ids: set, table: str, required: bool) -> None:
    if not rows:
        return
    missing: List[Tuple[int, Any]] = []
    for idx, r in enumerate(rows):
        iid = normalize_cell(r.get("ingredient_id"))
        if not iid:
            if required:
                missing.append((idx, iid))
            continue
        if iid not in ingredient_ids:
            missing.append((idx, iid))
    if missing:
        sample = ", ".join([f"(row={i}, ingredient_id={v!r})" for i, v in missing[:10]])
        die(f"{table}: ingredient_id references missing from ingredients_master: count={len(missing)} sample={sample}")


def connect_psycopg2(database_url: str):
    try:
        import psycopg2  # type: ignore
        import psycopg2.extras  # noqa: F401
    except Exception as e:  # noqa: BLE001
        die(f"psycopg2 is required to run this script. Import error: {e}")
    clean_url = strip_schema_query_param(database_url)
    return psycopg2.connect(clean_url)


def db_table_exists(conn, schema: str, table: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = %s AND table_name = %s
            """,
            (schema, table),
        )
        return cur.fetchone() is not None


def db_count_rows(conn, schema: str, table: str) -> int:
    with conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) FROM {table_ref(schema, table)}")
        (n,) = cur.fetchone()
        return int(n)


def db_primary_keys(conn, schema: str, table: str) -> List[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = %s
              AND tc.table_name = %s
            ORDER BY kcu.ordinal_position
            """,
            (schema, table),
        )
        return [r[0] for r in cur.fetchall()]


def db_duplicate_pks(conn, schema: str, table: str, pk: str) -> List[Tuple[str, int]]:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {q_ident(pk)}::text AS pk, COUNT(*) AS c
            FROM {table_ref(schema, table)}
            GROUP BY {q_ident(pk)}
            HAVING COUNT(*) > 1
            ORDER BY c DESC, pk ASC
            LIMIT 50
            """,
        )
        return [(r[0], int(r[1])) for r in cur.fetchall()]


def fetch_existing_row(conn, schema: str, table: str, pk: str, pk_value: str) -> Optional[Dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(f"SELECT * FROM {table_ref(schema, table)} WHERE {q_ident(pk)} = %s LIMIT 1", (pk_value,))
        row = cur.fetchone()
        if row is None:
            return None
        cols = [d.name for d in cur.description]
        return {cols[i]: row[i] for i in range(len(cols))}


def rows_equal(existing: Dict[str, Any], incoming: Dict[str, Any], columns: Sequence[str]) -> bool:
    for c in columns:
        if c in {"created_at", "updated_at"}:
            continue
        a = existing.get(c)
        b = incoming.get(c)

        # Normalize ints from DB vs strings from CSV
        if isinstance(a, int) and isinstance(b, str) and b.isdigit():
            b = int(b)
        if isinstance(b, int) and isinstance(a, str) and a.isdigit():
            a = int(a)

        # Treat "" and NULL as equal (we normalize CSV empties to None already)
        if a == "" and b is None:
            a = None
        if b == "" and a is None:
            b = None

        if a != b:
            return False
    return True


def upsert_row(conn, schema: str, table: str, pk: str, row: Dict[str, Any], columns: Sequence[str]) -> None:
    cols = [c for c in columns if c != "created_at"]  # created_at uses DB default
    placeholders = ", ".join(["%s"] * len(cols))
    col_list = ", ".join(q_ident(c) for c in cols)

    update_cols = [c for c in cols if c != pk]
    set_list = ", ".join([f"{q_ident(c)} = EXCLUDED.{q_ident(c)}" for c in update_cols] + [f"updated_at = CURRENT_TIMESTAMP"])

    sql = f"""
      INSERT INTO {table_ref(schema, table)} ({col_list})
      VALUES ({placeholders})
      ON CONFLICT ({q_ident(pk)}) DO UPDATE SET {set_list}
    """
    values = [row.get(c) for c in cols]
    with conn.cursor() as cur:
        cur.execute(sql, values)


def render_self_check_report(
    *,
    schema: str,
    db_table_info: List[Dict[str, Any]],
    sample_ingredients: List[Dict[str, Any]],
    missing_tables: List[str],
    expected_tables: List[str],
) -> str:
    lines: List[str] = []
    lines.append("# Aurora KB Self-Check Report (Ingredient Research KB)")
    lines.append("")
    lines.append(f"- Generated at: `{now_iso()}`")
    lines.append(f"- Schema: `{schema}`")
    lines.append("")

    lines.append("## Table Status")
    lines.append("")
    lines.append("| table | exists | rows | primary_key | duplicate_pk_count |")
    lines.append("|---|---:|---:|---|---:|")
    for t in db_table_info:
        lines.append(
            f"| `{t['table']}` | {str(t['exists']).lower()} | {t.get('rows','')} | `{t.get('primary_key','')}` | {t.get('duplicate_pk_count','')} |"
        )
    lines.append("")

    if missing_tables:
        lines.append("## Missing Tables")
        lines.append("")
        lines.append("The following tables are expected but missing:")
        for t in missing_tables:
            lines.append(f"- `{t}`")
        lines.append("")

    lines.append("## Sample Ingredients (presence check)")
    lines.append("")
    if not sample_ingredients:
        lines.append("- No sample rows found in `ingredients_master`.")
    else:
        for r in sample_ingredients:
            lines.append(f"- `{r.get('ingredient_id')}`: inci=`{r.get('inci_name')}` zh=`{r.get('zh_name')}` evidence=`{r.get('evidence_grade')}`")
    lines.append("")

    lines.append("## Expected Tables (target)")
    lines.append("")
    for t in expected_tables:
        lines.append(f"- `{t}`")
    lines.append("")

    return "\n".join(lines).strip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True, help="Directory containing Aurora KB CSV files")
    parser.add_argument("--schema", default="public", help="Postgres schema name (default: public)")
    parser.add_argument("--dry-run", action="store_true", help="Validate and self-check only (no writes)")
    parser.add_argument("--commit", action="store_true", help="Write to DB (after validation/self-check)")
    parser.add_argument(
        "--override-file",
        action="append",
        default=[],
        help="Override a filename in data-dir. Example: ingredient_claims.csv=ingredient_claims_dedup_20260207.csv",
    )
    parser.add_argument("--report-path", default=None, help="Write self-check Markdown report to this path")
    parser.add_argument("--log-path", default=None, help="Write ingestion log CSV to this path")
    parser.add_argument("--allow-overwrite", action="store_true", help="Allow overwriting existing rows when content differs")
    parser.add_argument(
        "--include-social-quotes",
        action="store_true",
        help="Allow ingesting ingredient_social_quotes.csv when it has rows (disabled by default).",
    )
    args = parser.parse_args()

    if args.dry_run and args.commit:
        die("Choose either --dry-run or --commit, not both.")
    if not args.dry_run and not args.commit:
        die("Specify --dry-run or --commit.")

    schema = safe_schema_name(args.schema)
    data_dir = Path(args.data_dir).expanduser().resolve()
    if not data_dir.exists():
        die(f"--data-dir not found: {data_dir}")

    overrides: Dict[str, str] = {}
    for item in args.override_file:
        if "=" not in item:
            die(f"--override-file must be KEY=VALUE, got: {item!r}")
        k, v = item.split("=", 1)
        overrides[k.strip()] = v.strip()

    database_url = os.getenv("DATABASE_URL") or maybe_load_dotenv_var("DATABASE_URL", Path(".env"))
    if not database_url:
        die("DATABASE_URL not set. Export DATABASE_URL or provide a local .env with DATABASE_URL.")

    # =========================
    # 1) DB self-check
    # =========================
    expected_tables = [s.table for s in TABLE_SPECS]
    db_table_info: List[Dict[str, Any]] = []
    missing_tables: List[str] = []

    conn = connect_psycopg2(database_url)
    conn.autocommit = False
    try:
        for spec in TABLE_SPECS:
            exists = db_table_exists(conn, schema, spec.table)
            rows_count = db_count_rows(conn, schema, spec.table) if exists else ""
            pk_cols = db_primary_keys(conn, schema, spec.table) if exists else []
            pk_col = pk_cols[0] if pk_cols else ""
            dupes = db_duplicate_pks(conn, schema, spec.table, pk_col) if exists and pk_col else []
            if not exists:
                missing_tables.append(spec.table)
            db_table_info.append(
                {
                    "table": spec.table,
                    "exists": exists,
                    "rows": rows_count,
                    "primary_key": pk_col,
                    "duplicate_pk_count": len(dupes),
                }
            )

        sample_ids = ["hyaluronic_acid", "niacinamide", "retinol", "salicylic_acid", "zinc_oxide"]
        sample_ingredients: List[Dict[str, Any]] = []
        if db_table_exists(conn, schema, "ingredients_master"):
            for iid in sample_ids:
                row = fetch_existing_row(conn, schema, "ingredients_master", "ingredient_id", iid)
                if row:
                    sample_ingredients.append(row)

        if args.report_path:
            report_path = Path(args.report_path).expanduser()
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report = render_self_check_report(
                schema=schema,
                db_table_info=db_table_info,
                sample_ingredients=sample_ingredients,
                missing_tables=missing_tables,
                expected_tables=expected_tables,
            )
            report_path.write_text(report, encoding="utf-8")
            info(f"Wrote self-check report: {report_path.resolve()}")

        if missing_tables and args.commit:
            die(f"Target tables missing in DB schema={schema}: {missing_tables}. Run `npx prisma migrate deploy` first.")

        # =========================
        # 2) Load + validate CSVs
        # =========================
        info(f"Workspace: {data_dir}")
        info(f"Mode: {'DRY-RUN' if args.dry_run else 'COMMIT'}")

        ingredient_spec = TABLE_SPECS[0]
        ingredients_path = data_dir / overrides.get(ingredient_spec.filename, ingredient_spec.filename)
        ingredient_rows = ensure_pk(apply_renames(read_csv_rows(ingredients_path), ingredient_spec.renames), ingredient_spec)
        validate_required_columns(ingredient_rows, ingredient_spec.columns, ingredient_spec.table)
        validate_primary_key(ingredient_rows, ingredient_spec.pk, ingredient_spec.table)
        ingredient_ids = {normalize_cell(r.get("ingredient_id")) for r in ingredient_rows if normalize_cell(r.get("ingredient_id"))}

        if len(ingredient_rows) != 100:
            warn(f"ingredients_top100.csv: expected 100 rows (Top100) but got {len(ingredient_rows)}")

        # Validate remaining tables
        table_rows_map: Dict[str, List[Dict[str, Any]]] = {ingredient_spec.table: ingredient_rows}
        for spec in TABLE_SPECS[1:]:
            if spec.table == "ingredient_social_quotes" and not args.include_social_quotes:
                # If the table has rows, we warn and skip by default.
                path = data_dir / overrides.get(spec.filename, spec.filename)
                rows = read_csv_rows(path)
                if rows:
                    warn("ingredient_social_quotes.csv has rows; skipping by default. Re-run with --include-social-quotes if you really want to ingest quotes.")
                table_rows_map[spec.table] = []
                continue

            path = data_dir / overrides.get(spec.filename, spec.filename)
            rows = ensure_pk(apply_renames(read_csv_rows(path), spec.renames), spec)
            if not rows:
                table_rows_map[spec.table] = []
                continue

            validate_required_columns(rows, spec.columns, spec.table)
            validate_primary_key(rows, spec.pk, spec.table)

            # Type coercions
            if spec.table == "ingredient_products":
                for r in rows:
                    r["product_rank"] = normalize_int(r.get("product_rank"))

            if spec.table == "ingredient_papers":
                for r in rows:
                    r["year"] = normalize_int(r.get("year"))
                    r["n"] = normalize_int(r.get("n"))

            validate_refs(rows, ingredient_ids, spec.table, required=spec.required_ingredient_id)
            table_rows_map[spec.table] = rows

        # =========================
        # 3) Commit (safe upsert)
        # =========================
        summary: Dict[str, Dict[str, int]] = {}
        conflicts: List[Dict[str, Any]] = []

        def log(table: str, pk_value: str, status: str, error: str = "") -> None:
            if not args.log_path:
                return
            write_csv_log_row(Path(args.log_path), {"table": table, "primary_key": pk_value, "status": status, "error": error, "timestamp": now_iso()})

        for spec in TABLE_SPECS:
            rows = table_rows_map.get(spec.table, [])
            summary[spec.table] = {"inserted": 0, "updated": 0, "skipped": 0, "conflict": 0, "failed": 0}
            if not rows:
                info(f"table={spec.table}: 0 rows (skip)")
                continue

            for r in rows:
                pk_value = normalize_cell(r.get(spec.pk))
                if not pk_value:
                    continue

                existing = fetch_existing_row(conn, schema, spec.table, spec.pk, pk_value) if db_table_exists(conn, schema, spec.table) else None
                incoming = {c: r.get(c) for c in spec.columns}

                if existing is None:
                    if args.commit:
                        try:
                            upsert_row(conn, schema, spec.table, spec.pk, incoming, spec.columns)
                            summary[spec.table]["inserted"] += 1
                            log(spec.table, pk_value, "inserted")
                        except Exception as e:  # noqa: BLE001
                            summary[spec.table]["failed"] += 1
                            log(spec.table, pk_value, "failed", str(e)[:500])
                            die(f"Insert failed table={spec.table} pk={pk_value}: {e}")
                    else:
                        summary[spec.table]["inserted"] += 1
                    continue

                if rows_equal(existing, incoming, spec.columns):
                    summary[spec.table]["skipped"] += 1
                    log(spec.table, pk_value, "skipped")
                    continue

                # Conflict: content differs
                summary[spec.table]["conflict"] += 1
                conflicts.append({"table": spec.table, "pk": pk_value})
                log(spec.table, pk_value, "conflict", "content differs")

                if args.commit and not args.allow_overwrite:
                    continue

                if args.commit and args.allow_overwrite:
                    try:
                        upsert_row(conn, schema, spec.table, spec.pk, incoming, spec.columns)
                        summary[spec.table]["updated"] += 1
                        log(spec.table, pk_value, "updated")
                    except Exception as e:  # noqa: BLE001
                        summary[spec.table]["failed"] += 1
                        log(spec.table, pk_value, "failed", str(e)[:500])
                        die(f"Update failed table={spec.table} pk={pk_value}: {e}")

            info(f"table={spec.table}: {json.dumps(summary[spec.table])}")

        if conflicts and args.commit and not args.allow_overwrite:
            # No writes should be committed if we detected conflicts; rollback and stop.
            conn.rollback()
            die(
                "Conflicts detected: existing rows differ from incoming data. "
                "Refusing to overwrite. Re-run with --allow-overwrite if you want to update, "
                f"or resolve conflicts first. conflicts_sample={conflicts[:10]}"
            )

        if args.commit:
            conn.commit()
            info("Commit OK.")
        else:
            conn.rollback()

        info("== Summary ==")
        for t, s in summary.items():
            info(f"- {t}: {s}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()

