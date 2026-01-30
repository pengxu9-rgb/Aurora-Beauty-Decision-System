import argparse
import json
import os
import re
import time
import uuid
import unicodedata
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

import psycopg2
import requests
from dotenv import load_dotenv
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
  },
  "social_stats": {
    "red_score": int,
    "reddit_score": int,
    "burn_rate": number,
    "top_keywords": [str]
  }
}
""".strip()

SOCIAL_PROMPT = """
You are a Beauty Trend Analyst. Based on your internal training data (internet discussions from Reddit/SkincareAddiction, XiaoHongShu/RED, TikTok), estimate the social sentiment for this product.

Product: {brand} - {name}

Rules for Estimation:
1) RED Score (0-100): High if popular in Asia, whitening/texture focused. Penalty for "Fake Slip" (假滑).
2) Reddit Score (0-100): High if ingredient-focused, fragrance-free, matte finish.
3) Burn Rate (0.0 - 1.0): Estimate probability of irritation complaints (e.g., 0.15 for high acid/retinol, 0.01 for gentle cleansers). Use >0.30 only for extremely irritating formulas.
4) Keywords: Extract 3-5 typical user tags (e.g., "HolyGrail", "Stings", "Pilling").

Output JSON:
{
  "redScore": int,
  "redditScore": int,
  "burnRate": float,
  "topKeywords": [str]
}
""".strip()

DEFAULT_GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_EMBEDDING_DIM = 1536
ENV_TEMPLATE_RE = re.compile(r"\$\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


@dataclass(frozen=True)
class InputSku:
  brand: str
  name: str
  ingredients_text: str
  price_usd: float
  price_cny: float
  availability: Optional[List[str]] = None
  product_url: Optional[str] = None
  image_url: Optional[str] = None


@dataclass(frozen=True)
class KbSnippet:
  brand: str
  name: str
  source_sheet: str
  field: str
  content: str
  metadata: Dict[str, Any]


def _require_env(name: str) -> str:
  value = (os.getenv(name) or "").strip()
  if not value:
    raise RuntimeError(f"Missing required env var: {name}")
  return value


def _require_any_env(names: List[str]) -> str:
  for name in names:
    value = (os.getenv(name) or "").strip()
    if value:
      return value
  raise RuntimeError(f"Missing required env var (one of): {', '.join(names)}")


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


def resolve_env_templates(value: str) -> str:
  # Railway sometimes provides templated variables like:
  # postgresql://...@${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}/railway
  # These only resolve inside Railway. For local runs, we either substitute from env vars
  # (if provided) or raise a friendly error.
  if "${{" not in value:
    return value

  missing: List[str] = []

  def _repl(match: re.Match[str]) -> str:
    key = match.group(1)
    resolved = (os.getenv(key) or "").strip()
    if not resolved:
      missing.append(key)
      return match.group(0)
    return resolved

  rendered = ENV_TEMPLATE_RE.sub(_repl, value)
  if missing:
    raise RuntimeError(
      "DATABASE_URL contains Railway template placeholders that are not resolvable locally: "
      + ", ".join(sorted(set(missing)))
      + ".\nFix: set DATABASE_URL to Railway Postgres **Public connection string** (with real host/port), "
      + "or export those variables before running the script."
    )

  if "${{" in rendered:
    raise RuntimeError("DATABASE_URL still contains unresolved template placeholders after substitution.")

  return rendered


def _extract_json_object(text: str) -> Dict[str, Any]:
  try:
    return json.loads(text)
  except Exception:  # noqa: BLE001
    # Best-effort: trim code fences / surrounding commentary.
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
      return json.loads(text[start : end + 1])
    raise


def _get_first_candidate_text(payload: Dict[str, Any]) -> str:
  candidates = payload.get("candidates") or []
  if not candidates:
    raise RuntimeError(f"Gemini response missing candidates: {payload}")
  content = (candidates[0] or {}).get("content") or {}
  parts = content.get("parts") or []
  if not parts:
    raise RuntimeError(f"Gemini response missing content parts: {payload}")
  text = (parts[0] or {}).get("text")
  if not isinstance(text, str) or not text.strip():
    raise RuntimeError(f"Gemini response missing text: {payload}")
  return text


class GeminiClient:
  def __init__(self, *, api_key: str, api_base_url: str):
    self._api_key = api_key
    self._api_base_url = api_base_url.rstrip("/")
    self._session = requests.Session()
    self._session.headers.update({"Content-Type": "application/json"})

  @staticmethod
  def normalize_model_name(model: str) -> str:
    # ListModels returns names like "models/gemini-2.5-flash". Our URL already includes "/models/".
    # Accept either "gemini-2.5-flash" or "models/gemini-2.5-flash".
    model = model.strip()
    if model.startswith("models/"):
      return model[len("models/") :]
    return model

  def list_models(self) -> List[Dict[str, Any]]:
    url = f"{self._api_base_url}/models"

    def _call():
      resp = self._session.get(url, params={"key": self._api_key}, timeout=60)
      if resp.status_code >= 400:
        raise RuntimeError(f"Gemini ListModels failed ({resp.status_code}): {resp.text[:500]}")
      return resp.json()

    payload = _retry(_call, tries=3, base_sleep_s=1.0)
    models = payload.get("models") or []
    if not isinstance(models, list):
      raise RuntimeError(f"Gemini ListModels response invalid: {payload}")
    return models

  def generate_json(self, *, model: str, system_prompt: str, user_prompt: str) -> Dict[str, Any]:
    model_id = self.normalize_model_name(model)
    url = f"{self._api_base_url}/models/{model_id}:generateContent"
    body = {
      "systemInstruction": {
        "parts": [
          {
            "text": system_prompt
            + "\n\nOutput MUST be valid JSON (no markdown, no code fences, double quotes only, no trailing commas)."
          }
        ]
      },
      "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
      "generationConfig": {
        "temperature": 0.0,
        "responseMimeType": "application/json",
        # Give the model enough room; malformed JSON often comes from truncation.
        "maxOutputTokens": 2048,
      },
    }

    def _call():
      resp = self._session.post(url, params={"key": self._api_key}, json=body, timeout=60)
      if resp.status_code >= 400:
        if resp.status_code == 404:
          raise RuntimeError(
            f"Gemini generateContent failed (404): model '{model}' not found / not supported on '{self._api_base_url}'. "
            f"Tip: run with --list-models to see available models, or set GEMINI_API_BASE_URL "
            f"to switch API version (e.g. https://generativelanguage.googleapis.com/v1). "
            f"Raw: {resp.text[:400]}"
          )
        raise RuntimeError(f"Gemini generateContent failed ({resp.status_code}): {resp.text[:500]}")
      payload = resp.json()
      text = _get_first_candidate_text(payload)
      # Parse inside retry so transient malformed outputs can be retried.
      return _extract_json_object(text)

    data = _retry(_call, tries=3, base_sleep_s=1.0)
    if not isinstance(data, dict):
      raise RuntimeError(f"Gemini JSON output is not an object: {type(data)}")
    return data

  def embed_text(self, *, model: str, text: str) -> List[float]:
    model_id = self.normalize_model_name(model)
    url = f"{self._api_base_url}/models/{model_id}:embedContent"
    body = {"content": {"parts": [{"text": text}]}}

    def _call():
      resp = self._session.post(url, params={"key": self._api_key}, json=body, timeout=60)
      if resp.status_code >= 400:
        raise RuntimeError(f"Gemini embedContent failed ({resp.status_code}): {resp.text[:500]}")
      return resp.json()

    payload = _retry(_call, tries=3, base_sleep_s=1.0)
    embedding = (payload.get("embedding") or {}).get("values")
    if not isinstance(embedding, list) or not embedding:
      raise RuntimeError(f"Gemini embedding missing values: {payload}")
    return [float(x) for x in embedding]


def normalize_embedding_dim(embedding: List[float], *, dim: int) -> List[float]:
  if len(embedding) == dim:
    return embedding
  if len(embedding) < dim:
    # Zero-padding keeps cosine similarity identical in the original subspace.
    return embedding + [0.0] * (dim - len(embedding))
  # Truncate to fit the DB column (vector(dim)). This is an MVP trade-off.
  # If you want full fidelity, migrate the DB column to vector(len(embedding)).
  print(f"⚠️ Embedding dim {len(embedding)} > {dim}; truncating to {dim}.")
  return embedding[:dim]


def _clamp_int(value: Any, *, min_value: int, max_value: int) -> int:
  try:
    n = int(float(value))
  except Exception:  # noqa: BLE001
    n = min_value
  if n < min_value:
    return min_value
  if n > max_value:
    return max_value
  return n


def _clamp_float(value: Any, *, min_value: float, max_value: float) -> float:
  try:
    n = float(value)
  except Exception:  # noqa: BLE001
    n = min_value
  if n < min_value:
    return min_value
  if n > max_value:
    return max_value
  return n


def _coerce_keywords(value: Any) -> List[str]:
  if isinstance(value, list):
    out = [str(x).strip() for x in value if str(x).strip()]
    return out[:8]
  if isinstance(value, str) and value.strip():
    # Allow comma-separated strings.
    parts = [p.strip() for p in value.split(",")]
    return [p for p in parts if p][:8]
  return []


def get_social_simulation_openai(
  *,
  brand: str,
  name: str,
  ingredients_text: Optional[str],
  api_key: str,
  model: str,
  api_base_url: str,
) -> Dict[str, Any]:
  url = api_base_url.rstrip("/") + "/chat/completions"

  system_prompt = SOCIAL_PROMPT.format(brand=brand, name=name)
  user_prompt = f"Product: {brand} - {name}\n"
  if ingredients_text:
    user_prompt += f"Ingredients: {ingredients_text}\n"

  body = {
    "model": model,
    "temperature": 0.2,
    "response_format": {"type": "json_object"},
    "messages": [
      {"role": "system", "content": system_prompt},
      {"role": "user", "content": user_prompt},
    ],
  }

  headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

  def _call():
    resp = requests.post(url, headers=headers, json=body, timeout=60)
    if resp.status_code >= 400:
      raise RuntimeError(f"OpenAI chat.completions failed ({resp.status_code}): {resp.text[:500]}")
    payload = resp.json()
    content = ((payload.get("choices") or [{}])[0].get("message") or {}).get("content")
    if not isinstance(content, str) or not content.strip():
      raise RuntimeError(f"OpenAI response missing content: {payload}")
    data = _extract_json_object(content)
    if not isinstance(data, dict):
      raise RuntimeError("OpenAI social simulation output is not an object")
    return data

  raw = _retry(_call, tries=3, base_sleep_s=1.0)

  # Normalize to internal schema expected by DB insert (snake_case), keep both keys for debugging if needed.
  return {
    "red_score": _clamp_int(raw.get("redScore"), min_value=0, max_value=100),
    "reddit_score": _clamp_int(raw.get("redditScore"), min_value=0, max_value=100),
    "burn_rate": _clamp_float(raw.get("burnRate"), min_value=0.0, max_value=1.0),
    "top_keywords": _coerce_keywords(raw.get("topKeywords")),
    "_raw": raw,
  }


def get_vectors_from_llm(client: GeminiClient, *, model: str, brand: str, name: str, ingredients: str) -> Dict[str, Any]:
  prompt = f"Product: {brand} {name}\nIngredients: {ingredients}"

  data = client.generate_json(model=model, system_prompt=SYSTEM_PROMPT, user_prompt=prompt)

  mechanism = data.get("mechanism") or {}
  risk_flags = data.get("risk_flags") or []
  experience = data.get("experience_prediction") or {}
  social = data.get("social_stats") or {}

  if not isinstance(mechanism, dict):
    raise ValueError("LLM output invalid: `mechanism` must be an object")
  if not isinstance(risk_flags, list):
    raise ValueError("LLM output invalid: `risk_flags` must be a list")
  if not isinstance(experience, dict):
    raise ValueError("LLM output invalid: `experience_prediction` must be an object")
  if social and not isinstance(social, dict):
    raise ValueError("LLM output invalid: `social_stats` must be an object when present")

  def _clamp_int_0_100(value: Any) -> int:
    try:
      n = int(round(float(value)))
    except Exception:  # noqa: BLE001
      return 0
    return max(0, min(100, n))

  def _clamp_float_0_1(value: Any) -> float:
    try:
      n = float(value)
    except Exception:  # noqa: BLE001
      return 0.0
    if n < 0:
      return 0.0
    if n > 1:
      return 1.0
    return n

  cleaned_risk_flags = [str(x).strip() for x in risk_flags if str(x).strip()]

  def _default_burn_rate(flags: List[str]) -> float:
    lower = [f.lower() for f in flags]
    if any("high_irritation" in f or "irritation" in f for f in lower):
      return 0.15
    if any("alcohol" in f for f in lower) or any("acid" in f for f in lower):
      return 0.08
    return 0.03

  # Social stats are often not available from ingredients alone; we accept LLM-provided estimates
  # but also provide safe defaults so the pipeline is usable out-of-the-box.
  red_score = _clamp_int_0_100(social.get("red_score", 60) if isinstance(social, dict) else 60)
  reddit_score = _clamp_int_0_100(social.get("reddit_score", 60) if isinstance(social, dict) else 60)
  burn_rate = _clamp_float_0_1(social.get("burn_rate", _default_burn_rate(cleaned_risk_flags)) if isinstance(social, dict) else _default_burn_rate(cleaned_risk_flags))

  top_keywords_raw = social.get("top_keywords", []) if isinstance(social, dict) else []
  if isinstance(top_keywords_raw, str):
    top_keywords = [t.strip() for t in top_keywords_raw.split(",") if t.strip()]
  elif isinstance(top_keywords_raw, list):
    top_keywords = [str(t).strip() for t in top_keywords_raw if str(t).strip()]
  else:
    top_keywords = []

  normalized = {
    "mechanism": {
      "oil_control": _clamp_int_0_100(mechanism.get("oil_control", 0)),
      "anti_aging": _clamp_int_0_100(mechanism.get("anti_aging", 0)),
      "soothing": _clamp_int_0_100(mechanism.get("soothing", 0)),
      "barrier_repair": _clamp_int_0_100(mechanism.get("barrier_repair", 0)),
    },
    "risk_flags": cleaned_risk_flags,
    "experience_prediction": {
      "texture": str(experience.get("texture", "")).strip() or "unknown",
      "finish": str(experience.get("finish", "")).strip() or "natural",
    },
    "social_stats": {
      "red_score": red_score,
      "reddit_score": reddit_score,
      "burn_rate": burn_rate,
      "top_keywords": top_keywords[:20],
    },
  }

  return normalized


def get_embedding(client: GeminiClient, *, model: str, text: str) -> List[float]:
  floats = client.embed_text(model=model, text=text)
  return normalize_embedding_dim(floats, dim=DEFAULT_EMBEDDING_DIM)


def embedding_to_vector_literal(embedding: List[float]) -> str:
  # pgvector accepts a text literal like: '[0.1, -0.2, ...]'::vector
  return "[" + ",".join(f"{x:.8f}" for x in embedding) + "]"


def parse_ingredients_list(text: str) -> List[str]:
  # Keep it simple: split by comma; Excel sheets commonly store INCI as comma-separated.
  items = [t.strip() for t in text.split(",")]
  return [t for t in items if t]


def split_brand_and_name(product_full_name: str) -> Tuple[str, str]:
  """
  Best-effort brand/name split for sheets that only have a single "Product" column.

  Strategy:
  - Prefer matching known multi-word brands (longest-first).
  - Fallback to first token as brand.
  - Keep name as the remainder (or full string if unknown).
  """
  full = (product_full_name or "").strip()
  if not full:
    return ("Unknown", "")

  known_multi = sorted(
    [
      "La Roche-Posay",
      "Paula's Choice",
      "The Ordinary",
      "Estée Lauder",
      "Estee Lauder",
      "First Aid Beauty",
      "Beauty of Joseon",
      "Helena Rubinstein",
      "SkinCeuticals",
      "La Mer",
      "Tom Ford",
      "Hada Labo",
    ],
    key=len,
    reverse=True,
  )

  lower = full.lower()
  for b in known_multi:
    if lower.startswith(b.lower()):
      rest = full[len(b) :].strip()
      rest = rest.lstrip("-–—:").strip()
      return (b, rest or full)

  # Fallback: first token as brand.
  first = full.split(" ")[0].strip()
  if not first:
    return ("Unknown", full)
  rest = full[len(first) :].strip()
  rest = rest.lstrip("-–—:").strip()
  return (first, rest or full)


def canonicalize_kb_field(label: str) -> str:
  value = (label or "").strip().lower()
  value = re.sub(r"[^a-z0-9]+", "_", value)
  value = value.strip("_")
  return value[:64] or "unknown"


def normalize_match_key(text: str) -> str:
  value = unicodedata.normalize("NFKD", str(text or ""))
  value = "".join(ch for ch in value if not unicodedata.combining(ch))
  value = value.lower()
  value = re.sub(r"[^a-z0-9]+", "", value)
  return value


def _cell_text(value: Any) -> str:
  if value is None:
    return ""
  s = str(value).strip()
  if not s or s.lower() == "nan":
    return ""
  return s


def extract_kb_snippets_from_workbook(*, path: str) -> List[KbSnippet]:
  """
  Extract non-ingredient notes from all sheets in the workbook.

  We intentionally skip Ingredients/Source columns (already stored elsewhere).
  """
  wb = load_workbook(path, read_only=True, data_only=True)
  out: List[KbSnippet] = []

  for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    rows = ws.iter_rows(values_only=True)
    header = next(rows, None)
    if not header:
      continue

    headers = [str(h).strip() if h is not None else "" for h in header]
    headers_lc = [h.strip().lower() for h in headers]

    if "product" not in headers_lc:
      continue
    idx_product = headers_lc.index("product")
    idx_source = headers_lc.index("source") if "source" in headers_lc else None

    skip = {"product", "ingredients (as listed)", "ingredients", "source"}
    note_cols: List[Tuple[int, str]] = []
    for j, label in enumerate(headers):
      if not label.strip():
        continue
      if label.strip().lower() in skip:
        continue
      note_cols.append((j, label))

    if not note_cols:
      continue

    for row_number, r in enumerate(rows, start=2):
      if not r or idx_product >= len(r):
        continue
      product_full = _cell_text(r[idx_product])
      if not product_full:
        continue
      brand, name = split_brand_and_name(product_full)

      source_url = ""
      if idx_source is not None and idx_source < len(r):
        source_url = _cell_text(r[idx_source])

      for j, label in note_cols:
        if j >= len(r):
          continue
        content = _cell_text(r[j])
        if len(content) < 2:
          continue
        meta: Dict[str, Any] = {
          "source_file": os.path.basename(path),
          "source_sheet": sheet_name,
          "field_label": label,
          "row_number": row_number,
          "product_full_name": product_full,
        }
        if source_url:
          meta["source"] = source_url

        out.append(
          KbSnippet(
            brand=brand,
            name=name,
            source_sheet=sheet_name,
            field=canonicalize_kb_field(label),
            content=content,
            metadata=meta,
          )
        )

  return out


class AuroraDb:
  def __init__(self, database_url: str):
    self._database_url = database_url
    self._has_region_availability = False
    self._has_kb_snippets_table = False

  def __enter__(self):
    self.conn = psycopg2.connect(self._database_url)
    self.conn.autocommit = False
    self._has_region_availability = self._ensure_region_availability_column()
    self._has_kb_snippets_table = self._ensure_kb_snippets_table()
    return self

  def __exit__(self, exc_type, exc, tb):
    try:
      if exc:
        self.conn.rollback()
    finally:
      self.conn.close()

  def _ensure_region_availability_column(self) -> bool:
    """
    Best-effort schema guard.

    The ingestion JSON may include `availability: ["CN","US"]`. We store it in
    products.region_availability (TEXT[]). If the column does not exist yet,
    attempt to add it. If we cannot, we degrade gracefully and skip writing it.
    """
    try:
      with self.conn.cursor() as cur:
        cur.execute(
          """
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'products'
            AND column_name = 'region_availability'
          LIMIT 1;
          """
        )
        if cur.fetchone():
          return True

        cur.execute(
          'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS region_availability TEXT[] NOT NULL DEFAULT \'{}\'::text[];'
        )
        self.conn.commit()
        return True
    except BaseException:  # noqa: BLE001
      try:
        self.conn.rollback()
      except BaseException:  # noqa: BLE001
        pass
      print("⚠️  Could not ensure products.region_availability column; continuing without it.")
      return False

  def _ensure_kb_snippets_table(self) -> bool:
    try:
      with self.conn.cursor() as cur:
        cur.execute(
          """
          CREATE TABLE IF NOT EXISTS "product_kb_snippets" (
            id UUID PRIMARY KEY,
            product_id UUID NOT NULL REFERENCES "products"(id) ON DELETE CASCADE,
            source_sheet TEXT NOT NULL,
            field TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT product_kb_snippets_product_sheet_field_uidx UNIQUE (product_id, source_sheet, field)
          );
          """
        )
        # If the table existed without the unique constraint, ensure a unique index exists so
        # our ON CONFLICT (product_id, source_sheet, field) upsert works.
        cur.execute(
          'CREATE UNIQUE INDEX IF NOT EXISTS product_kb_snippets_product_sheet_field_uidx ON "product_kb_snippets"(product_id, source_sheet, field);'
        )
        cur.execute('CREATE INDEX IF NOT EXISTS product_kb_snippets_product_id_idx ON "product_kb_snippets"(product_id);')
      self.conn.commit()
      return True
    except BaseException:  # noqa: BLE001
      try:
        self.conn.rollback()
      except BaseException:  # noqa: BLE001
        pass
      print("⚠️  Could not ensure product_kb_snippets table; continuing without KB ingestion.")
      return False

  def find_product_id(self, *, brand: str, name: str) -> Optional[str]:
    with self.conn.cursor() as cur:
      cur.execute('SELECT id FROM "products" WHERE brand = %s AND name = %s LIMIT 1;', (brand, name))
      row = cur.fetchone()
      return row[0] if row else None

  def load_all_product_ids(self) -> Dict[Tuple[str, str], str]:
    with self.conn.cursor() as cur:
      cur.execute('SELECT brand, name, id FROM "products";')
      rows = cur.fetchall()
      out: Dict[Tuple[str, str], str] = {}
      for brand, name, pid in rows:
        out[(str(brand), str(name))] = str(pid)
      return out

  def load_all_product_ids_normalized(self) -> Dict[Tuple[str, str], str]:
    with self.conn.cursor() as cur:
      cur.execute('SELECT brand, name, id FROM "products";')
      rows = cur.fetchall()
      out: Dict[Tuple[str, str], str] = {}
      for brand, name, pid in rows:
        key = (normalize_match_key(str(brand)), normalize_match_key(str(name)))
        # If collisions occur, keep the first seen to avoid flapping.
        out.setdefault(key, str(pid))
      return out

  def delete_product(self, product_id: str) -> None:
    with self.conn.cursor() as cur:
      cur.execute('DELETE FROM "products" WHERE id = %s;', (product_id,))

  def upsert_product(self, sku: InputSku, *, product_id: str) -> None:
    with self.conn.cursor() as cur:
      if self._has_region_availability:
        availability = list(sku.availability or [])
        cur.execute(
          """
          INSERT INTO "products" (
            id,
            brand,
            name,
            price_usd,
            price_cny,
            product_url,
            image_url,
            region_availability,
            created_at,
            updated_at
          )
          VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET
            brand = EXCLUDED.brand,
            name = EXCLUDED.name,
            price_usd = EXCLUDED.price_usd,
            price_cny = EXCLUDED.price_cny,
            product_url = EXCLUDED.product_url,
            image_url = EXCLUDED.image_url,
            region_availability = EXCLUDED.region_availability,
            updated_at = NOW();
          """,
          (product_id, sku.brand, sku.name, sku.price_usd, sku.price_cny, sku.product_url, sku.image_url, availability),
        )
        return

      # Backward-compatible path if the DB column is missing.
      cur.execute(
        """
        INSERT INTO "products" (id, brand, name, price_usd, price_cny, product_url, image_url, created_at, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          brand = EXCLUDED.brand,
          name = EXCLUDED.name,
          price_usd = EXCLUDED.price_usd,
          price_cny = EXCLUDED.price_cny,
          product_url = EXCLUDED.product_url,
          image_url = EXCLUDED.image_url,
          updated_at = NOW();
        """,
        (product_id, sku.brand, sku.name, sku.price_usd, sku.price_cny, sku.product_url, sku.image_url),
      )

  def delete_vectors_for_product(self, product_id: str) -> None:
    with self.conn.cursor() as cur:
      cur.execute('DELETE FROM "sku_vectors" WHERE product_id = %s;', (product_id,))

  def delete_ingredients_for_product(self, product_id: str) -> None:
    with self.conn.cursor() as cur:
      cur.execute('DELETE FROM "ingredients" WHERE product_id = %s;', (product_id,))

  def delete_social_stats_for_product(self, product_id: str) -> None:
    with self.conn.cursor() as cur:
      cur.execute('DELETE FROM "social_stats" WHERE product_id = %s;', (product_id,))

  def insert_product(self, sku: InputSku, *, product_id: str) -> None:
    with self.conn.cursor() as cur:
      if self._has_region_availability:
        availability = list(sku.availability or [])
        cur.execute(
          """
          INSERT INTO "products" (
            id,
            brand,
            name,
            price_usd,
            price_cny,
            product_url,
            image_url,
            region_availability,
            created_at,
            updated_at
          )
          VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW());
          """,
          (product_id, sku.brand, sku.name, sku.price_usd, sku.price_cny, sku.product_url, sku.image_url, availability),
        )
        return

      # Backward-compatible path if the DB column is missing.
      cur.execute(
        """
        INSERT INTO "products" (id, brand, name, price_usd, price_cny, product_url, image_url, created_at, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW());
        """,
        (product_id, sku.brand, sku.name, sku.price_usd, sku.price_cny, sku.product_url, sku.image_url),
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

  def insert_social_stats(
    self,
    *,
    product_id: str,
    social_id: str,
    red_score: int,
    reddit_score: int,
    burn_rate: float,
    top_keywords: List[str],
  ) -> None:
    with self.conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO "social_stats" (id, product_id, red_score, reddit_score, burn_rate, top_keywords, last_updated)
        VALUES (%s, %s, %s, %s, %s, %s, NOW());
        """,
        (social_id, product_id, red_score, reddit_score, burn_rate, top_keywords),
      )

  def upsert_kb_snippet(
    self,
    *,
    product_id: str,
    source_sheet: str,
    field: str,
    content: str,
    metadata: Dict[str, Any],
  ) -> None:
    if not self._has_kb_snippets_table:
      return
    with self.conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO "product_kb_snippets" (id, product_id, source_sheet, field, content, metadata, created_at, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, NOW(), NOW())
        ON CONFLICT (product_id, source_sheet, field) DO UPDATE SET
          content = EXCLUDED.content,
          metadata = EXCLUDED.metadata,
          updated_at = NOW();
        """,
        (str(uuid.uuid4()), product_id, source_sheet, field, content, Json(metadata)),
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


def _pick_column(headers: List[str], preferred: Optional[str], *, required: bool = True) -> Optional[int]:
  if preferred is None:
    return None
  lowered = [h.strip().lower() for h in headers]
  key = preferred.strip().lower()
  if key in lowered:
    return lowered.index(key)
  if required:
    raise RuntimeError(f"Missing required column: {preferred} (available: {headers})")
  return None


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

  idx_price_usd = _pick_column(headers, col_price_usd, required=False)
  idx_price = _pick_column(headers, col_price, required=False)

  idx_product_url = _pick_column(headers, col_product_url, required=False)
  idx_image_url = _pick_column(headers, col_image_url, required=False)

  skus: List[InputSku] = []
  for r in rows:
    if r is None:
      continue
    brand = (r[idx_brand] if idx_brand < len(r) else "") or ""
    name = (r[idx_name] if idx_name < len(r) else "") or ""
    ingredients = (r[idx_ing] if idx_ing < len(r) else "") or ""
    if not str(brand).strip() or not str(name).strip() or not str(ingredients).strip():
      continue

    # Some source sheets only have a single "Product" column. If the user maps
    # both --col-brand and --col-name to that column, split brand/name here.
    if idx_brand == idx_name:
      inferred_brand, inferred_name = split_brand_and_name(str(brand).strip())
      brand = inferred_brand
      name = inferred_name

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
        availability=["Global"],
        product_url=product_url,
        image_url=image_url,
      )
    )

    if limit is not None and len(skus) >= limit:
      break

  return skus


def load_input_skus_from_json(*, path: str, price_cny_rate: float, limit: Optional[int]) -> List[InputSku]:
  with open(path, "r", encoding="utf-8") as f:
    payload = json.load(f)

  items = payload.get("items") if isinstance(payload, dict) else payload
  if not isinstance(items, list):
    raise RuntimeError("JSON input must be a list of items (or {\"items\": [...]}).")

  skus: List[InputSku] = []
  for i, raw in enumerate(items):
    if not isinstance(raw, dict):
      print(f"Skipping JSON row {i}: not an object")
      continue

    brand = str(raw.get("brand") or "").strip()
    name = str(raw.get("name") or "").strip()
    ingredients = str(raw.get("ingredients_text") or raw.get("ingredients") or "").strip()

    price_usd_raw = raw.get("price_usd", raw.get("price"))
    try:
      price_usd = float(price_usd_raw) if price_usd_raw is not None else 0.0
    except Exception:  # noqa: BLE001
      price_usd = 0.0

    price_cny_raw = raw.get("price_cny")
    try:
      price_cny = float(price_cny_raw) if price_cny_raw is not None else float(price_usd) * float(price_cny_rate)
    except Exception:  # noqa: BLE001
      price_cny = float(price_usd) * float(price_cny_rate)

    product_url = raw.get("product_url")
    image_url = raw.get("image_url")
    availability_raw = raw.get("availability")
    availability: List[str] = []
    if isinstance(availability_raw, list):
      availability = [str(x).strip() for x in availability_raw if str(x).strip()]
    elif isinstance(availability_raw, str) and availability_raw.strip():
      availability = [s.strip() for s in availability_raw.split(",") if s.strip()]
    if not availability:
      availability = ["Global"]

    if not brand or not name or not ingredients:
      print(f"Skipping JSON row {i}: missing brand/name/ingredients_text")
      continue

    skus.append(
      InputSku(
        brand=brand,
        name=name,
        ingredients_text=ingredients,
        price_usd=price_usd,
        price_cny=price_cny,
        availability=availability,
        product_url=str(product_url).strip() if product_url else None,
        image_url=str(image_url).strip() if image_url else None,
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
      availability=["Global"],
    ),
    InputSku(
      brand="The Ordinary",
      name="Buffet + Copper Peptides 1%",
      price_usd=30.0,
      price_cny=240.0,
      ingredients_text="Water, Glycerin, Copper Tripeptide-1, Lactococcus Ferment",
      availability=["Global"],
    ),
    InputSku(
      brand="Helena Rubinstein",
      name="Re-Plasty Age Recovery Night Cream (Black Bandage)",
      price_usd=460.0,
      price_cny=3900.0,
      ingredients_text="Water, Glycerin, Shea Butter, Dimethicone, Madecassoside, Fragrance",
      product_url="https://www.helenarubinstein.com/...",
      availability=["Global"],
    ),
  ]


def ingest_one(
  *,
  db: Optional[AuroraDb],
  client: GeminiClient,
  llm_model: str,
  embedding_model: str,
  social_provider: str,
  social_model: str,
  openai_api_key: Optional[str],
  openai_api_base_url: str,
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

  social_payload: Dict[str, Any] = {}
  if social_provider == "openai":
    if not openai_api_key:
      raise RuntimeError("OPENAI_API_KEY is required when --social-provider=openai")
    print(f"   ...Simulating social stats for {sku.name}")
    social_payload = get_social_simulation_openai(
      brand=sku.brand,
      name=sku.name,
      ingredients_text=(sku.ingredients_text[:2000] if sku.ingredients_text else None),
      api_key=openai_api_key,
      model=social_model,
      api_base_url=openai_api_base_url,
    )
  elif social_provider == "llm":
    ss = vectors.get("social_stats") or {}
    if isinstance(ss, dict):
      social_payload = {
        "red_score": _clamp_int(ss.get("red_score") or ss.get("redScore"), min_value=0, max_value=100),
        "reddit_score": _clamp_int(ss.get("reddit_score") or ss.get("redditScore"), min_value=0, max_value=100),
        "burn_rate": _clamp_float(ss.get("burn_rate") or ss.get("burnRate"), min_value=0.0, max_value=1.0),
        "top_keywords": _coerce_keywords(ss.get("top_keywords") or ss.get("topKeywords")),
        "_raw": ss,
      }
  elif social_provider == "none":
    social_payload = {"red_score": 0, "reddit_score": 0, "burn_rate": 0.0, "top_keywords": []}

  if dry_run:
    print(
      json.dumps(
        {"product": {"brand": sku.brand, "name": sku.name}, "vectors": vectors, "social": social_payload},
        ensure_ascii=False,
      )
    )
    return

  if db is None:
    raise RuntimeError("Internal error: db is required unless --dry-run is set.")

  existing_id = db.find_product_id(brand=sku.brand, name=sku.name)
  if existing_id and not overwrite:
    print(f"↩️  Skipped (exists): {sku.brand} - {sku.name}")
    return

  if existing_id and overwrite:
    product_id = existing_id
    # Keep product_id stable; replace dependent tables.
    db.upsert_product(sku, product_id=product_id)
    db.delete_vectors_for_product(product_id)
    db.delete_ingredients_for_product(product_id)
    db.delete_social_stats_for_product(product_id)
  else:
    product_id = str(uuid.uuid4())
  vector_id = str(uuid.uuid4())
  ingredient_id = str(uuid.uuid4())
  social_id = str(uuid.uuid4())

  try:
    if not existing_id:
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
    db.insert_social_stats(
      product_id=product_id,
      social_id=social_id,
      red_score=int(social_payload.get("red_score", 0)),
      reddit_score=int(social_payload.get("reddit_score", 0)),
      burn_rate=float(social_payload.get("burn_rate", 0.0)),
      top_keywords=list(social_payload.get("top_keywords", []) if isinstance(social_payload.get("top_keywords", []), list) else []),
    )
    db.conn.commit()
    print(f"✅ Ingested: {sku.brand} - {sku.name}")
  except BaseException:  # noqa: BLE001
    db.conn.rollback()
    raise


def main() -> None:
  parser = argparse.ArgumentParser(description="Aurora vectorization + embedding ETL (Excel → Gemini → Railway Postgres)")
  parser.add_argument("--demo", action="store_true", help="Ingest 3 demo products (Tom Ford / The Ordinary / HR).")
  parser.add_argument("--input", type=str, help="Path to Excel (.xlsx) file.")
  parser.add_argument("--input-json", type=str, help="Path to JSON file (list of SKUs) to ingest.")
  parser.add_argument("--sheet", type=str, default=None, help="Excel sheet name (default: active sheet).")
  parser.add_argument("--limit", type=int, default=None, help="Max rows to ingest (for testing).")
  parser.add_argument("--list-models", action="store_true", help="List available Gemini models and exit.")
  parser.add_argument("--ingest-kb", action="store_true", help="Also ingest non-ingredient notes into product_kb_snippets.")

  parser.add_argument("--col-brand", type=str, default="brand")
  parser.add_argument("--col-name", type=str, default="name")
  parser.add_argument("--col-ingredients", type=str, default="ingredients")
  parser.add_argument("--col-price-usd", type=str, default="price_usd")
  parser.add_argument("--col-price", type=str, default=None, help="Fallback price column if price_usd not present.")
  parser.add_argument("--price-cny-rate", type=float, default=7.2)
  parser.add_argument("--col-product-url", type=str, default=None)
  parser.add_argument("--col-image-url", type=str, default=None)

  parser.add_argument("--llm-model", type=str, default="gemini-2.5-flash")
  parser.add_argument("--embedding-model", type=str, default="gemini-embedding-001")
  parser.add_argument(
    "--social-provider",
    type=str,
    default=None,
    help="Social stats source: openai|llm|none (default: openai if OPENAI_API_KEY set, else llm).",
  )
  parser.add_argument("--social-model", type=str, default="gpt-4o", help="OpenAI model for social simulation (default: gpt-4o).")
  parser.add_argument("--no-embedding", action="store_true")
  parser.add_argument("--overwrite", action="store_true", help="Overwrite existing rows by (brand,name).")
  parser.add_argument("--dry-run", action="store_true", help="Call Gemini but do not write to DB.")

  args = parser.parse_args()

  load_dotenv()
  api_key = _require_any_env(["GEMINI_API_KEY", "GOOGLE_API_KEY"])
  api_base_url = (os.getenv("GEMINI_API_BASE_URL") or DEFAULT_GEMINI_API_BASE_URL).strip()
  openai_api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
  openai_api_base_url = (os.getenv("OPENAI_API_BASE_URL") or "https://api.openai.com/v1").strip()

  social_provider = (args.social_provider or "").strip().lower() or ("openai" if openai_api_key else "llm")
  if social_provider not in ("openai", "llm", "none"):
    raise SystemExit("--social-provider must be one of: openai|llm|none")
  if social_provider == "openai" and not openai_api_key:
    raise RuntimeError("OPENAI_API_KEY is required when --social-provider=openai (or when OPENAI_API_KEY is set default to openai).")

  gemini_client = GeminiClient(api_key=api_key, api_base_url=api_base_url)

  if args.list_models:
    models = gemini_client.list_models()
    # Keep output compact & copyable
    for m in models:
      name = m.get("name")
      methods = m.get("supportedGenerationMethods") or []
      short = GeminiClient.normalize_model_name(str(name or ""))
      print(f"{short}  full={name}  methods={methods}")
    return

  if not args.demo and not args.input and not args.input_json:
    raise SystemExit("Provide --demo, --input /path/to.xlsx, or --input-json /path/to.json (or --list-models)")

  if args.demo:
    skus = demo_skus()
  elif args.input_json:
    skus = load_input_skus_from_json(path=args.input_json, price_cny_rate=float(args.price_cny_rate), limit=args.limit)
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

  if args.dry_run:
    for sku in skus:
      ingest_one(
        db=None,
        client=gemini_client,
        llm_model=args.llm_model,
        embedding_model=args.embedding_model,
        social_provider=social_provider,
        social_model=args.social_model,
        openai_api_key=openai_api_key if social_provider == "openai" else None,
        openai_api_base_url=openai_api_base_url,
        sku=sku,
        overwrite=bool(args.overwrite),
        enable_embedding=not bool(args.no_embedding),
        dry_run=True,
      )
    return

  database_url = resolve_env_templates(_require_env("DATABASE_URL"))
  with AuroraDb(database_url) as db:
    for sku in skus:
      ingest_one(
        db=db,
        client=gemini_client,
        llm_model=args.llm_model,
        embedding_model=args.embedding_model,
        social_provider=social_provider,
        social_model=args.social_model,
        openai_api_key=openai_api_key if social_provider == "openai" else None,
        openai_api_base_url=openai_api_base_url,
        sku=sku,
        overwrite=bool(args.overwrite),
        enable_embedding=not bool(args.no_embedding),
        dry_run=bool(args.dry_run),
      )

    if args.ingest_kb and args.input:
      snippets = extract_kb_snippets_from_workbook(path=args.input)
      if snippets:
        product_ids = db.load_all_product_ids()
        product_ids_norm = db.load_all_product_ids_normalized()
        upserted = 0
        skipped = 0
        for snip in snippets:
          pid = product_ids.get((snip.brand, snip.name))
          if not pid:
            pid = product_ids_norm.get((normalize_match_key(snip.brand), normalize_match_key(snip.name)))
          if not pid:
            skipped += 1
            continue
          db.upsert_kb_snippet(
            product_id=pid,
            source_sheet=snip.source_sheet,
            field=snip.field,
            content=snip.content,
            metadata=snip.metadata,
          )
          upserted += 1
        db.conn.commit()
        print(f"📚 KB snippets upserted: {upserted} (skipped missing products: {skipped})")
      else:
        print("📚 No KB snippets found in workbook.")


if __name__ == "__main__":
  main()
