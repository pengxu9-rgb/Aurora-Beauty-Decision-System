import argparse
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


def _as_list(value: Any) -> List[Any]:
  return value if isinstance(value, list) else []


def _as_dict(value: Any) -> Dict[str, Any]:
  return value if isinstance(value, dict) else {}


def _s(value: Any) -> str:
  return str(value or "").strip()


def _strip_accents(text: str) -> str:
  value = unicodedata.normalize("NFKD", text)
  return "".join(ch for ch in value if not unicodedata.combining(ch))


def _tokenize(text: str) -> List[str]:
  t = _strip_accents(_s(text)).lower()
  t = t.replace("+", " ")
  parts = re.split(r"[^a-z0-9]+", t)
  return [p for p in parts if p and len(p) >= 2]


BRAND_CANONICAL_MAP = {
  "lrp": "larocheposay",
  "larocheposay": "larocheposay",
  "larocheposaylaboratoiredermatologique": "larocheposay",
  "larocheposayfrance": "larocheposay",
  "la-roche-posay": "larocheposay",
  "la roche posay": "larocheposay",
}


def canonical_brand_key(brand: str) -> str:
  tokens = _tokenize(brand)
  raw = "".join(tokens)
  return BRAND_CANONICAL_MAP.get(raw, raw)


NAME_STOPWORDS = {
  "new",
  "version",
  "us",
  "eu",
  "global",
  "in",
  "the",
  "tub",
  "triple",
  "repair",
  "body",
  "lotion",
  "cream",
  "serum",
  "gel",
  "cleanser",
}


def canonical_name_key(name: str) -> str:
  # Remove parenthetical qualifiers
  n = re.sub(r"\([^)]*\)", " ", _s(name))
  tokens = [t for t in _tokenize(n) if t not in NAME_STOPWORDS]
  return " ".join(tokens).strip()


def generate_name_candidates(name: str) -> List[str]:
  raw = _s(name)
  if not raw:
    return []
  out = [raw]
  no_parens = re.sub(r"\([^)]*\)", " ", raw).strip()
  if no_parens and no_parens != raw:
    out.append(no_parens)

  # Common variant normalizations
  if "B5+" in raw or "b5+" in raw.lower():
    out.append(re.sub(r"b5\\+", "B5", raw, flags=re.IGNORECASE).strip())
  if "AP+M" in raw or "ap+m" in raw.lower():
    out.append(re.sub(r"ap\\+m", "AP+M", raw, flags=re.IGNORECASE).strip())
    out.append("Lipikar Baume AP+M")
  if "triple repair" in raw.lower():
    out.append(re.sub(r"triple\\s+repair", "", raw, flags=re.IGNORECASE).strip())
    out.append("Lipikar Baume AP+M")
  if "mineral 89" in raw.lower() or "minéral 89" in raw.lower():
    out.append("Minéral 89")

  # De-dupe
  seen = set()
  uniq: List[str] = []
  for v in out:
    k = canonical_name_key(v) or v.lower()
    if k in seen:
      continue
    seen.add(k)
    uniq.append(v)
  return uniq[:8]


def jaccard(a: Iterable[str], b: Iterable[str]) -> float:
  sa = set(a)
  sb = set(b)
  if not sa and not sb:
    return 1.0
  if not sa or not sb:
    return 0.0
  inter = sa & sb
  union = sa | sb
  return len(inter) / max(1, len(union))


@dataclass
class SourceItem:
  brand: str
  name: str
  brand_key: str
  name_key: str
  ingredients_text: str
  price_usd: Optional[float]
  availability: List[str]
  category: Optional[str]
  expert_knowledge: Optional[Dict[str, Any]]
  source_file: str


def load_source_items(path: Path) -> List[SourceItem]:
  raw = json.loads(path.read_text(encoding="utf-8"))
  items = raw.get("items") if isinstance(raw, dict) else raw
  if not isinstance(items, list):
    return []

  out: List[SourceItem] = []
  for it in items:
    if not isinstance(it, dict):
      continue
    brand = _s(it.get("brand"))
    name = _s(it.get("name"))
    if not brand or not name:
      continue
    ingredients = _s(it.get("ingredients_text") or it.get("ingredients"))
    if not ingredients:
      continue
    price_raw = it.get("price_usd") if it.get("price_usd") is not None else it.get("price")
    price_usd: Optional[float] = None
    try:
      if price_raw is not None:
        n = float(price_raw)
        if n > 0:
          price_usd = n
    except Exception:
      price_usd = None

    availability = [str(v).strip() for v in _as_list(it.get("availability")) if str(v).strip()]
    category = _s(it.get("category")) or None
    expert = it.get("expert_knowledge") if isinstance(it.get("expert_knowledge"), dict) else None

    out.append(
      SourceItem(
        brand=brand,
        name=name,
        brand_key=canonical_brand_key(brand),
        name_key=canonical_name_key(name),
        ingredients_text=ingredients,
        price_usd=price_usd,
        availability=availability,
        category=category,
        expert_knowledge=expert,
        source_file=path.name,
      )
    )
  return out


def best_match(
  sources: List[SourceItem],
  *,
  brand: str,
  name: str,
) -> Tuple[Optional[SourceItem], str, float]:
  bkey = canonical_brand_key(brand)
  candidates = [s for s in sources if s.brand_key == bkey]
  if not candidates:
    return None, "no_brand_match", 0.0

  # Exact candidate keys first (with name variants)
  for cand_name in generate_name_candidates(name):
    nkey = canonical_name_key(cand_name)
    if not nkey:
      continue
    for s in candidates:
      if s.name_key and s.name_key == nkey:
        return s, "exact", 1.0

  # Fuzzy token overlap
  want_tokens = _tokenize(re.sub(r"\([^)]*\)", " ", name))
  best: Optional[Tuple[float, SourceItem]] = None
  for s in candidates:
    got_tokens = _tokenize(re.sub(r"\([^)]*\)", " ", s.name))
    score = jaccard(want_tokens, got_tokens)

    # Bonus if one string contains the other (after accent stripping)
    want_s = _strip_accents(_s(name)).lower()
    got_s = _strip_accents(_s(s.name)).lower()
    if want_s and got_s and (want_s in got_s or got_s in want_s):
      score = min(1.0, score + 0.15)

    if best is None or score > best[0]:
      best = (score, s)

  if not best:
    return None, "no_name_match", 0.0

  score, s = best
  if score < 0.55:
    return None, "low_confidence", float(score)
  return s, "fuzzy", float(score)


def remove_missing_fields(item: Dict[str, Any], filled: List[str]) -> None:
  mf = item.get("missing_fields")
  if not isinstance(mf, list):
    return
  keep: List[Any] = []
  filled_set = set(filled)
  for x in mf:
    sx = str(x)
    if sx in filled_set:
      continue
    keep.append(x)
  item["missing_fields"] = keep


def main() -> None:
  parser = argparse.ArgumentParser(description="Best-effort autofill aurora_kb_upsert_pack.json from local datasets (no web).")
  parser.add_argument("--in", dest="in_path", required=True, help="Path to aurora_kb_upsert_pack.json")
  parser.add_argument("--out", dest="out_path", required=True, help="Output path for patched pack JSON")
  parser.add_argument("--source", action="append", default=[], help="Extra JSON source paths (can repeat).")
  parser.add_argument("--report-md", required=False, help="Optional markdown report path")
  args = parser.parse_args()

  in_path = Path(args.in_path).expanduser().resolve()
  out_path = Path(args.out_path).expanduser().resolve()

  pack = json.loads(in_path.read_text(encoding="utf-8"))
  if not isinstance(pack, dict):
    raise SystemExit("Input pack must be a JSON object.")

  sources: List[SourceItem] = []

  # Default sources if present.
  default_sources = [
    (Path(__file__).resolve().parent.parent / "worker" / "datasets" / "top10.json"),
    (Path(__file__).resolve().parent.parent / "batch_expert_v1.json"),
    (Path(__file__).resolve().parent.parent.parent / "batch_expert_v1.json"),
  ]
  for p in default_sources:
    if p.exists():
      sources.extend(load_source_items(p))

  for raw in args.source:
    p = Path(raw).expanduser().resolve()
    if p.exists():
      sources.extend(load_source_items(p))

  ingest_ready = _as_dict(pack.get("ingest_ready"))
  needs_research = _as_dict(pack.get("needs_research"))
  ready_items = [i for i in _as_list(ingest_ready.get("items")) if isinstance(i, dict)]
  research_items = [i for i in _as_list(needs_research.get("items")) if isinstance(i, dict)]

  report_lines: List[str] = []
  now = datetime.now(timezone.utc).isoformat(timespec="seconds")
  report_lines.append("# KB Pack Autofill (Local)\n")
  report_lines.append(f"- source: `{in_path}`")
  report_lines.append(f"- out: `{out_path}`")
  report_lines.append(f"- generated_at_utc: `{now}`")
  report_lines.append(f"- sources_loaded: **{len(sources)}**\n")

  def patch_item(item: Dict[str, Any]) -> None:
    brand = _s(item.get("brand"))
    name = _s(item.get("name"))
    if not brand or not name:
      return

    missing_ing = not _s(item.get("ingredients_text") or item.get("ingredients"))
    missing_price = item.get("price_usd") in (None, 0, "") and item.get("price") in (None, 0, "")

    if not missing_ing and not missing_price and item.get("expert_knowledge") is not None:
      return

    match, method, score = best_match(sources, brand=brand, name=name)
    if not match:
      return

    filled: List[str] = []
    if missing_ing and match.ingredients_text:
      item["ingredients_text"] = match.ingredients_text
      filled.append("ingredients_text")
    if missing_price and match.price_usd:
      item["price_usd"] = match.price_usd
      filled.append("price_usd")
    if (not item.get("availability")) and match.availability:
      item["availability"] = match.availability
    if (not item.get("category")) and match.category:
      item["category"] = match.category
    if (not item.get("expert_knowledge")) and match.expert_knowledge:
      item["expert_knowledge"] = match.expert_knowledge
      filled.append("expert_knowledge")

    if filled:
      remove_missing_fields(item, filled)
      item.setdefault("autofill", {})
      if isinstance(item["autofill"], dict):
        item["autofill"] = {
          **item["autofill"],
          "source": match.source_file,
          "matched_brand": match.brand,
          "matched_name": match.name,
          "method": method,
          "score": round(score, 3),
          "filled_fields": filled,
        }
      report_lines.append(f"- ✅ **{brand} {name}** ← {match.source_file} ({method}, score={score:.2f}) filled: {', '.join(filled)}")

  for it in ready_items:
    patch_item(it)
  for it in research_items:
    patch_item(it)

  ingest_ready["items"] = ready_items
  needs_research["items"] = research_items
  pack["ingest_ready"] = ingest_ready
  pack["needs_research"] = needs_research

  out_path.parent.mkdir(parents=True, exist_ok=True)
  out_path.write_text(json.dumps(pack, ensure_ascii=False, indent=2), encoding="utf-8")

  if args.report_md:
    md_path = Path(args.report_md).expanduser().resolve()
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text("\n".join(report_lines).strip() + "\n", encoding="utf-8")


if __name__ == "__main__":
  main()

