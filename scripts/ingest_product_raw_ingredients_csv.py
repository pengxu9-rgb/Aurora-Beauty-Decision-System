#!/usr/bin/env python3
"""
Ingest manually reviewed product + raw ingredient CSV into Aurora KB tables.

Idempotent behavior:
- Match product by normalized (brand, name).
- Create missing products with price defaults.
- Upsert ingredients.full_list per product_id.
- Upsert raw_ingredient_text into product_kb_snippets.

Usage:
  python3 scripts/ingest_product_raw_ingredients_csv.py \
    --input-csv "/Users/.../product_candidates_master_v0_i18n__人工检测完毕.csv" \
    --dry-run

  python3 scripts/ingest_product_raw_ingredients_csv.py \
    --input-csv "/Users/.../product_candidates_master_v0_i18n__人工检测完毕.csv" \
    --commit \
    --upsert-aliases \
    --upsert-crosswalks
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import pandas as pd
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json


def log_info(msg: str) -> None:
    print(f"[INFO] {msg}")


def log_warn(msg: str) -> None:
    print(f"[WARN] {msg}")


def fail(msg: str) -> None:
    print(f"[ERROR] {msg}", file=sys.stderr)
    raise SystemExit(1)


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


def normalize_alias_text(text: str) -> str:
    s = unicodedata.normalize("NFKC", str(text or ""))
    s = s.casefold()
    s = re.sub(r"[^\w\s]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def normalize_crosswalk_ref(value: str) -> str:
    s = unicodedata.normalize("NFKC", str(value or ""))
    s = s.strip().casefold()
    s = re.sub(r"\s+", " ", s)
    return s


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


def normalize_crosswalk_ref_by_type(source_type: str, value: str) -> str:
    if "url" in source_type:
        canonical = canonicalize_url_reference(value)
        if canonical:
            return canonical
    return normalize_crosswalk_ref(value)


def strip_schema_query_param(database_url: str) -> str:
    parsed = urlparse(database_url)
    if not parsed.query:
        return database_url
    query_pairs = [(k, v) for (k, v) in parse_qsl(parsed.query, keep_blank_values=True) if k.lower() != "schema"]
    return urlunparse(parsed._replace(query=urlencode(query_pairs)))


def choose_column(columns: Sequence[str], candidates: Sequence[str]) -> Optional[str]:
    cols = set(columns)
    for c in candidates:
        if c in cols:
            return c
    return None


def clean_raw_ingredient_text(text: str) -> str:
    out = unicodedata.normalize("NFKC", text or "")
    out = re.sub(r"https?://\S+", " ", out, flags=re.IGNORECASE)
    out = re.sub(r"\b(read more|show more|view full list|click here|see image)\b", " ", out, flags=re.IGNORECASE)
    out = re.sub(r"\[more\]", " ", out, flags=re.IGNORECASE)
    out = re.sub(r"\s+", " ", out).strip()
    out = re.sub(
        r"^(ingredients?|ingredient list|full ingredients|inc(i)?|全成分|成分|配料)\s*[:：-]\s*",
        "",
        out,
        flags=re.IGNORECASE,
    ).strip()
    out = re.sub(r"(and\.\.\.|etc\.)\s*$", "", out, flags=re.IGNORECASE).strip()
    return out


def split_ingredient_list(inci_list: str, raw_text: str) -> List[str]:
    source = norm_str(inci_list)
    if source:
        split_pattern = r"[;；|]+"
        if not re.search(split_pattern, source):
            split_pattern = r"[,，、]+"
        parts = [p.strip() for p in re.split(split_pattern, source) if p.strip()]
    else:
        source = clean_raw_ingredient_text(raw_text)
        parts = [p.strip() for p in re.split(r"[,，、;；|]+", source) if p.strip()]

    out: List[str] = []
    seen = set()
    for part in parts:
        token = re.sub(r"\s+", " ", part).strip(" .;；,，")
        if len(token) < 2:
            continue
        dedup_key = normalize_key(token)
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        out.append(token)
    return out


@dataclass
class IngestRow:
    row_index: int
    candidate_id: str
    brand: str
    name: str
    market: str
    source_ref: str
    canonical_url: str
    pivota_product_id: str
    external_product_id: str
    external_seed_id: str
    raw_ingredient_text: str
    ingredient_list: List[str]
    parse_status: str
    review_status: str
    score: int


def build_rows(df: pd.DataFrame) -> Tuple[List[IngestRow], Dict[str, int]]:
    stats: Dict[str, int] = {
        "input_rows": int(len(df)),
        "skipped_missing_brand_or_name": 0,
        "skipped_not_review_ok": 0,
        "skipped_needs_source": 0,
        "skipped_empty_ingredients": 0,
        "dedup_replaced": 0,
        "dedup_ignored": 0,
        "duplicate_conflicts": 0,
    }

    brand_col = choose_column(df.columns, ["brand_en", "brand_original", "brand"])
    name_col = choose_column(df.columns, ["product_name_en", "product_name_original", "product_name", "name", "title"])
    market_col = choose_column(df.columns, ["market"])
    raw_col = choose_column(df.columns, ["raw_ingredient_text", "ingredients_text", "ingredients"])
    inci_col = choose_column(df.columns, ["inci_list"])
    parse_status_col = choose_column(df.columns, ["parse_status", "status"])
    review_status_col = choose_column(df.columns, ["review_status"])
    source_ref_col = choose_column(df.columns, ["source_ref"])
    candidate_id_col = choose_column(df.columns, ["candidate_id"])
    canonical_url_col = choose_column(df.columns, ["canonical_url", "destination_url", "product_url"])
    pivota_product_id_col = choose_column(df.columns, ["pivota_product_id", "product_id"])
    external_product_id_col = choose_column(df.columns, ["external_product_id"])
    external_seed_id_col = choose_column(df.columns, ["external_seed_id", "seed_id"])

    if not brand_col or not name_col:
        fail("CSV is missing required brand/product columns.")
    if not raw_col and not inci_col:
        fail("CSV must include raw_ingredient_text or inci_list.")

    chosen: Dict[str, IngestRow] = {}
    ingredient_signature_by_key: Dict[str, str] = {}

    for idx, record in enumerate(df.to_dict(orient="records")):
        brand = norm_str(record.get(brand_col))
        name = norm_str(record.get(name_col))
        if not brand or not name:
            stats["skipped_missing_brand_or_name"] += 1
            continue

        review_status = norm_str(record.get(review_status_col)) if review_status_col else ""
        if review_status and review_status.upper() != "OK":
            stats["skipped_not_review_ok"] += 1
            continue

        parse_status = norm_str(record.get(parse_status_col)).upper() if parse_status_col else ""
        if parse_status == "NEEDS_SOURCE":
            stats["skipped_needs_source"] += 1
            continue

        raw_text = norm_str(record.get(raw_col)) if raw_col else ""
        inci_text = norm_str(record.get(inci_col)) if inci_col else ""
        ing_list = split_ingredient_list(inci_text, raw_text)
        if not ing_list:
            stats["skipped_empty_ingredients"] += 1
            continue

        score = 0
        score += 100 if (review_status.upper() == "OK") else 0
        score += 50 if (parse_status == "OK") else 0
        score += 25 if inci_text else 0
        score += min(len(ing_list), 30)

        row = IngestRow(
            row_index=idx,
            candidate_id=norm_str(record.get(candidate_id_col)) if candidate_id_col else "",
            brand=brand,
            name=name,
            market=norm_str(record.get(market_col)) if market_col else "",
            source_ref=norm_str(record.get(source_ref_col)) if source_ref_col else "",
            canonical_url=norm_str(record.get(canonical_url_col)) if canonical_url_col else "",
            pivota_product_id=norm_str(record.get(pivota_product_id_col)) if pivota_product_id_col else "",
            external_product_id=norm_str(record.get(external_product_id_col)) if external_product_id_col else "",
            external_seed_id=norm_str(record.get(external_seed_id_col)) if external_seed_id_col else "",
            raw_ingredient_text=clean_raw_ingredient_text(raw_text),
            ingredient_list=ing_list,
            parse_status=parse_status,
            review_status=review_status.upper() if review_status else "",
            score=score,
        )

        key = f"{normalize_key(brand)}||{normalize_key(name)}"
        ing_sig = "|".join([normalize_key(x) for x in row.ingredient_list])
        prev_sig = ingredient_signature_by_key.get(key)
        if prev_sig is not None and prev_sig != ing_sig:
            stats["duplicate_conflicts"] += 1
        ingredient_signature_by_key[key] = ing_sig

        prev = chosen.get(key)
        if prev is None:
            chosen[key] = row
            continue

        if row.score > prev.score:
            chosen[key] = row
            stats["dedup_replaced"] += 1
        else:
            stats["dedup_ignored"] += 1

    rows = list(chosen.values())
    stats["rows_ready"] = len(rows)
    return rows, stats


def ensure_db_prerequisites(conn: "psycopg2.extensions.connection") -> Tuple[bool, bool, bool]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT EXISTS(
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema='public' AND table_name='products' AND column_name='region_availability'
            );
            """
        )
        has_region_availability = bool(cur.fetchone()[0])

        cur.execute(
            """
            SELECT EXISTS(
              SELECT 1
              FROM information_schema.tables
              WHERE table_schema='public' AND table_name='product_kb_snippets'
            );
            """
        )
        has_kb_snippets = bool(cur.fetchone()[0])

        cur.execute(
            """
            SELECT EXISTS(
              SELECT 1
              FROM information_schema.tables
              WHERE table_schema='public' AND table_name='product_crosswalks'
            );
            """
        )
        has_product_crosswalks = bool(cur.fetchone()[0])

    return has_region_availability, has_kb_snippets, has_product_crosswalks


def load_product_index(conn: "psycopg2.extensions.connection") -> Dict[str, Tuple[str, List[str]]]:
    out: Dict[str, Tuple[str, List[str]]] = {}
    with conn.cursor() as cur:
        cur.execute('SELECT id::text, brand, name, COALESCE(region_availability, ARRAY[]::text[]) FROM "products";')
        for product_id, brand, name, regions in cur.fetchall():
            key = f"{normalize_key(str(brand))}||{normalize_key(str(name))}"
            out.setdefault(key, (str(product_id), list(regions or [])))
    return out


def load_ingredient_index(conn: "psycopg2.extensions.connection") -> Dict[str, Tuple[str, List[str]]]:
    out: Dict[str, Tuple[str, List[str]]] = {}
    with conn.cursor() as cur:
        cur.execute('SELECT id::text, product_id::text, full_list FROM "ingredients";')
        for ingredient_id, product_id, full_list in cur.fetchall():
            out[str(product_id)] = (str(ingredient_id), [str(x) for x in (full_list or [])])
    return out


def upsert_product_aliases(
    conn: "psycopg2.extensions.connection", product_id: str, brand: str, name: str
) -> int:
    alias_rows = []
    brand = norm_str(brand)
    name = norm_str(name)
    full = norm_str(f"{brand} {name}")
    for alias, kind, weight in [
        (brand, "brand", 20),
        (name, "name", 30),
        (full, "full_name", 40),
    ]:
        alias_norm = normalize_alias_text(alias)
        if len(alias_norm) < 2:
            continue
        alias_rows.append((alias, alias_norm, kind, weight))

    if not alias_rows:
        return 0

    applied = 0
    with conn.cursor() as cur:
        for alias, alias_norm, kind, weight in alias_rows:
            cur.execute(
                """
                INSERT INTO "product_aliases" (
                  id, product_id, alias, alias_normalized, kind, weight, locale, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, NULL, NOW(), NOW())
                ON CONFLICT (product_id, alias_normalized) DO UPDATE SET
                  alias = EXCLUDED.alias,
                  kind = EXCLUDED.kind,
                  weight = EXCLUDED.weight,
                  updated_at = NOW();
                """,
                (str(uuid.uuid4()), product_id, alias, alias_norm, kind, int(weight)),
            )
            applied += 1
    return applied


def upsert_product_crosswalks(
    conn: "psycopg2.extensions.connection",
    product_id: str,
    row: IngestRow,
    *,
    include_source_ref_url: bool,
) -> Tuple[int, int]:
    refs: List[Tuple[str, str, str, int, Dict[str, object]]] = []

    refs.append(
        (
            "aurora",
            "product_id",
            product_id,
            100,
            {"source": "aurora_ingest", "row_index": row.row_index},
        )
    )

    if row.candidate_id:
        refs.append(
            (
                "harvester",
                "candidate_id",
                row.candidate_id,
                80,
                {"source": "manual_review_csv", "row_index": row.row_index},
            )
        )
    if row.pivota_product_id:
        refs.append(
            (
                "pivota",
                "product_id",
                row.pivota_product_id,
                95,
                {"source": "manual_review_csv", "row_index": row.row_index},
            )
        )
    if row.external_product_id:
        refs.append(
            (
                "pivota",
                "external_product_id",
                row.external_product_id,
                95,
                {"source": "manual_review_csv", "row_index": row.row_index},
            )
        )
    if row.external_seed_id:
        refs.append(
            (
                "pivota",
                "external_seed_id",
                row.external_seed_id,
                90,
                {"source": "manual_review_csv", "row_index": row.row_index},
            )
        )
    if row.canonical_url:
        refs.append(
            (
                "merchant",
                "canonical_url",
                row.canonical_url,
                90,
                {"source": "manual_review_csv", "row_index": row.row_index},
            )
        )
    if include_source_ref_url and row.source_ref:
        refs.append(
            (
                "merchant",
                "source_ref_url",
                row.source_ref,
                85,
                {"source": "manual_review_csv", "row_index": row.row_index},
            )
        )

    upserted = 0
    conflicts = 0
    seen_keys = set()
    with conn.cursor() as cur:
        for source_system, source_type, external_ref, confidence, metadata in refs:
            normalized = normalize_crosswalk_ref_by_type(source_type, external_ref)
            if not normalized:
                continue

            dedup_key = (source_system, source_type, normalized)
            if dedup_key in seen_keys:
                continue
            seen_keys.add(dedup_key)

            cur.execute(
                """
                INSERT INTO "product_crosswalks" (
                  id, product_id, source_system, source_type, external_ref, external_ref_normalized, confidence, metadata, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (source_system, source_type, external_ref_normalized) DO UPDATE SET
                  external_ref = EXCLUDED.external_ref,
                  confidence = EXCLUDED.confidence,
                  metadata = EXCLUDED.metadata,
                  updated_at = NOW()
                WHERE "product_crosswalks"."product_id" = EXCLUDED.product_id;
                """,
                (
                    str(uuid.uuid4()),
                    product_id,
                    source_system,
                    source_type,
                    external_ref,
                    normalized,
                    int(confidence),
                    Json(metadata),
                ),
            )
            if cur.rowcount == 1:
                upserted += 1
                continue

            # Conflict means same external reference is already mapped to a different product.
            cur.execute(
                """
                SELECT product_id::text
                FROM "product_crosswalks"
                WHERE source_system=%s AND source_type=%s AND external_ref_normalized=%s
                LIMIT 1;
                """,
                (source_system, source_type, normalized),
            )
            existing = cur.fetchone()
            existing_product_id = str(existing[0]) if existing else "unknown"
            conflicts += 1
            log_warn(
                f"crosswalk conflict source={source_system}/{source_type} ref={external_ref!r} "
                f"existing_product_id={existing_product_id} incoming_product_id={product_id}"
            )

    return upserted, conflicts


def ingest_rows(
    conn: "psycopg2.extensions.connection",
    rows: Sequence[IngestRow],
    *,
    commit: bool,
    upsert_aliases: bool,
    upsert_crosswalks: bool,
    include_source_ref_crosswalk: bool,
) -> Dict[str, int]:
    has_region_availability, has_kb_snippets, has_product_crosswalks = ensure_db_prerequisites(conn)
    product_index = load_product_index(conn)
    ingredient_index = load_ingredient_index(conn)

    stats: Dict[str, int] = {
        "products_inserted": 0,
        "regions_updated": 0,
        "ingredients_inserted": 0,
        "ingredients_updated": 0,
        "ingredients_unchanged": 0,
        "raw_snippets_upserted": 0,
        "aliases_upserted": 0,
        "crosswalks_upserted": 0,
        "crosswalk_conflicts": 0,
    }

    if upsert_crosswalks and not has_product_crosswalks:
        log_warn("`product_crosswalks` table not found; skipping crosswalk upsert. Run DB migration first.")

    total_rows = len(rows)
    for idx, row in enumerate(rows, start=1):
        if idx == 1 or idx % 25 == 0 or idx == total_rows:
            log_info(f"Progress: {idx}/{total_rows}")
        key = f"{normalize_key(row.brand)}||{normalize_key(row.name)}"
        existing = product_index.get(key)
        if existing is None:
            product_id = str(uuid.uuid4())
            if has_region_availability:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO "products" (
                          id, brand, name, price_usd, price_cny, product_url, image_url, region_availability, created_at, updated_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, NULL, %s, NOW(), NOW());
                        """,
                        (
                            product_id,
                            row.brand,
                            row.name,
                            0.0,
                            0.0,
                            row.source_ref or None,
                            [row.market] if row.market else [],
                        ),
                    )
            else:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO "products" (
                          id, brand, name, price_usd, price_cny, product_url, image_url, created_at, updated_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, NULL, NOW(), NOW());
                        """,
                        (product_id, row.brand, row.name, 0.0, 0.0, row.source_ref or None),
                    )
            stats["products_inserted"] += 1
            product_index[key] = (product_id, [row.market] if row.market else [])
        else:
            product_id, known_regions = existing
            if has_region_availability and row.market and row.market not in known_regions:
                merged = sorted({r for r in (known_regions + [row.market]) if r})
                with conn.cursor() as cur:
                    cur.execute('UPDATE "products" SET region_availability=%s, updated_at=NOW() WHERE id=%s;', (merged, product_id))
                product_index[key] = (product_id, merged)
                stats["regions_updated"] += 1

        product_id = product_index[key][0]

        existing_ing = ingredient_index.get(product_id)
        if existing_ing is None:
            new_ingredient_id = str(uuid.uuid4())
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO "ingredients" (id, product_id, full_list, hero_actives)
                    VALUES (%s, %s, %s, %s);
                    """,
                    (new_ingredient_id, product_id, row.ingredient_list, Json([])),
                )
            ingredient_index[product_id] = (new_ingredient_id, list(row.ingredient_list))
            stats["ingredients_inserted"] += 1
        else:
            ingredient_id, existing_list = existing_ing
            if existing_list == row.ingredient_list:
                stats["ingredients_unchanged"] += 1
            else:
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "ingredients" SET full_list=%s, hero_actives=%s WHERE id=%s;',
                        (row.ingredient_list, Json([]), ingredient_id),
                    )
                ingredient_index[product_id] = (ingredient_id, list(row.ingredient_list))
                stats["ingredients_updated"] += 1

        if upsert_aliases:
            stats["aliases_upserted"] += upsert_product_aliases(conn, product_id, row.brand, row.name)
        if upsert_crosswalks and has_product_crosswalks:
            upserted, conflicts = upsert_product_crosswalks(
                conn,
                product_id,
                row,
                include_source_ref_url=include_source_ref_crosswalk,
            )
            stats["crosswalks_upserted"] += upserted
            stats["crosswalk_conflicts"] += conflicts

        if has_kb_snippets and row.raw_ingredient_text:
            metadata = {
                "source": "manual_review_csv",
                "market": row.market,
                "source_ref": row.source_ref or None,
                "review_status": row.review_status or None,
                "parse_status": row.parse_status or None,
            }
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO "product_kb_snippets" (id, product_id, source_sheet, field, content, metadata, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, NOW(), NOW())
                    ON CONFLICT (product_id, source_sheet, field) DO UPDATE SET
                      content = EXCLUDED.content,
                      metadata = EXCLUDED.metadata,
                      updated_at = NOW();
                    """,
                    (
                        str(uuid.uuid4()),
                        product_id,
                        "ingredient_harvester_manual",
                        "raw_ingredient_text",
                        row.raw_ingredient_text,
                        Json(metadata),
                    ),
                )
            stats["raw_snippets_upserted"] += 1

    if commit:
        conn.commit()
        log_info("Committed DB transaction.")
    else:
        conn.rollback()
        log_info("Rolled back DB transaction (dry-run).")

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest reviewed raw ingredient CSV into Aurora KB tables.")
    parser.add_argument("--input-csv", required=True, help="Path to reviewed CSV file.")
    parser.add_argument("--commit", action="store_true", help="Write changes to DB.")
    parser.add_argument("--dry-run", action="store_true", help="Validate and simulate writes without commit.")
    parser.add_argument("--upsert-aliases", action="store_true", help="Also upsert entries into product_aliases.")
    parser.add_argument("--upsert-crosswalks", action="store_true", help="Also upsert entries into product_crosswalks.")
    parser.add_argument(
        "--include-source-ref-crosswalk",
        action="store_true",
        help="Also write merchant/source_ref_url crosswalk entries (can be ambiguous across products).",
    )
    parser.add_argument("--limit", type=int, default=None, help="Limit number of deduped rows to ingest (for debugging).")
    args = parser.parse_args()

    if args.commit == args.dry_run:
        fail("Use exactly one of --dry-run or --commit.")

    load_dotenv()
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        fail("DATABASE_URL is not set.")
    if "${{" in database_url:
        fail("DATABASE_URL contains unresolved Railway template variables.")

    input_csv = Path(args.input_csv).expanduser().resolve()
    if not input_csv.exists():
        fail(f"Input CSV not found: {input_csv}")

    log_info(f"Reading CSV: {input_csv}")
    df = pd.read_csv(input_csv)
    rows, review_stats = build_rows(df)

    log_info("CSV review summary:")
    for key, val in review_stats.items():
        print(f"  - {key}: {val}")

    if not rows:
        fail("No rows passed review filters; aborting.")

    if args.limit is not None and args.limit > 0:
        rows = rows[: int(args.limit)]
        log_info(f"Applying --limit, rows to ingest: {len(rows)}")

    conn = psycopg2.connect(strip_schema_query_param(database_url))
    conn.autocommit = False
    try:
        write_stats = ingest_rows(
            conn,
            rows,
            commit=args.commit,
            upsert_aliases=args.upsert_aliases,
            upsert_crosswalks=args.upsert_crosswalks,
            include_source_ref_crosswalk=args.include_source_ref_crosswalk,
        )
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()

    mode = "commit" if args.commit else "dry-run"
    log_info(f"Ingestion summary ({mode}):")
    for key, val in write_stats.items():
        print(f"  - {key}: {val}")


if __name__ == "__main__":
    main()
