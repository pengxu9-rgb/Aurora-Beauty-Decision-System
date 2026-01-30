import argparse
import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import psycopg2
import requests
from dotenv import load_dotenv


USD_TO_CNY = 7.2


def _now_iso() -> str:
  return datetime.now(timezone.utc).isoformat()


def _norm(s: str) -> str:
  return re.sub(r"\s+", " ", (s or "").strip().lower())


def _tokenize(text: str) -> List[str]:
  t = re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()
  parts = [p for p in t.split(" ") if len(p) >= 3]
  # keep order, unique
  seen = set()
  out: List[str] = []
  for p in parts:
    if p in seen:
      continue
    seen.add(p)
    out.append(p)
  return out


def _score_candidate(*, brand: str, name: str, candidate: Dict[str, Any]) -> float:
  """
  Cheap, deterministic matching score to pick the best search hit.
  """
  brand_n = _norm(brand)
  name_n = _norm(name)

  title = _norm(str(candidate.get("title") or ""))
  vendor = _norm(str(candidate.get("vendor") or ""))

  score = 0.0
  if brand_n and (brand_n in title or brand_n in vendor):
    score += 3.0

  # token overlap for name
  want = _tokenize(name_n)
  got = set(_tokenize(title))
  if want:
    overlap = sum(1 for t in want if t in got)
    score += overlap / max(1, len(want)) * 3.0

  # mild penalty if title is extremely short / unhelpful
  if len(title) < 6:
    score -= 0.5

  return score


@dataclass
class PriceHit:
  currency: str
  price: float
  confidence: float
  raw: Dict[str, Any]


class PivotaShopGateway:
  def __init__(self, *, base_url: str, api_key: str, timeout_s: float = 20.0):
    self.base_url = base_url.rstrip("/")
    self.api_key = api_key
    self.timeout_s = timeout_s

  def find_best_price(self, *, query: str, brand: str, name: str, limit: int = 20) -> Optional[PriceHit]:
    url = f"{self.base_url}/agent/shop/v1/invoke"
    body = {
      "operation": "find_products_multi",
      "payload": {
        "search": {
          "query": query,
          "page": 1,
          "limit": max(1, min(int(limit), 100)),
          "in_stock_only": False,
        },
        "metadata": {"source": "aurora-price-oracle", "trace_id": f"aurora-price-oracle:{uuid.uuid4()}"},
      },
      "metadata": {"source": "aurora-price-oracle", "trace_id": f"aurora-price-oracle:{uuid.uuid4()}"},
    }

    res = requests.post(url, headers={"X-API-Key": self.api_key, "Content-Type": "application/json"}, json=body, timeout=self.timeout_s)
    if res.status_code >= 400:
      raise RuntimeError(f"Shop gateway error {res.status_code}: {res.text[:500]}")

    payload = res.json()
    products = payload.get("products")
    if not isinstance(products, list) or not products:
      return None

    scored: List[Tuple[float, Dict[str, Any]]] = []
    for p in products:
      if not isinstance(p, dict):
        continue
      s = _score_candidate(brand=brand, name=name, candidate=p)
      scored.append((s, p))

    if not scored:
      return None

    scored.sort(key=lambda x: x[0], reverse=True)
    best_score, best = scored[0]

    try:
      price = float(best.get("price") or 0.0)
    except Exception:
      price = 0.0

    currency = str(best.get("currency") or "USD").upper()
    if price <= 0:
      return None

    # Confidence: normalized score in [0,1]
    confidence = max(0.0, min(1.0, best_score / 6.0))
    return PriceHit(currency=currency, price=price, confidence=confidence, raw=best)


class AuroraPriceDb:
  def __init__(self, database_url: str):
    self.database_url = database_url
    self.conn = None

  def __enter__(self):
    self.conn = psycopg2.connect(self.database_url)
    self.conn.autocommit = False
    return self

  def __exit__(self, exc_type, exc, tb):
    try:
      if self.conn:
        if exc:
          self.conn.rollback()
        else:
          self.conn.commit()
    finally:
      if self.conn:
        self.conn.close()

  def ensure_price_table(self) -> None:
    """
    Best-effort safety: creates the snapshots table if migrations haven't been applied yet.
    In production, prefer running `prisma migrate deploy`.
    """
    with self.conn.cursor() as cur:
      cur.execute(
        """
        CREATE TABLE IF NOT EXISTS "product_price_snapshots" (
          "id" TEXT PRIMARY KEY,
          "product_id" TEXT NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
          "region" TEXT,
          "currency" TEXT,
          "price_usd" DECIMAL(10,2),
          "price_cny" DECIMAL(10,2),
          "source" TEXT NOT NULL,
          "source_url" TEXT,
          "confidence" DOUBLE PRECISION,
          "metadata" JSONB,
          "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
      )
      cur.execute('CREATE INDEX IF NOT EXISTS product_price_snapshots_product_id_idx ON "product_price_snapshots"(product_id);')
      cur.execute('CREATE INDEX IF NOT EXISTS product_price_snapshots_region_idx ON "product_price_snapshots"(region);')
      cur.execute('CREATE INDEX IF NOT EXISTS product_price_snapshots_captured_at_idx ON "product_price_snapshots"(captured_at);')

  def load_products(self, *, only_missing_price: bool, limit: Optional[int]) -> List[Dict[str, Any]]:
    with self.conn.cursor() as cur:
      sql = 'SELECT id, brand, name, price_usd, price_cny FROM "products"'
      params: List[Any] = []
      if only_missing_price:
        sql += " WHERE price_usd <= 0"
      sql += " ORDER BY updated_at DESC"
      if limit:
        sql += " LIMIT %s"
        params.append(int(limit))
      cur.execute(sql + ";", params)
      rows = cur.fetchall()

    out: List[Dict[str, Any]] = []
    for r in rows:
      out.append({"id": r[0], "brand": r[1], "name": r[2], "price_usd": float(r[3] or 0.0), "price_cny": float(r[4] or 0.0)})
    return out

  def insert_snapshot(
    self,
    *,
    product_id: str,
    region: Optional[str],
    currency: str,
    price_usd: Optional[float],
    price_cny: Optional[float],
    source: str,
    confidence: float,
    metadata: Dict[str, Any],
  ) -> None:
    snapshot_id = str(uuid.uuid4())
    with self.conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO "product_price_snapshots" (
          id, product_id, region, currency, price_usd, price_cny, source, confidence, metadata, captured_at
        ) VALUES (
          %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()
        );
        """,
        (snapshot_id, product_id, region, currency, price_usd, price_cny, source, float(confidence), json.dumps(metadata, ensure_ascii=False)),
      )

  def backfill_product_price(self, *, product_id: str, price_usd: float, price_cny: float) -> None:
    with self.conn.cursor() as cur:
      cur.execute(
        'UPDATE "products" SET price_usd = %s, price_cny = %s, updated_at = NOW() WHERE id = %s;',
        (float(price_usd), float(price_cny), product_id),
      )


def main() -> None:
  load_dotenv()

  parser = argparse.ArgumentParser(description="Aurora PRICE_ORACLE: sync price snapshots from Pivota shop gateway (offline job).")
  parser.add_argument("--db-url", type=str, default=os.getenv("DATABASE_URL"), help="Aurora DATABASE_URL (Postgres).")
  parser.add_argument("--shop-base-url", type=str, default=os.getenv("PIVOTA_SHOP_GATEWAY_BASE_URL", "https://web-production-fedb.up.railway.app"))
  parser.add_argument("--shop-api-key", type=str, default=os.getenv("PIVOTA_SHOP_GATEWAY_API_KEY") or os.getenv("PIVOTA_API_KEY") or os.getenv("AGENT_API_KEY"))
  parser.add_argument("--limit", type=int, default=None, help="Limit number of products to process.")
  parser.add_argument("--only-missing-price", action="store_true", help="Only process products where products.price_usd <= 0.")
  parser.add_argument("--backfill-products", action="store_true", help="Also backfill products.price_usd/price_cny when missing (<=0).")
  parser.add_argument("--sleep-ms", type=int, default=250, help="Sleep between requests (rate limit).")
  parser.add_argument("--dry-run", action="store_true")
  args = parser.parse_args()

  if not args.db_url:
    raise SystemExit("DATABASE_URL is required (pass --db-url or set DATABASE_URL).")
  if not args.shop_api_key:
    raise SystemExit("PIVOTA_SHOP_GATEWAY_API_KEY is required (or set PIVOTA_API_KEY / AGENT_API_KEY).")

  gateway = PivotaShopGateway(base_url=args.shop_base_url, api_key=args.shop_api_key)

  print(f"🔌 PRICE_ORACLE starting at {_now_iso()}")
  print(f"- shop_base_url={args.shop_base_url}")
  print(f"- only_missing_price={bool(args.only_missing_price)} backfill_products={bool(args.backfill_products)} dry_run={bool(args.dry_run)}")

  with AuroraPriceDb(args.db_url) as db:
    db.ensure_price_table()
    products = db.load_products(only_missing_price=bool(args.only_missing_price), limit=args.limit)

    print(f"📦 Products to process: {len(products)}")

    for idx, p in enumerate(products, start=1):
      brand = str(p.get("brand") or "").strip()
      name = str(p.get("name") or "").strip()
      product_id = str(p.get("id") or "").strip()
      if not product_id or not brand or not name:
        continue

      query = f"{brand} {name}".strip()
      print(f"🧾 [{idx}/{len(products)}] {brand} | {name}")

      try:
        hit = gateway.find_best_price(query=query, brand=brand, name=name)
      except Exception as e:
        print(f"   ❌ gateway error: {type(e).__name__}: {e}")
        hit = None

      if not hit:
        print("   ⚠️  no price found")
        continue

      currency = hit.currency.upper()
      price_usd: Optional[float] = None
      price_cny: Optional[float] = None

      if currency == "USD":
        price_usd = float(hit.price)
        price_cny = float(hit.price) * USD_TO_CNY
      elif currency == "CNY":
        price_cny = float(hit.price)
        price_usd = float(hit.price) / USD_TO_CNY
      else:
        # Fallback: store raw currency and leave conversions blank
        price_usd = None
        price_cny = None

      meta = {
        "query": query,
        "shop_gateway": {"base_url": args.shop_base_url, "operation": "find_products_multi"},
        "best_match": {"title": hit.raw.get("title"), "vendor": hit.raw.get("vendor"), "currency": hit.raw.get("currency"), "price": hit.raw.get("price")},
      }

      if args.dry_run:
        print(json.dumps({"product_id": product_id, "currency": currency, "price_usd": price_usd, "price_cny": price_cny, "confidence": hit.confidence, "meta": meta}, ensure_ascii=False))
      else:
        db.insert_snapshot(
          product_id=product_id,
          region="Global",
          currency=currency,
          price_usd=price_usd,
          price_cny=price_cny,
          source="pivota_shop_gateway.find_products_multi",
          confidence=hit.confidence,
          metadata=meta,
        )

        if args.backfill_products and price_usd and price_usd > 0:
          if float(p.get("price_usd") or 0.0) <= 0:
            db.backfill_product_price(product_id=product_id, price_usd=float(price_usd), price_cny=float(price_cny or 0.0))
        print(f"   ✅ snapshot inserted (currency={currency} price={hit.price})")

      if args.sleep_ms and args.sleep_ms > 0:
        time.sleep(args.sleep_ms / 1000.0)


if __name__ == "__main__":
  main()

