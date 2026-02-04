import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _as_list(value: Any) -> List[Any]:
  return value if isinstance(value, list) else []


def _as_dict(value: Any) -> Dict[str, Any]:
  return value if isinstance(value, dict) else {}

def _non_empty_str(value: Any) -> str:
  return str(value or "").strip()


def _normalize_item(raw: Dict[str, Any]) -> Dict[str, Any]:
  # Keep keys aligned with worker/ingest.py::load_input_skus_from_json
  out: Dict[str, Any] = {
    "brand": raw.get("brand"),
    "name": raw.get("name"),
    "ingredients_text": raw.get("ingredients_text") or raw.get("ingredients") or "",
    "price_usd": raw.get("price_usd") or raw.get("price") or 0,
    "price_cny": raw.get("price_cny") or 0,
    "availability": raw.get("availability") or ["Global"],
    "product_url": raw.get("product_url") or raw.get("url") or None,
    "image_url": raw.get("image_url") or None,
    "expert_knowledge": raw.get("expert_knowledge") if isinstance(raw.get("expert_knowledge"), dict) else None,
    "kb_snippets": raw.get("kb_snippets") if isinstance(raw.get("kb_snippets"), list) else None,
  }

  # Optional helper fields for triage.
  if raw.get("reason"):
    out["reason"] = raw.get("reason")
  if raw.get("missing_fields"):
    out["missing_fields"] = raw.get("missing_fields")

  return out


def split_pack(pack: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
  ingest_ready = _as_dict(pack.get("ingest_ready"))
  needs_research = _as_dict(pack.get("needs_research"))

  ready_items_raw = [_normalize_item(i) for i in _as_list(ingest_ready.get("items")) if isinstance(i, dict)]
  research_items_raw = [_normalize_item(i) for i in _as_list(needs_research.get("items")) if isinstance(i, dict)]

  # Merge duplicates across sections by (brand,name). Prefer ingest_ready, then fill missing values from needs_research.
  merged: Dict[Tuple[str, str], Dict[str, Any]] = {}
  order: List[Tuple[str, str]] = []

  def key_for(i: Dict[str, Any]) -> Tuple[str, str]:
    return (_non_empty_str(i.get("brand")).lower(), _non_empty_str(i.get("name")).lower())

  def merge_into(base: Dict[str, Any], other: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for k, v in other.items():
      if k not in out or out.get(k) in (None, "", 0, [], {}):
        out[k] = v
      elif k in ("missing_fields",) and isinstance(out.get(k), list) and isinstance(v, list):
        # merge unique
        seen = set(str(x) for x in out[k])
        for x in v:
          sx = str(x)
          if sx not in seen:
            seen.add(sx)
            out[k].append(x)
    return out

  for item in ready_items_raw + research_items_raw:
    b = _non_empty_str(item.get("brand"))
    n = _non_empty_str(item.get("name"))
    if not b or not n:
      continue
    k = key_for(item)
    if k not in merged:
      merged[k] = item
      order.append(k)
    else:
      merged[k] = merge_into(merged[k], item)

  all_items = [merged[k] for k in order]

  # Ready list: any item (from either section) with ingredients_text.
  ready_items = [
    i
    for i in all_items
    if _non_empty_str(i.get("brand")) and _non_empty_str(i.get("name")) and _non_empty_str(i.get("ingredients_text"))
  ]

  # Research list: items still missing ingredients_text; ensure required fields exist (blank placeholders are fine).
  normalized_research: List[Dict[str, Any]] = []
  for i in all_items:
    if not _non_empty_str(i.get("brand")) or not _non_empty_str(i.get("name")):
      continue
    if _non_empty_str(i.get("ingredients_text")):
      continue
    i.setdefault("ingredients_text", "")
    i.setdefault("price_usd", 0)
    i.setdefault("price_cny", 0)
    i.setdefault("availability", ["Global"])
    normalized_research.append(i)

  return ready_items, normalized_research


def main() -> None:
  parser = argparse.ArgumentParser(description="Convert aurora_kb_upsert_pack.json into worker/ingest.py JSON inputs")
  parser.add_argument("--in", dest="in_path", required=True, help="Path to aurora_kb_upsert_pack.json")
  parser.add_argument("--out-ready", required=True, help="Output JSON path for ingest-ready items")
  parser.add_argument("--out-research", required=False, help="Optional output JSON path for needs-research template")
  args = parser.parse_args()

  pack_path = Path(args.in_path).expanduser().resolve()
  data = json.loads(pack_path.read_text(encoding="utf-8"))
  if not isinstance(data, dict):
    raise SystemExit("Input must be a JSON object (pack).")

  ready, research = split_pack(data)

  out_ready = Path(args.out_ready).expanduser().resolve()
  out_ready.parent.mkdir(parents=True, exist_ok=True)
  out_ready.write_text(json.dumps({"items": ready}, ensure_ascii=False, indent=2), encoding="utf-8")
  print(f"✅ Wrote ingest-ready JSON: {out_ready}  items={len(ready)}")

  if args.out_research:
    out_research = Path(args.out_research).expanduser().resolve()
    out_research.parent.mkdir(parents=True, exist_ok=True)
    out_research.write_text(json.dumps({"items": research}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"🧩 Wrote needs-research template JSON: {out_research}  items={len(research)}")


if __name__ == "__main__":
  main()
