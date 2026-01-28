import argparse
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

import psycopg2
from dotenv import load_dotenv
from openai import OpenAI
from psycopg2.extras import Json
from openpyxl import load_workbook


SYSTEM_PROMPT = """
You are the Aurora Vectorization Engine.
Analyze the skincare product ingredients and return a JSON object with scores (0-100).

Rules (high-level heuristics):
- Oil Control: High if Alcohol, Caffeine, Clay, BHA/Salicylic Acid.
- Soothing: High if Centella, Panthenol, Allantoin, Madecassoside.
- Anti-aging: High if Retinoids, Peptides, Vitamin C, Niacinamide.
- Barrier repair: High if Ceramides, Cholesterol, Fatty Acids, Panthenol.

Risk flags:
- Flag 'alcohol_high' if 'Alcohol Denat' appears in top 5.
- Flag 'fungal_acne' if Polysorbates are present.
- Flag 'high_irritation' if strong acids/retinoids are present and the formula looks aggressive.

Output Format (JSON):
{
  "mechanism": {
    "oil_control": int,
    "anti_aging": int,
    "soothing": int,
    "barrier_repair": int
  },
  "risk_flags": [str],
  "experience_prediction": {
    "texture": str,
    "finish": "matte|dewy|natural"
  }
}
""".strip()


@dataclass(frozen=True)
class InputSku:
  brand: str
  name: str
  ingredients_text: str
  price_usd: float
  price_cny: float
  product_url: Optional[str] = None
  image_url: Optional[str] = None


def _require_env(name: str) -> str:
  value = (os.getenv(name) or "").strip()
  if not value:
    raise RuntimeError(f"Missing required env var: {name}")
  return value


def _retry(fn, *, tries: int = 3, base_sleep_s: float = 1.0):
  last_err: Optional[BaseException] = None
  for i in range(tries):
    try:
      return fn()
    except BaseException as e:  # noqa: BLE001
      last_err = e
      sleep_s = base_sleep_s * (2**i)
      time.sleep(sleep_s)
  assert last_err is not None
  raise last_err


def get_vectors_from_llm(client: OpenAI, *, model: str, brand: str, name: str, ingredients: str) -> Dict[str, Any]:
  prompt = f"Product: {brand} {name}\nIngredients: {ingredients}"

  def _call():
    return client.chat.completions.create(
      model=model,
      messages=[
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
      ],
      response_format={"type": "json_object"},
    )

  response = _retry(_call, tries=3, base_sleep_s=1.0)
  raw = response.choices[0].message.content or "{}"
  data = json.loads(raw)

  mechanism = data.get("mechanism") or {}
  risk_flags = data.get("risk_flags") or []
  experience = data.get("experience_prediction") or {}

  if not isinstance(mechanism, dict):
    raise ValueError("LLM output invalid: `mechanism` must be an object")
  if not isinstance(risk_flags, list):
    raise ValueError("LLM output invalid: `risk_flags` must be a list")
  if not isinstance(experience, dict):
    raise ValueError("LLM output invalid: `experience_prediction` must be an object")

  def _clamp_int_0_100(value: Any) -> int:
    try:
      n = int(round(float(value)))
    except Exception:  # noqa: BLE001
      return 0
    return max(0, min(100, n))

  normalized = {
    "mechanism": {
      "oil_control": _clamp_int_0_100(mechanism.get("oil_control", 0)),
      "anti_aging": _clamp_int_0_100(mechanism.get("anti_aging", 0)),
      "soothing": _clamp_int_0_100(mechanism.get("soothing", 0)),
      "barrier_repair": _clamp_int_0_100(mechanism.get("barrier_repair", 0)),
    },
    "risk_flags": [str(x).strip() for x in risk_flags if str(x).strip()],
    "experience_prediction": {
      "texture": str(experience.get("texture", "")).strip() or "unknown",
      "finish": str(experience.get("finish", "")).strip() or "natural",
    },
  }

  return normalized


def get_embedding(client: OpenAI, *, model: str, text: str) -> List[float]:
  def _call():
    return client.embeddings.create(input=text, model=model)

  response = _retry(_call, tries=3, base_sleep_s=1.0)
  embedding = response.data[0].embedding
  if not isinstance(embedding, list) or not embedding:
    raise ValueError("Embedding response invalid")
  return [float(x) for x in embedding]


def embedding_to_vector_literal(embedding: List[float]) -> str:
  # pgvector accepts a text literal like: '[0.1, -0.2, ...]'::vector
  return "[" + ",".join(f"{x:.8f}" for x in embedding) + "]"


def parse_ingredients_list(text: str) -> List[str]:
  # Keep it simple: split by comma; Excel sheets commonly store INCI as comma-separated.
  items = [t.strip() for t in text.split(",")]
  return [t for t in items if t]


class AuroraDb:
  def __init__(self, database_url: str):
    self._database_url = database_url

  def __enter__(self):
    self.conn = psycopg2.connect(self._database_url)
    self.conn.autocommit = False
    return self

  def __exit__(self, exc_type, exc, tb):
    try:
      if exc:
        self.conn.rollback()
    finally:
      self.conn.close()

  def find_product_id(self, *, brand: str, name: str) -> Optional[str]:
    with self.conn.cursor() as cur:
      cur.execute('SELECT id FROM "products" WHERE brand = %s AND name = %s LIMIT 1;', (brand, name))
      row = cur.fetchone()
      return row[0] if row else None

  def delete_product(self, product_id: str) -> None:
    with self.conn.cursor() as cur:
      cur.execute('DELETE FROM "products" WHERE id = %s;', (product_id,))

  def insert_product(self, sku: InputSku, *, product_id: str) -> None:
    with self.conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO "products" (id, brand, name, price_usd, price_cny, product_url, image_url, created_at, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW());
        """,
        (
          product_id,
          sku.brand,
          sku.name,
          sku.price_usd,
          sku.price_cny,
          sku.product_url,
          sku.image_url,
        ),
      )

  def insert_vectors(
    self,
    *,
    product_id: str,
    vector_id: str,
    mechanism: Dict[str, Any],
    experience: Dict[str, Any],
    risk_flags: List[str],
    embedding: Optional[List[float]],
  ) -> None:
    with self.conn.cursor() as cur:
      if embedding is None:
        cur.execute(
          """
          INSERT INTO "sku_vectors" (id, product_id, mechanism, experience, risk_flags, embedding)
          VALUES (%s, %s, %s, %s, %s, NULL);
          """,
          (vector_id, product_id, Json(mechanism), Json(experience), risk_flags),
        )
        return

      cur.execute(
        """
        INSERT INTO "sku_vectors" (id, product_id, mechanism, experience, risk_flags, embedding)
        VALUES (%s, %s, %s, %s, %s, %s::vector);
        """,
        (vector_id, product_id, Json(mechanism), Json(experience), risk_flags, embedding_to_vector_literal(embedding)),
      )

  def insert_ingredients(self, *, product_id: str, ingredient_id: str, full_list: List[str]) -> None:
    with self.conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO "ingredients" (id, product_id, full_list, hero_actives)
        VALUES (%s, %s, %s, %s);
        """,
        (ingredient_id, product_id, full_list, Json([])),
      )


def _get_excel_rows(path: str, sheet: Optional[str]) -> Tuple[List[str], Iterable[List[Any]]]:
  wb = load_workbook(path, read_only=True, data_only=True)
  ws = wb[sheet] if sheet else wb.active

  rows = ws.iter_rows(values_only=True)
  header = next(rows, None)
  if not header:
    raise RuntimeError("Excel appears empty (missing header row)")

  headers = [str(h).strip() if h is not None else "" for h in header]
  return headers, rows


def _pick_column(headers: List[str], preferred: str) -> int:
  lowered = [h.strip().lower() for h in headers]
  key = preferred.strip().lower()
  if key in lowered:
    return lowered.index(key)
  raise RuntimeError(f"Missing required column: {preferred} (available: {headers})")


def load_input_skus_from_excel(
  *,
  path: str,
  sheet: Optional[str],
  col_brand: str,
  col_name: str,
  col_ingredients: str,
  col_price_usd: Optional[str],
  col_price: Optional[str],
  price_cny_rate: float,
  col_product_url: Optional[str],
  col_image_url: Optional[str],
  limit: Optional[int],
) -> List[InputSku]:
  headers, rows = _get_excel_rows(path, sheet)

  idx_brand = _pick_column(headers, col_brand)
  idx_name = _pick_column(headers, col_name)
  idx_ing = _pick_column(headers, col_ingredients)

  idx_price_usd = _pick_column(headers, col_price_usd) if col_price_usd else None
  idx_price = _pick_column(headers, col_price) if col_price else None

  idx_product_url = _pick_column(headers, col_product_url) if col_product_url else None
  idx_image_url = _pick_column(headers, col_image_url) if col_image_url else None

  skus: List[InputSku] = []
  for r in rows:
    if r is None:
      continue
    brand = (r[idx_brand] if idx_brand < len(r) else "") or ""
    name = (r[idx_name] if idx_name < len(r) else "") or ""
    ingredients = (r[idx_ing] if idx_ing < len(r) else "") or ""
    if not str(brand).strip() or not str(name).strip() or not str(ingredients).strip():
      continue

    price_usd: Optional[float] = None
    if idx_price_usd is not None:
      raw = r[idx_price_usd] if idx_price_usd < len(r) else None
      if raw is not None and str(raw).strip():
        price_usd = float(raw)

    if price_usd is None and idx_price is not None:
      raw = r[idx_price] if idx_price < len(r) else None
      if raw is not None and str(raw).strip():
        price_usd = float(raw)

    if price_usd is None:
      price_usd = 0.0

    product_url = None
    if idx_product_url is not None:
      raw = r[idx_product_url] if idx_product_url < len(r) else None
      if raw is not None and str(raw).strip():
        product_url = str(raw).strip()

    image_url = None
    if idx_image_url is not None:
      raw = r[idx_image_url] if idx_image_url < len(r) else None
      if raw is not None and str(raw).strip():
        image_url = str(raw).strip()

    skus.append(
      InputSku(
        brand=str(brand).strip(),
        name=str(name).strip(),
        ingredients_text=str(ingredients).strip(),
        price_usd=float(price_usd),
        price_cny=float(price_usd) * price_cny_rate,
        product_url=product_url,
        image_url=image_url,
      )
    )

    if limit is not None and len(skus) >= limit:
      break

  return skus


def demo_skus() -> List[InputSku]:
  return [
    InputSku(
      brand="Tom Ford",
      name="Research Serum Concentrate",
      price_usd=350.0,
      price_cny=2800.0,
      product_url="https://www.tomfordbeauty.com/...",
      ingredients_text="Water, Caffeine, Theobroma Cacao, Glycolic Acid, Alcohol Denat",
    ),
    InputSku(
      brand="The Ordinary",
      name="Buffet + Copper Peptides 1%",
      price_usd=30.0,
      price_cny=240.0,
      ingredients_text="Water, Glycerin, Copper Tripeptide-1, Lactococcus Ferment",
    ),
    InputSku(
      brand="Helena Rubinstein",
      name="Re-Plasty Age Recovery Night Cream (Black Bandage)",
      price_usd=460.0,
      price_cny=3900.0,
      ingredients_text="Water, Glycerin, Shea Butter, Dimethicone, Madecassoside, Fragrance",
      product_url="https://www.helenarubinstein.com/...",
    ),
  ]


def ingest_one(
  *,
  db: AuroraDb,
  client: OpenAI,
  llm_model: str,
  embedding_model: str,
  sku: InputSku,
  overwrite: bool,
  enable_embedding: bool,
  dry_run: bool,
) -> None:
  print(f"🧪 Processing: {sku.brand} - {sku.name} ...")

  vectors = get_vectors_from_llm(client, model=llm_model, brand=sku.brand, name=sku.name, ingredients=sku.ingredients_text)
  embedding: Optional[List[float]] = None
  if enable_embedding:
    embedding = get_embedding(client, model=embedding_model, text=sku.ingredients_text)

  if dry_run:
    print(json.dumps({"product": {"brand": sku.brand, "name": sku.name}, "vectors": vectors}, ensure_ascii=False))
    return

  existing_id = db.find_product_id(brand=sku.brand, name=sku.name)
  if existing_id and overwrite:
    db.delete_product(existing_id)
    db.conn.commit()

  if existing_id and not overwrite:
    print(f"↩️  Skipped (exists): {sku.brand} - {sku.name}")
    return

  product_id = str(uuid.uuid4())
  vector_id = str(uuid.uuid4())
  ingredient_id = str(uuid.uuid4())

  try:
    db.insert_product(sku, product_id=product_id)
    db.insert_vectors(
      product_id=product_id,
      vector_id=vector_id,
      mechanism=vectors["mechanism"],
      experience=vectors["experience_prediction"],
      risk_flags=vectors["risk_flags"],
      embedding=embedding,
    )
    db.insert_ingredients(product_id=product_id, ingredient_id=ingredient_id, full_list=parse_ingredients_list(sku.ingredients_text))
    db.conn.commit()
    print(f"✅ Ingested: {sku.brand} - {sku.name}")
  except BaseException:  # noqa: BLE001
    db.conn.rollback()
    raise


def main() -> None:
  parser = argparse.ArgumentParser(description="Aurora vectorization + embedding ETL (Excel → OpenAI → Railway Postgres)")
  parser.add_argument("--demo", action="store_true", help="Ingest 3 demo products (Tom Ford / The Ordinary / HR).")
  parser.add_argument("--input", type=str, help="Path to Excel (.xlsx) file.")
  parser.add_argument("--sheet", type=str, default=None, help="Excel sheet name (default: active sheet).")
  parser.add_argument("--limit", type=int, default=None, help="Max rows to ingest (for testing).")

  parser.add_argument("--col-brand", type=str, default="brand")
  parser.add_argument("--col-name", type=str, default="name")
  parser.add_argument("--col-ingredients", type=str, default="ingredients")
  parser.add_argument("--col-price-usd", type=str, default="price_usd")
  parser.add_argument("--col-price", type=str, default=None, help="Fallback price column if price_usd not present.")
  parser.add_argument("--price-cny-rate", type=float, default=7.2)
  parser.add_argument("--col-product-url", type=str, default=None)
  parser.add_argument("--col-image-url", type=str, default=None)

  parser.add_argument("--llm-model", type=str, default="gpt-4o")
  parser.add_argument("--embedding-model", type=str, default="text-embedding-3-small")
  parser.add_argument("--no-embedding", action="store_true")
  parser.add_argument("--overwrite", action="store_true", help="Overwrite existing rows by (brand,name).")
  parser.add_argument("--dry-run", action="store_true", help="Call OpenAI but do not write to DB.")

  args = parser.parse_args()

  load_dotenv()
  database_url = _require_env("DATABASE_URL")
  api_key = _require_env("OPENAI_API_KEY")

  if not args.demo and not args.input:
    raise SystemExit("Provide --demo or --input /path/to.xlsx")

  openai_client = OpenAI(api_key=api_key)

  if args.demo:
    skus = demo_skus()
  else:
    skus = load_input_skus_from_excel(
      path=args.input,
      sheet=args.sheet,
      col_brand=args.col_brand,
      col_name=args.col_name,
      col_ingredients=args.col_ingredients,
      col_price_usd=args.col_price_usd,
      col_price=args.col_price,
      price_cny_rate=float(args.price_cny_rate),
      col_product_url=args.col_product_url,
      col_image_url=args.col_image_url,
      limit=args.limit,
    )

  if not skus:
    print("No rows found to ingest.")
    return

  with AuroraDb(database_url) as db:
    for sku in skus:
      ingest_one(
        db=db,
        client=openai_client,
        llm_model=args.llm_model,
        embedding_model=args.embedding_model,
        sku=sku,
        overwrite=bool(args.overwrite),
        enable_embedding=not bool(args.no_embedding),
        dry_run=bool(args.dry_run),
      )


if __name__ == "__main__":
  main()

