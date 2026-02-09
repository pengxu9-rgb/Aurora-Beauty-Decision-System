#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import os
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import pandas as pd
import psycopg2
from dotenv import load_dotenv


def norm_str(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and pd.isna(value):
        return ""
    return str(value).strip()


def normalize_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = value.casefold()
    value = re.sub(r"\s+", " ", value).strip()
    return value


def canonicalize_url_reference(value: str) -> str:
    raw = norm_str(value)
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
    except Exception:
        return ""
    if parsed.scheme.lower() not in {"http", "https"}:
        return ""
    host = parsed.hostname.casefold() if parsed.hostname else ""
    path = parsed.path or "/"
    path = re.sub(r"/{2,}", "/", path)
    path = path.rstrip("/") or "/"
    return f"{host}{path}"


def normalize_crosswalk_ref(source_type: str, value: str) -> str:
    source_type = normalize_key(source_type)
    if "url" in source_type:
        canonical = canonicalize_url_reference(value)
        if canonical:
            return canonical
    s = unicodedata.normalize("NFKC", str(value or ""))
    s = s.strip().casefold()
    s = re.sub(r"\s+", " ", s)
    return s


def strip_schema_query_param(database_url: str) -> str:
    parsed = urlparse(database_url)
    if not parsed.query:
        return database_url
    query_pairs = [(k, v) for (k, v) in parse_qsl(parsed.query, keep_blank_values=True) if k.lower() != "schema"]
    return urlunparse(parsed._replace(query=urlencode(query_pairs)))


def choose_column(columns: Iterable[str], candidates: List[str]) -> Optional[str]:
    colset = set(columns)
    for item in candidates:
        if item in colset:
            return item
    return None


@dataclass(frozen=True)
class CsvRow:
    row_index: int
    candidate_id: str
    brand: str
    name: str
    source_ref: str


@dataclass(frozen=True)
class ConflictRow:
    source_ref_url: str
    source_ref_normalized: str
    existing_product_id: str
    incoming_product_id: str
    incoming_brand: str
    incoming_name: str
    candidate_id: str
    resolution: str


def read_relevant_rows(df: pd.DataFrame) -> List[CsvRow]:
    brand_col = choose_column(df.columns, ["brand_en", "brand_original", "brand"])
    name_col = choose_column(df.columns, ["product_name_en", "product_name_original", "product_name", "name", "title"])
    source_ref_col = choose_column(df.columns, ["source_ref"])
    review_status_col = choose_column(df.columns, ["review_status"])
    parse_status_col = choose_column(df.columns, ["parse_status", "status"])
    candidate_id_col = choose_column(df.columns, ["candidate_id"])

    if not brand_col or not name_col or not source_ref_col:
        raise ValueError("CSV must include brand/product/source_ref columns")

    rows: List[CsvRow] = []
    for idx, rec in enumerate(df.to_dict(orient="records")):
        review_status = norm_str(rec.get(review_status_col)).upper() if review_status_col else ""
        if review_status and review_status != "OK":
            continue

        parse_status = norm_str(rec.get(parse_status_col)).upper() if parse_status_col else ""
        if parse_status == "NEEDS_SOURCE":
            continue

        brand = norm_str(rec.get(brand_col))
        name = norm_str(rec.get(name_col))
        source_ref = norm_str(rec.get(source_ref_col))
        if not brand or not name or not source_ref:
            continue

        rows.append(
            CsvRow(
                row_index=idx,
                candidate_id=norm_str(rec.get(candidate_id_col)) if candidate_id_col else "",
                brand=brand,
                name=name,
                source_ref=source_ref,
            )
        )

    return rows


def fetch_product_index(conn: "psycopg2.extensions.connection") -> Dict[str, str]:
    by_key: Dict[str, str] = {}
    dupes = 0
    with conn.cursor() as cur:
        cur.execute('SELECT id::text, brand, name FROM "products" ORDER BY created_at ASC;')
        for product_id, brand, name in cur.fetchall():
            key = f"{normalize_key(str(brand))}||{normalize_key(str(name))}"
            if key in by_key and by_key[key] != str(product_id):
                dupes += 1
                continue
            by_key[key] = str(product_id)
    if dupes:
        print(f"[WARN] duplicate product identity keys detected: {dupes}; using first-created product_id")
    return by_key


def fetch_existing_crosswalks(
    conn: "psycopg2.extensions.connection", source_system: str, source_type: str
) -> Dict[str, Tuple[str, str]]:
    out: Dict[str, Tuple[str, str]] = {}
    with conn.cursor() as cur:
        cur.execute(
            '''
            SELECT external_ref_normalized, product_id::text, external_ref
            FROM "product_crosswalks"
            WHERE source_system=%s AND source_type=%s;
            ''',
            (source_system, source_type),
        )
        for normalized, product_id, external_ref in cur.fetchall():
            out[str(normalized)] = (str(product_id), str(external_ref or ""))
    return out


def detect_conflicts(
    csv_rows: List[CsvRow],
    product_index: Dict[str, str],
    existing: Dict[str, Tuple[str, str]],
    source_type: str,
) -> List[ConflictRow]:
    out: List[ConflictRow] = []
    seen = set()

    for row in csv_rows:
        key = f"{normalize_key(row.brand)}||{normalize_key(row.name)}"
        incoming_product_id = product_index.get(key)
        if not incoming_product_id:
            continue

        normalized_ref = normalize_crosswalk_ref(source_type, row.source_ref)
        if not normalized_ref:
            continue

        current = existing.get(normalized_ref)
        if not current:
            continue

        existing_product_id, existing_ref = current
        if existing_product_id == incoming_product_id:
            continue

        dedupe_key = (normalized_ref, existing_product_id, incoming_product_id)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        out.append(
            ConflictRow(
                source_ref_url=existing_ref or row.source_ref,
                source_ref_normalized=normalized_ref,
                existing_product_id=existing_product_id,
                incoming_product_id=incoming_product_id,
                incoming_brand=row.brand,
                incoming_name=row.name,
                candidate_id=row.candidate_id,
                resolution="DELETE_AMBIGUOUS_SOURCE_REF_MAPPING",
            )
        )

    return out


def write_conflict_csv(path: Path, rows: List[ConflictRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "source_ref_url",
        "source_ref_normalized",
        "existing_product_id",
        "incoming_product_id",
        "incoming_brand",
        "incoming_name",
        "candidate_id",
        "resolution",
    ]
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: getattr(row, k) for k in fields})


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def write_cleanup_sql(path: Path, source_system: str, source_type: str, rows: List[ConflictRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    refs = sorted({r.source_ref_normalized for r in rows})

    lines: List[str] = []
    lines.append("-- Auto-generated cleanup SQL for ambiguous crosswalk mappings")
    lines.append(f"-- source_system={source_system}, source_type={source_type}")
    lines.append(f"-- conflicts={len(rows)}")
    lines.append("BEGIN;")
    if refs:
        lines.append('DELETE FROM "product_crosswalks"')
        lines.append(f"WHERE source_system={sql_quote(source_system)}")
        lines.append(f"  AND source_type={sql_quote(source_type)}")
        lines.append("  AND external_ref_normalized IN (")
        lines.append("    " + ",\n    ".join(sql_quote(x) for x in refs))
        lines.append("  );")
    else:
        lines.append("-- No conflicts found; no-op.")
    lines.append("COMMIT;")
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def apply_cleanup(
    conn: "psycopg2.extensions.connection",
    source_system: str,
    source_type: str,
    rows: List[ConflictRow],
) -> int:
    refs = sorted({r.source_ref_normalized for r in rows})
    if not refs:
        return 0
    with conn.cursor() as cur:
        cur.execute(
            '''
            DELETE FROM "product_crosswalks"
            WHERE source_system=%s
              AND source_type=%s
              AND external_ref_normalized = ANY(%s);
            ''',
            (source_system, source_type, refs),
        )
        deleted = int(cur.rowcount or 0)
    conn.commit()
    return deleted


def main() -> None:
    parser = argparse.ArgumentParser(description="Export and optionally clean ambiguous product_crosswalk mappings.")
    parser.add_argument("--input-csv", required=True)
    parser.add_argument("--source-system", default="merchant")
    parser.add_argument("--source-type", default="source_ref_url")
    parser.add_argument("--report-path", default="reports/crosswalk_conflicts_source_ref_url.csv")
    parser.add_argument("--sql-path", default="reports/crosswalk_conflicts_source_ref_url_cleanup.sql")
    parser.add_argument("--apply", action="store_true", help="Apply cleanup delete for conflicting normalized refs")
    args = parser.parse_args()

    load_dotenv()
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise SystemExit("[ERROR] DATABASE_URL is not set")

    csv_path = Path(args.input_csv).expanduser().resolve()
    if not csv_path.exists():
        raise SystemExit(f"[ERROR] Input CSV not found: {csv_path}")

    df = pd.read_csv(csv_path)
    csv_rows = read_relevant_rows(df)

    conn = psycopg2.connect(strip_schema_query_param(database_url))
    conn.autocommit = False
    try:
        product_index = fetch_product_index(conn)
        existing = fetch_existing_crosswalks(conn, args.source_system, args.source_type)
        conflicts = detect_conflicts(csv_rows, product_index, existing, args.source_type)

        report_path = Path(args.report_path).expanduser().resolve()
        sql_path = Path(args.sql_path).expanduser().resolve()
        write_conflict_csv(report_path, conflicts)
        write_cleanup_sql(sql_path, args.source_system, args.source_type, conflicts)

        print(f"[INFO] rows_checked={len(csv_rows)}")
        print(f"[INFO] existing_crosswalk_refs={len(existing)}")
        print(f"[INFO] conflicts={len(conflicts)}")
        print(f"[INFO] report={report_path}")
        print(f"[INFO] sql={sql_path}")

        if args.apply:
            deleted = apply_cleanup(conn, args.source_system, args.source_type, conflicts)
            print(f"[INFO] applied_cleanup_deleted={deleted}")
        else:
            conn.rollback()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
