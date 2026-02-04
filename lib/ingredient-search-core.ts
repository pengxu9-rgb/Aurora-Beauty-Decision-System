import type { RegionPreference } from "@/lib/vector-service";

export type IngredientSearchInputV1 = {
  schema_version: "aurora.ingredient_search.v1";
  query: string;
  region?: RegionPreference;
  limit?: number; // <= 50
  filters?: {
    product_ids?: string[];
    include_kb_snippets?: boolean;
  };
  ranking?: Record<string, unknown>; // TODO(report)
};

export type IngredientSearchHitV1 = {
  product_id: string;
  display_name?: string;
  matched_terms: string[];
  match_source: Array<"ingredients" | "hero_actives" | "kb_snippets">;
  score: number; // 0..1
};

export type IngredientSearchOutputV1 = {
  schema_version: "aurora.ingredient_search.v1";
  query: string;
  hits: IngredientSearchHitV1[];
  missing_inputs: string[];
};

export type IngredientSearchDocV1 = {
  product_id: string;
  display_name?: string;
  region_availability?: string[] | null;
  ingredients_full_list?: string[] | null;
  hero_actives?: unknown;
  kb_snippets?: string[] | null;
};

const MAX_LIMIT = 50;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeAvailability(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function isProductAvailableInRegion(availability: string[], region: RegionPreference): boolean {
  if (!region) return true;
  if (!availability.length) return true; // unknown/empty => treat as not restricted (consistent with vector-service)
  const upper = availability.map((r) => r.toUpperCase());
  return upper.includes(region) || upper.includes("GLOBAL");
}

function normalizeQuery(raw: string): { normalized: string; tokens: string[] } {
  const normalized = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

  const tokens = normalized
    .split(/[^a-z0-9%+]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 12);

  // De-dup while preserving order.
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
  }

  return { normalized, tokens: uniq };
}

function normalizeSynonyms(tokens: string[]): string[] {
  const out = new Set(tokens);
  // Minimal synonyms (safe, small). TODO(report): expand via a governed vocab.
  if (out.has("parfum")) out.add("fragrance");
  if (out.has("fragrance")) out.add("parfum");
  if (out.has("vitc")) out.add("vitamin");
  if (out.has("vitamin")) out.add("vitamin c");
  return Array.from(out);
}

function extractHeroActiveNames(heroActives: unknown): string[] {
  if (!heroActives) return [];
  if (Array.isArray(heroActives)) {
    const names: string[] = [];
    for (const item of heroActives) {
      if (typeof item === "string") {
        const v = item.trim();
        if (v) names.push(v);
        continue;
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const candidates = [obj.name, obj.active, obj.key, obj.title].map((v) => (typeof v === "string" ? v.trim() : ""));
        const picked = candidates.find((v) => v) ?? "";
        if (picked) names.push(picked);
      }
    }
    return names;
  }
  if (typeof heroActives === "object") {
    // Some sources may store { actives: [...] } or similar.
    const obj = heroActives as Record<string, unknown>;
    if (Array.isArray(obj.actives)) return extractHeroActiveNames(obj.actives);
    if (Array.isArray(obj.hero_actives)) return extractHeroActiveNames(obj.hero_actives);
  }
  return [];
}

function matchTermsInList(list: string[], query: { normalized: string; tokens: string[] }): string[] {
  const hits: string[] = [];
  const normalizedQuery = query.normalized;
  const tokens = normalizeSynonyms(query.tokens);

  for (const rawTerm of list) {
    const term = String(rawTerm ?? "").trim();
    if (!term) continue;
    const t = term.toLowerCase();

    const phraseHit = normalizedQuery.length >= 2 && t.includes(normalizedQuery);
    const tokenHit = tokens.some((tok) => tok.length >= 3 && t.includes(tok));

    if (phraseHit || tokenHit) hits.push(term);
    if (hits.length >= 12) break;
  }

  // Dedup case-insensitively.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function matchInTextBlobs(blobs: string[], query: { normalized: string; tokens: string[] }): boolean {
  const normalizedQuery = query.normalized;
  const tokens = normalizeSynonyms(query.tokens);
  for (const raw of blobs) {
    const t = String(raw ?? "").toLowerCase();
    if (!t) continue;
    if (normalizedQuery && t.includes(normalizedQuery)) return true;
    if (tokens.some((tok) => tok.length >= 3 && t.includes(tok))) return true;
  }
  return false;
}

export function searchIngredientDocsV1(docs: IngredientSearchDocV1[], input: IngredientSearchInputV1): IngredientSearchOutputV1 {
  const { normalized, tokens } = normalizeQuery(input.query);
  const region = input.region ?? null;
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(MAX_LIMIT, input.limit) : 10;
  const includeKbSnippets = Boolean(input.filters?.include_kb_snippets);

  if (!normalized) {
    return { schema_version: "aurora.ingredient_search.v1", query: "", hits: [], missing_inputs: [] };
  }

  const query = { normalized, tokens };

  const hits: IngredientSearchHitV1[] = [];

  for (const doc of docs) {
    const availability = normalizeAvailability(doc.region_availability ?? []);
    if (!isProductAvailableInRegion(availability, region)) continue;

    const ingredients = Array.isArray(doc.ingredients_full_list) ? doc.ingredients_full_list : [];
    const ingredientMatches = matchTermsInList(ingredients, query);

    const hero = extractHeroActiveNames(doc.hero_actives);
    const heroMatches = matchTermsInList(hero, query);

    const kbMatched =
      includeKbSnippets && Array.isArray(doc.kb_snippets) ? matchInTextBlobs(doc.kb_snippets, query) : false;

    const match_source: IngredientSearchHitV1["match_source"] = [];
    const matched_terms: string[] = [];

    if (ingredientMatches.length) {
      match_source.push("ingredients");
      matched_terms.push(...ingredientMatches);
    }
    if (heroMatches.length) {
      match_source.push("hero_actives");
      matched_terms.push(...heroMatches);
    }
    if (kbMatched) {
      match_source.push("kb_snippets");
      matched_terms.push(normalized);
    }

    if (!match_source.length) continue;

    let score = 0;
    if (ingredientMatches.length) score = Math.max(score, 0.9);
    if (heroMatches.length) score = Math.max(score, 0.85);
    if (kbMatched) score = Math.max(score, 0.7);

    // Small bonuses for multi-source + multiple matched terms.
    score += Math.max(0, match_source.length - 1) * 0.05;
    score += Math.min(0.05, Math.max(0, matched_terms.length - 1) * 0.01);
    score = clamp01(score);

    // Dedup matched_terms case-insensitively.
    const seen = new Set<string>();
    const uniqTerms: string[] = [];
    for (const term of matched_terms) {
      const t = String(term ?? "").trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniqTerms.push(t);
      if (uniqTerms.length >= 12) break;
    }

    hits.push({
      product_id: doc.product_id,
      display_name: doc.display_name,
      matched_terms: uniqTerms,
      match_source,
      score,
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.match_source.length !== a.match_source.length) return b.match_source.length - a.match_source.length;
    return String(a.display_name ?? a.product_id).localeCompare(String(b.display_name ?? b.product_id));
  });

  return {
    schema_version: "aurora.ingredient_search.v1",
    query: input.query,
    hits: hits.slice(0, limit),
    missing_inputs: [],
  };
}

