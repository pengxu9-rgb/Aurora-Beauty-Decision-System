import "server-only";

import { inferKbCanonicalKeyFromSnippet, type KbCanonicalKey } from "@/lib/kb-canonical";
import type { RegionPreference } from "@/lib/vector-service";

export type KbSnippet = {
  id?: string;
  source_sheet: string;
  field: string;
  content: string;
  metadata?: unknown;
};

export type { KbCanonicalKey } from "@/lib/kb-canonical";

export type KbProfile = {
  product_id: string;
  display_name: string;
  region: RegionPreference | "Global";
  availability: string[];

  keyActives?: string[];
  textureFinish?: string[];
  sensitivityFlags?: string[];
  pairingRules?: string[];
  comparisonNotes?: string[];

  citations: string[];
};

export function inferKbCanonicalKey(snippet: KbSnippet): KbCanonicalKey {
  return inferKbCanonicalKeyFromSnippet(snippet);
}

function truncateText(value: string, maxChars: number) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function uniqueStrings(items: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function hasAny(haystack: string, needles: string[]) {
  return needles.some((n) => haystack.includes(n));
}

function extractSensitivityFlagsFromText(text: string): string[] {
  const t = String(text ?? "").toLowerCase();
  const flags = new Set<string>();

  if (hasAny(t, ["alcohol denat", "alcohol", "ethanol", "酒精"])) flags.add("alcohol");
  if (hasAny(t, ["fragrance", "parfum", "perfume", "香精", "香料"])) flags.add("fragrance");
  if (hasAny(t, ["essential oil", "精油"])) flags.add("essential_oil");
  if (hasAny(t, ["mint", "peppermint", "薄荷"])) flags.add("mint");
  if (hasAny(t, ["retinol", "retinoid", "tretinoin", "adapalene", "维a", "视黄醇", "阿达帕林"])) flags.add("retinol");
  if (hasAny(t, ["aha", "bha", "pha", "glycolic", "lactic", "mandelic", "salicylic", "azelaic", "acid", "果酸", "水杨酸", "杏仁酸", "壬二酸", "酸"])) {
    flags.add("acid");
  }
  if (hasAny(t, ["sting", "burn", "irritat", "刺痛", "灼热", "刺激"])) flags.add("high_irritation");

  return Array.from(flags);
}

function extractKeyActivesFromText(text: string): string[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];

  const parts = raw
    .replace(/[()（）]/g, " ")
    .split(/[;,，、|/]+/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const cleaned = parts
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 2 && p.length <= 40)
    .filter((p) => !/^good|great|nice|ok|none$/i.test(p));

  return uniqueStrings(cleaned).slice(0, 10);
}

function buildCitations(snippets: KbSnippet[]) {
  const citations = new Set<string>();
  for (const s of snippets) {
    const id = String(s.id ?? "").trim();
    if (id) citations.add(`kb:${id}`);
    else citations.add(`kb:${String(s.source_sheet ?? "").trim()}:${String(s.field ?? "").trim()}`);
  }
  return Array.from(citations).slice(0, 24);
}

function normalizeRiskFlags(flags: unknown): string[] {
  if (!Array.isArray(flags)) return [];
  return uniqueStrings(flags.map((f) => String(f ?? "").trim().toLowerCase()).filter(Boolean));
}

type ExperienceLike = { texture?: unknown; finish?: unknown; pilling_risk?: unknown } | null;

export function buildKbProfile(input: {
  product_id: string;
  display_name: string;
  region: RegionPreference;
  availability: string[] | null | undefined;
  sku_risk_flags?: unknown;
  sku_experience?: ExperienceLike;
  snippets: KbSnippet[];
}): KbProfile {
  const MAX_PER_BUCKET = {
    sensitivity: 3,
    key_actives: 3,
    texture: 2,
    usage: 2,
    comparison: 2,
    notes: 2,
  } as const;

  const availability = Array.isArray(input.availability) ? input.availability.map((v) => String(v)) : [];
  const region: RegionPreference | "Global" = input.region ?? "Global";

  const buckets: Record<KbCanonicalKey, KbSnippet[]> = {
    sensitivity: [],
    key_actives: [],
    texture: [],
    usage: [],
    comparison: [],
    notes: [],
    unknown: [],
  };

  for (const snip of input.snippets) {
    const key = inferKbCanonicalKey(snip);
    buckets[key].push(snip);
  }

  const takeBucketText = (key: keyof typeof MAX_PER_BUCKET) =>
    buckets[key]
      .slice(0, MAX_PER_BUCKET[key])
      .map((s) => truncateText(String(s.content ?? ""), 160))
      .filter(Boolean);

  const sensitivityNotes = takeBucketText("sensitivity");
  const textureNotes = takeBucketText("texture");
  const usageNotes = takeBucketText("usage");
  const comparisonNotes = takeBucketText("comparison");

  const keyActivesFromKb = uniqueStrings(
    buckets.key_actives.slice(0, MAX_PER_BUCKET.key_actives).flatMap((s) => extractKeyActivesFromText(String(s.content ?? ""))),
  );

  const skuRiskFlags = normalizeRiskFlags(input.sku_risk_flags);
  const sensitivityFlags = uniqueStrings([
    ...skuRiskFlags,
    ...extractSensitivityFlagsFromText(sensitivityNotes.join(" ")),
    ...extractSensitivityFlagsFromText(usageNotes.join(" ")),
  ]).slice(0, 12);

  const exp = input.sku_experience ?? null;
  const pillingRisk = typeof exp?.pilling_risk === "number" ? exp.pilling_risk : exp?.pilling_risk ? Number(exp.pilling_risk) : 0;

  const textureFinish = uniqueStrings([
    exp?.texture ? `Texture: ${String(exp.texture)}` : "",
    exp?.finish ? `Finish: ${String(exp.finish)}` : "",
    Number.isFinite(pillingRisk) && pillingRisk > 0.6 ? "Higher pilling risk" : "",
    ...textureNotes,
  ]).filter(Boolean);

  const pairingRules = uniqueStrings([
    ...usageNotes,
    sensitivityFlags.includes("retinol") ? "If using retinoids, avoid stacking with strong acids on the same night." : "",
    sensitivityFlags.includes("acid") ? "Do not stack multiple strong acids in the same routine." : "",
  ]).filter(Boolean);

  const selectedSnippets = [
    ...buckets.sensitivity.slice(0, MAX_PER_BUCKET.sensitivity),
    ...buckets.key_actives.slice(0, MAX_PER_BUCKET.key_actives),
    ...buckets.texture.slice(0, MAX_PER_BUCKET.texture),
    ...buckets.usage.slice(0, MAX_PER_BUCKET.usage),
    ...buckets.comparison.slice(0, MAX_PER_BUCKET.comparison),
    ...buckets.notes.slice(0, MAX_PER_BUCKET.notes),
  ];
  const citations = buildCitations(selectedSnippets);

  return {
    product_id: input.product_id,
    display_name: input.display_name,
    region,
    availability,
    keyActives: keyActivesFromKb.length ? keyActivesFromKb : undefined,
    textureFinish: textureFinish.length ? textureFinish : undefined,
    sensitivityFlags: sensitivityFlags.length ? sensitivityFlags : undefined,
    pairingRules: pairingRules.length ? pairingRules : undefined,
    comparisonNotes: comparisonNotes.length ? comparisonNotes : undefined,
    citations,
  };
}
