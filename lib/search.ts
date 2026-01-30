import "server-only";

import { Prisma } from "@prisma/client";

import { fetchLatestPriceSnapshotsByProductIds } from "@/lib/pricing";
import { prisma } from "@/lib/server/prisma";
import type { ExperienceVector, RiskFlag, SkuCategory, SkuVector, SocialStats } from "@/types";

export type SimilarSku = {
  product_id: string;
  sku: SkuVector;
  distance: number;
  similarity: number; // 0-1 (higher = more similar)
};

type FindSimilarOptions = {
  limit?: number;
  cheaper_than_anchor?: boolean;
  region?: string | null;
};

type SimilarRow = {
  product_id: string;
  brand: string;
  name: string;
  price_usd: unknown;
  mechanism: unknown;
  experience: unknown;
  risk_flags: unknown;
  red_score: unknown;
  reddit_score: unknown;
  burn_rate: unknown;
  top_keywords: unknown;
  distance: unknown;
};

const DEFAULT_LIMIT = 8;
const REGION_CODES = new Set(["CN", "US", "EU"]);

const PRODUCT_OVERRIDES: Array<{
  sku_id: string;
  brand: string;
  name: string;
  category: SkuCategory;
  actives?: string[];
}> = [
  {
    sku_id: "tf_research_serum",
    brand: "Tom Ford",
    name: "Research Serum Concentrate",
    category: "serum",
    actives: ["Vitamin C"],
  },
  {
    sku_id: "to_copper_peptides",
    brand: "The Ordinary",
    name: "Buffet + Copper Peptides 1%",
    category: "treatment",
    actives: ["Copper Peptides"],
  },
  {
    sku_id: "hr_black_bandage",
    brand: "Helena Rubinstein",
    name: "Re-Plasty Age Recovery Night Cream (Black Bandage)",
    category: "moisturizer",
  },
];

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeScore01(value: unknown) {
  const num = typeof value === "number" ? value : value ? Number(value) : 0;
  if (!Number.isFinite(num)) return 0;
  // Support either 0-1 or 0-100 inputs.
  return clamp01(num > 1 ? num / 100 : num);
}

function toNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value && typeof (value as any).toNumber === "function") {
    return (value as any).toNumber();
  }
  return Number(value);
}

function parseJson(value: unknown) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return {};
}

function normalizeTexture(value: unknown): ExperienceVector["texture"] {
  const raw = String(value ?? "").toLowerCase();
  if (!raw) return "lotion";
  if (raw.includes("sticky")) return "sticky";
  if (raw.includes("watery")) return "watery";
  if (raw.includes("gel")) return "gel";
  if (raw.includes("oil")) return "oil";
  if (raw.includes("thick")) return "thick";
  if (raw.includes("cream")) return "cream";
  if (raw.includes("lotion")) return "lotion";
  return "lotion";
}

function normalizeFinish(value: unknown): ExperienceVector["finish"] {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "matte") return "matte";
  if (raw === "dewy") return "dewy";
  return "natural";
}

function mapRiskFlags(rawFlags: unknown): RiskFlag[] {
  const flags = Array.isArray(rawFlags) ? rawFlags.map((f) => String(f).toLowerCase()) : [];
  const out = new Set<RiskFlag>();

  for (const f of flags) {
    if (f.includes("alcohol")) out.add("alcohol");
    if (f.includes("acid")) out.add("acid");
    if (f.includes("high_irritation") || f.includes("irritation") || f.includes("burn") || f.includes("sting")) {
      out.add("high_irritation");
    }
  }

  return Array.from(out);
}

function buildSocialStats(row: SimilarRow): SocialStats {
  const redScore = normalizeScore01(row.red_score ?? 0);
  const redditScore = normalizeScore01(row.reddit_score ?? 0);
  const burnRate = normalizeScore01(toNumber(row.burn_rate ?? 0));

  return {
    platform_scores: { RED: redScore, Reddit: redditScore, Ecommerce: 0, DermSources: 0 },
    RED_score: redScore,
    Reddit_score: redditScore,
    burn_rate: burnRate,
    key_phrases: Array.isArray(row.top_keywords) ? { RED: row.top_keywords.map((k) => String(k)) } : undefined,
  };
}

function categoryOverride(brand: string, name: string) {
  return PRODUCT_OVERRIDES.find((o) => o.brand === brand && o.name === name) ?? null;
}

function inferCategory(name: string): SkuCategory {
  const n = name.toLowerCase();

  if (n.includes("cleanser") || n.includes("facial wash") || n.includes("face wash") || n.includes("foaming")) return "cleanser";
  if (n.includes("toner") || n.includes("essence") || (n.includes("lotion") && !n.includes("cream"))) return "toner";
  if (n.includes("spf") || n.includes("sunscreen") || n.includes("uv")) return "sunscreen";
  if (n.includes("cream") || n.includes("creme") || n.includes("crème") || n.includes("moistur") || n.includes("baume") || n.includes("balm")) return "moisturizer";
  if (n.includes("treatment") || n.includes("retinol") || n.includes("adapalene") || n.includes("acid")) return "treatment";
  if (n.includes("serum") || n.includes("ampoule")) return "serum";

  return "serum";
}

function toSkuVector(row: SimilarRow, opts: { price_usd_override?: number | null } = {}): SkuVector {
  const override = categoryOverride(row.brand, row.name);

  const mechanismRaw = parseJson(row.mechanism);
  const experienceRaw = parseJson(row.experience);

  const oil = normalizeScore01((mechanismRaw as any).oil_control);
  const soothing = normalizeScore01((mechanismRaw as any).soothing);
  const repair = normalizeScore01((mechanismRaw as any).repair ?? (mechanismRaw as any).barrier_repair);
  const brightening = normalizeScore01((mechanismRaw as any).brightening ?? (mechanismRaw as any).anti_aging);

  const redness = normalizeScore01((mechanismRaw as any).redness ?? (mechanismRaw as any).soothing);
  const acne = normalizeScore01((mechanismRaw as any).acne_comedonal ?? (mechanismRaw as any).oil_control);

  const priceUsd = opts.price_usd_override != null ? opts.price_usd_override : toNumber(row.price_usd ?? 0);

  return {
    sku_id: override?.sku_id ?? row.product_id,
    name: row.name,
    brand: row.brand,
    category: override?.category ?? inferCategory(row.name),
    price: Number.isFinite(priceUsd) ? priceUsd : 0,
    currency: "USD",
    mechanism: {
      oil_control: oil,
      soothing,
      repair,
      redness,
      acne_comedonal: acne,
      brightening,
    },
    experience: {
      texture: normalizeTexture((experienceRaw as any).texture),
      finish: normalizeFinish((experienceRaw as any).finish),
      pilling_risk: normalizeScore01((experienceRaw as any).pilling_risk),
    },
    risk_flags: mapRiskFlags(row.risk_flags),
    social_stats: buildSocialStats(row),
    actives: override?.actives,
  };
}

function distanceToSimilarity(distance: number) {
  if (!Number.isFinite(distance)) return 0;
  // pgvector cosine distance is (1 - cosine similarity). Similarity in [-1,1], distance in [0,2].
  return clamp01(1 - distance);
}

export function buildTradeoffNote(anchor: Pick<SkuVector, "price" | "experience">, candidate: Pick<SkuVector, "price" | "experience">) {
  const notes: string[] = [];

  if (candidate.experience.texture === "sticky" || (candidate.experience.stickiness ?? 0) > 0.6) {
    notes.push("Texture is stickier.");
  }

  if ((candidate.experience.pilling_risk ?? 0) > 0.6) {
    notes.push("Higher pilling risk under layering.");
  }

  if (candidate.price < anchor.price) {
    notes.push("Lower price trade-off: expect fewer premium textures/finishes.");
  }

  return notes[0] ?? "Lower-cost alternative.";
}

function ensureUsableDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (required for vector search)");
  if (url.includes("${{")) throw new Error("DATABASE_URL is a Railway template placeholder (set a real connection string)");
}

function vectorLiteral(embedding: number[]) {
  const cleaned = embedding.map((v) => (Number.isFinite(v) ? v : 0));
  return `[${cleaned.join(",")}]`;
}

function normalizeRegion(value: unknown): "CN" | "US" | "EU" | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  if (REGION_CODES.has(upper)) return upper as "CN" | "US" | "EU";
  return null;
}

/**
 * findSimilarProducts (pgvector cosine distance)
 *
 * - Uses the anchor product's stored embedding from `sku_vectors.embedding`
 * - Orders by cosine distance (`<=>`)
 * - Optional cheaper-than-anchor filter
 */
export async function findSimilarProductsByAnchorProductId(
  anchorProductId: string,
  opts: FindSimilarOptions = {},
): Promise<SimilarSku[]> {
  ensureUsableDatabaseUrl();

  const limit = typeof opts.limit === "number" && opts.limit > 0 ? Math.min(50, opts.limit) : DEFAULT_LIMIT;
  const cheaper = opts.cheaper_than_anchor !== false;

  const rows = await prisma.$queryRaw<SimilarRow[]>(
    Prisma.sql`
      WITH anchor AS (
        SELECT p.id AS product_id, p.price_usd AS price_usd, v.embedding AS embedding
        FROM products p
        JOIN sku_vectors v ON v.product_id = p.id
        WHERE p.id = ${anchorProductId}
        LIMIT 1
      )
      SELECT
        p.id AS product_id,
        p.brand AS brand,
        p.name AS name,
        p.price_usd AS price_usd,
        v.mechanism AS mechanism,
        v.experience AS experience,
        v.risk_flags AS risk_flags,
        ss.red_score AS red_score,
        ss.reddit_score AS reddit_score,
        ss.burn_rate AS burn_rate,
        ss.top_keywords AS top_keywords,
        (v.embedding <=> anchor.embedding) AS distance
      FROM anchor
      JOIN products p ON p.id <> anchor.product_id
      JOIN sku_vectors v ON v.product_id = p.id
      LEFT JOIN social_stats ss ON ss.product_id = p.id
      WHERE anchor.embedding IS NOT NULL
        AND v.embedding IS NOT NULL
        AND (${cheaper} = false OR (anchor.price_usd > 0 AND p.price_usd > 0 AND p.price_usd < anchor.price_usd))
      ORDER BY v.embedding <=> anchor.embedding
      LIMIT ${limit};
    `,
  );

  const priceById = await fetchLatestPriceSnapshotsByProductIds(
    rows.map((r) => r.product_id),
    normalizeRegion(opts.region) ?? null,
  );

  return rows
    .map((row) => {
      const snap = priceById.get(row.product_id);
      const sku = toSkuVector(row, { price_usd_override: snap?.price_usd ?? null });
      const distance = toNumber(row.distance ?? 0);
      return {
        product_id: row.product_id,
        sku,
        distance,
        similarity: distanceToSimilarity(distance),
      } satisfies SimilarSku;
    })
    .filter((r) => r.product_id !== anchorProductId);
}

/**
 * findSimilarProductsByEmbedding
 *
 * Useful when you have a query/product embedding vector in JS and want to run DB search.
 * Crucial: we cast the parameter to pgvector via `$1::vector`.
 */
export async function findSimilarProductsByEmbedding(
  embedding: number[],
  opts: { limit?: number; region?: string | null } = {},
) {
  ensureUsableDatabaseUrl();

  const limit = typeof opts.limit === "number" && opts.limit > 0 ? Math.min(50, opts.limit) : DEFAULT_LIMIT;
  const literal = vectorLiteral(embedding);

  const rows = await prisma.$queryRaw<SimilarRow[]>(
    Prisma.sql`
      SELECT
        p.id AS product_id,
        p.brand AS brand,
        p.name AS name,
        p.price_usd AS price_usd,
        v.mechanism AS mechanism,
        v.experience AS experience,
        v.risk_flags AS risk_flags,
        ss.red_score AS red_score,
        ss.reddit_score AS reddit_score,
        ss.burn_rate AS burn_rate,
        ss.top_keywords AS top_keywords,
        (v.embedding <=> ${literal}::vector) AS distance
      FROM products p
      JOIN sku_vectors v ON v.product_id = p.id
      LEFT JOIN social_stats ss ON ss.product_id = p.id
      WHERE v.embedding IS NOT NULL
      ORDER BY v.embedding <=> ${literal}::vector
      LIMIT ${limit};
    `,
  );

  const priceById = await fetchLatestPriceSnapshotsByProductIds(rows.map((r) => r.product_id), normalizeRegion(opts.region));

  return rows.map((row) => {
    const snap = priceById.get(row.product_id);
    const sku = toSkuVector(row, { price_usd_override: snap?.price_usd ?? null });
    const distance = toNumber(row.distance ?? 0);
    return {
      product_id: row.product_id,
      sku,
      distance,
      similarity: distanceToSimilarity(distance),
    } satisfies SimilarSku;
  });
}
