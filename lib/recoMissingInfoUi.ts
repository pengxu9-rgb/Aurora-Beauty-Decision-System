const INTERNAL_MISSING_INFO_PATTERN =
  /^(reco_dag_|url_|upstream_|internal_|router\.|skin_fit\.profile\.|competitor_recall_)/i;

const MISSING_INFO_LABELS: Record<string, string> = {
  social_data_limited: "Cross-platform social coverage is limited right now.",
  price_temporarily_unavailable: "Price could not be confirmed from reliable sources yet.",
  profile_not_provided: "Some skin profile inputs are missing; share them for tighter matching.",
  analysis_in_progress: "Analysis refresh is in progress.",
  ingredient_concentration_unknown: "Ingredient concentration is not disclosed by the product page.",
  alternatives_limited: "Alternatives are available but still limited in coverage.",
  alternatives_unavailable: "Alternatives are temporarily unavailable.",
  product_not_resolved: "Product identity could not be fully resolved.",
  evidence_limited: "Evidence is currently limited.",
  analysis_limited: "Analysis evidence is currently limited.",
};

export function normalizeMissingInfoForUi(raw: unknown): string[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    const token = String(item || "").trim().toLowerCase();
    if (!token) continue;
    if (INTERNAL_MISSING_INFO_PATTERN.test(token)) continue;
    const label = MISSING_INFO_LABELS[token] || "";
    if (!label) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= 6) break;
  }
  return out;
}

