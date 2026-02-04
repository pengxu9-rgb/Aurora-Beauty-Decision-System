export function buildActiveMatchTokens(activeMentions: string[]): string[] {
  const map: Record<string, string[]> = {
    // Common actives (EN + CN). Keep small + conservative.
    Niacinamide: ["niacinamide", "nicotinamide", "烟酰胺", "维生素b3", "维生素B3"],
    "Tranexamic Acid": ["tranexamic", "txa", "传明酸"],
    "Vitamin C": ["ascorbic", "vitamin c", "维c", "维生素c"],
    "Azelaic Acid": ["azelaic", "壬二酸"],
    Arbutin: ["arbutin", "熊果苷"],
    "Kojic Acid": ["kojic", "曲酸"],
    Retinoid: ["retinol", "retinal", "adapalene", "维a", "A醇", "A醛", "阿达帕林"],
    "BHA (Salicylic Acid)": ["salicylic", "bha", "水杨酸"],
    AHA: ["glycolic", "lactic", "aha", "果酸", "乙醇酸", "乳酸"],
    PHA: ["gluconolactone", "pha", "葡糖酸内酯"],
    Peptides: ["peptide", "多肽", "蓝铜"],
  };

  const tokens = new Set<string>();
  for (const raw of activeMentions) {
    const key = String(raw ?? "").trim();
    if (!key) continue;
    const mapped = map[key];
    if (mapped) {
      for (const t of mapped) {
        const v = String(t ?? "").trim();
        if (v) tokens.add(v);
      }
      continue;
    }
    tokens.add(key);
  }

  return Array.from(tokens)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}

export function matchesAnyToken(haystack: string, tokens: string[]): boolean {
  const h = String(haystack ?? "").toLowerCase();
  if (!h.trim() || !Array.isArray(tokens) || tokens.length === 0) return false;
  return tokens.some((t) => t && h.includes(String(t).toLowerCase()));
}

