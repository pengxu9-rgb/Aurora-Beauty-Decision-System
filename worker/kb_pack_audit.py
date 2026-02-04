import argparse
import json
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Literal, Optional, Set, Tuple


KbCanonicalKey = Literal["sensitivity", "key_actives", "comparison", "usage", "texture", "notes", "unknown"]


def _as_list(value: Any) -> List[Any]:
  return value if isinstance(value, list) else []


def _as_dict(value: Any) -> Dict[str, Any]:
  return value if isinstance(value, dict) else {}


def _as_str(value: Any) -> str:
  if value is None:
    return ""
  return str(value)


def _non_empty_str(value: Any) -> str:
  s = _as_str(value).strip()
  return s


def _is_missing_number(value: Any) -> bool:
  # Treat null/0 as missing for price snapshots at this stage.
  if value is None:
    return True
  try:
    n = float(value)
  except Exception:
    return True
  return not (n > 0)


def infer_kb_canonical_key(snippet: Dict[str, Any]) -> KbCanonicalKey:
  meta = _as_dict(snippet.get("metadata"))
  meta_key = (
    meta.get("canonical_key")
    if isinstance(meta.get("canonical_key"), str)
    else meta.get("canonicalKey")
    if isinstance(meta.get("canonicalKey"), str)
    else meta.get("canonical_field")
    if isinstance(meta.get("canonical_field"), str)
    else None
  )

  label = " ".join(
    [
      _non_empty_str(meta_key),
      _non_empty_str(meta.get("field_label")),
      _non_empty_str(snippet.get("field")),
    ]
  ).lower()

  if any(k in label for k in ["sensitivity", "irrit", "risk", "敏感", "刺激", "刺痛", "过敏"]):
    return "sensitivity"
  if (
    "key_actives" in label
    or ("key" in label and ("active" in label or "actives" in label))
    or any(k in label for k in ["主要成分", "核心成分", "关键活性", "功效成分"])
  ):
    return "key_actives"
  if any(k in label for k in ["comparison", "compare", "dupe", "替代", "平替", "对比", "竞品"]):
    return "comparison"
  if any(
    k in label
    for k in [
      "usage",
      "routine",
      "layer",
      "frequency",
      "warning",
      "caution",
      "用法",
      "搭配",
      "叠加",
      "频率",
      "注意事项",
      "警示",
      "警告",
    ]
  ):
    return "usage"
  if any(k in label for k in ["texture", "finish", "pilling", "质地", "清爽", "厚重", "搓泥", "成膜", "油腻"]):
    return "texture"
  if any(k in label for k in ["notes", "note", "备注", "评价"]):
    return "notes"
  if not label.strip():
    return "unknown"
  return "notes"


def kb_snippet_coverage(snippets: List[Dict[str, Any]]) -> Counter[KbCanonicalKey]:
  out: Counter[KbCanonicalKey] = Counter()
  for raw in snippets:
    if not isinstance(raw, dict):
      continue
    content = _non_empty_str(raw.get("content"))
    if not content:
      continue
    key = infer_kb_canonical_key(raw)
    out[key] += 1
  return out


def _uniq(items: Iterable[str]) -> List[str]:
  out: List[str] = []
  seen: Set[str] = set()
  for raw in items:
    v = _non_empty_str(raw)
    if not v:
      continue
    key = v.lower()
    if key in seen:
      continue
    seen.add(key)
    out.append(v)
  return out


REQUIRED_SNIPPET_KEYS: Tuple[KbCanonicalKey, ...] = ("key_actives", "sensitivity", "usage", "comparison")


@dataclass
class AuditedItem:
  list_name: Literal["ingest_ready", "needs_research"]
  brand: str
  name: str
  display_name: Optional[str]
  category: Optional[str]
  existing_missing_fields: List[str]
  computed_missing_fields: List[str]
  kb_snippet_coverage: Dict[KbCanonicalKey, int]
  kb_snippet_missing: List[KbCanonicalKey]
  expert_knowledge_present: bool
  expert_knowledge_missing: List[str]
  score: int
  reason: Optional[str]


def audit_item(raw: Dict[str, Any], *, list_name: Literal["ingest_ready", "needs_research"]) -> AuditedItem:
  brand = _non_empty_str(raw.get("brand"))
  name = _non_empty_str(raw.get("name"))
  display_name = _non_empty_str(raw.get("display_name")) or None
  category = _non_empty_str(raw.get("category")) or None
  reason = _non_empty_str(raw.get("reason")) or None

  existing_missing_fields = [x for x in _as_list(raw.get("missing_fields")) if isinstance(x, str)]
  computed_missing: List[str] = []

  if not brand:
    computed_missing.append("brand")
  if not name:
    computed_missing.append("name")

  ingredients_text = _non_empty_str(raw.get("ingredients_text") or raw.get("ingredients"))
  if list_name == "ingest_ready" and not ingredients_text:
    computed_missing.append("ingredients_text")

  if list_name == "ingest_ready":
    product_url = _non_empty_str(raw.get("product_url") or raw.get("url"))
    if not product_url:
      computed_missing.append("product_url")

    if _is_missing_number(raw.get("price_usd") or raw.get("price")):
      computed_missing.append("price_usd")
    if _is_missing_number(raw.get("price_cny")):
      computed_missing.append("price_cny")

  expert = raw.get("expert_knowledge")
  expert_present = isinstance(expert, dict) and bool(expert)
  expert_missing: List[str] = []
  if list_name == "ingest_ready":
    if not expert_present:
      computed_missing.append("expert_knowledge")
    else:
      for k in ["key_actives", "sensitivity_flags", "chemist_notes"]:
        if not _non_empty_str((expert or {}).get(k)):
          expert_missing.append(k)

  snippets = raw.get("kb_snippets") if isinstance(raw.get("kb_snippets"), list) else []
  coverage_counter = kb_snippet_coverage(snippets if isinstance(snippets, list) else [])
  coverage = {k: int(coverage_counter.get(k, 0)) for k in ["key_actives", "sensitivity", "usage", "comparison", "texture", "notes", "unknown"]}  # type: ignore[list-item]

  snippet_missing: List[KbCanonicalKey] = []
  if list_name == "ingest_ready":
    for key in REQUIRED_SNIPPET_KEYS:
      if coverage_counter.get(key, 0) <= 0:
        snippet_missing.append(key)
        computed_missing.append(f"kb_snippets.{key}")

  computed_missing = _uniq([*existing_missing_fields, *computed_missing])

  # Scoring: prioritize "high leverage" completeness for downstream UX.
  score = 0
  if ingredients_text:
    score += 20
  if list_name == "ingest_ready":
    if _non_empty_str(raw.get("product_url") or raw.get("url")):
      score += 10
    if not _is_missing_number(raw.get("price_usd") or raw.get("price")) or not _is_missing_number(raw.get("price_cny")):
      score += 10
    if expert_present:
      score += 10
      if _non_empty_str((expert or {}).get("key_actives")):
        score += 5
      if _non_empty_str((expert or {}).get("sensitivity_flags")):
        score += 5
    for key, pts in [("key_actives", 6), ("sensitivity", 6), ("usage", 4), ("comparison", 4), ("texture", 2), ("notes", 2)]:
      if coverage_counter.get(key, 0) > 0:
        score += pts
  score = max(0, min(100, score))

  return AuditedItem(
    list_name=list_name,
    brand=brand,
    name=name,
    display_name=display_name,
    category=category,
    existing_missing_fields=_uniq(existing_missing_fields),
    computed_missing_fields=computed_missing,
    kb_snippet_coverage=coverage,  # type: ignore[arg-type]
    kb_snippet_missing=snippet_missing,
    expert_knowledge_present=expert_present,
    expert_knowledge_missing=expert_missing,
    score=score,
    reason=reason,
  )


def load_pack(path: Path) -> Dict[str, Any]:
  data = json.loads(path.read_text(encoding="utf-8"))
  if not isinstance(data, dict):
    raise SystemExit("Input must be a JSON object (pack).")
  return data


def iter_pack_items(pack: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
  ready = _as_dict(pack.get("ingest_ready"))
  research = _as_dict(pack.get("needs_research"))
  ready_items = [i for i in _as_list(ready.get("items")) if isinstance(i, dict)]
  research_items = [i for i in _as_list(research.get("items")) if isinstance(i, dict)]
  return ready_items, research_items


def render_markdown(items: List[AuditedItem], *, source_path: str) -> str:
  now = datetime.now(timezone.utc).isoformat(timespec="seconds")
  ready = [i for i in items if i.list_name == "ingest_ready"]
  research = [i for i in items if i.list_name == "needs_research"]

  missing_counts = Counter()
  for i in items:
    missing_counts.update(i.computed_missing_fields)

  def fmt_item(i: AuditedItem) -> str:
    title = i.display_name or f"{i.brand} {i.name}".strip() or "Unknown"
    missing = ", ".join(i.computed_missing_fields) if i.computed_missing_fields else "—"
    snippet_missing = ", ".join(i.kb_snippet_missing) if i.kb_snippet_missing else "—"
    expert_missing = ", ".join(i.expert_knowledge_missing) if i.expert_knowledge_missing else "—"
    return (
      f"- **{title}** (score={i.score})\n"
      f"  - missing_fields: {missing}\n"
      + (f"  - reason: {i.reason}\n" if i.reason else "")
      + (f"  - kb_snippet_missing: {snippet_missing}\n" if i.list_name == "ingest_ready" else "")
      + (f"  - expert_knowledge_missing: {expert_missing}\n" if i.list_name == "ingest_ready" and i.expert_knowledge_present else "")
    ).rstrip()

  top_missing_lines = "\n".join(
    [f"- `{k}`: {v}" for k, v in missing_counts.most_common(30)]
  )

  ready_lines = "\n".join([fmt_item(i) for i in sorted(ready, key=lambda x: (-x.score, x.brand.lower(), x.name.lower()))])

  # Research: show easiest wins first (missing everything -> later).
  def research_sort_key(i: AuditedItem):
    mf = set(i.computed_missing_fields)
    heavy = 1 if "ingredients_text" in mf else 0
    return (heavy, len(mf), -i.score, i.brand.lower(), i.name.lower())

  research_lines = "\n".join([fmt_item(i) for i in sorted(research, key=research_sort_key)])

  return (
    f"# KB Pack Audit\n\n"
    f"- source: `{source_path}`\n"
    f"- generated_at_utc: `{now}`\n"
    f"- ingest_ready_items: **{len(ready)}**\n"
    f"- needs_research_items: **{len(research)}**\n\n"
    f"## Top missing fields\n"
    f"{top_missing_lines if top_missing_lines else '- (none)'}\n\n"
    f"## ingest_ready\n"
    f"{ready_lines if ready_lines else '- (none)'}\n\n"
    f"## needs_research\n"
    f"{research_lines if research_lines else '- (none)'}\n"
  )


def main() -> None:
  parser = argparse.ArgumentParser(description="Audit aurora_kb_upsert_pack.json for downstream UX completeness.")
  parser.add_argument("--in", dest="in_path", required=True, help="Path to aurora_kb_upsert_pack.json")
  parser.add_argument("--out-json", required=False, help="Output JSON path for audit report")
  parser.add_argument("--out-md", required=False, help="Output Markdown path for human-readable audit report")
  args = parser.parse_args()

  in_path = Path(args.in_path).expanduser().resolve()
  pack = load_pack(in_path)
  ready_items, research_items = iter_pack_items(pack)

  audited: List[AuditedItem] = []
  audited.extend([audit_item(i, list_name="ingest_ready") for i in ready_items])
  audited.extend([audit_item(i, list_name="needs_research") for i in research_items])

  if args.out_json:
    out = Path(args.out_json).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
      "source": str(in_path),
      "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
      "counts": {
        "ingest_ready": len(ready_items),
        "needs_research": len(research_items),
      },
      "items": [
        {
          "list": i.list_name,
          "brand": i.brand,
          "name": i.name,
          "display_name": i.display_name,
          "category": i.category,
          "score": i.score,
          "missing_fields": i.computed_missing_fields,
          "kb_snippet_coverage": i.kb_snippet_coverage,
          "kb_snippet_missing": i.kb_snippet_missing,
          "expert_knowledge_present": i.expert_knowledge_present,
          "expert_knowledge_missing": i.expert_knowledge_missing,
          "reason": i.reason,
        }
        for i in audited
      ],
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Wrote audit JSON: {out}")

  if args.out_md:
    out = Path(args.out_md).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(audited, source_path=str(in_path)), encoding="utf-8")
    print(f"📝 Wrote audit Markdown: {out}")

  # Always print a quick summary.
  missing_counts = Counter()
  for it in audited:
    missing_counts.update(it.computed_missing_fields)
  print(f"items: ingest_ready={len(ready_items)} needs_research={len(research_items)}")
  for k, v in missing_counts.most_common(10):
    print(f"missing: {k}  count={v}")


if __name__ == "__main__":
  main()
