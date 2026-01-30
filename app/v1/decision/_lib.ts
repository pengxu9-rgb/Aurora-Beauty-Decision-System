import { AURORA_SKU_DB } from "@/data/mock-db";
import { fetchLatestPriceSnapshotsByProductIds } from "@/lib/pricing";
import { prisma } from "@/lib/server/prisma";
import type { ExperienceVector, RiskFlag, SkuCategory, SkuVector, SocialStats } from "@/types";

const USD_TO_CNY = 7.2;

type AliasSku = {
  sku_id: string;
  brand: string;
  name: string;
  category: SkuCategory;
  actives?: string[];
  notes?: string[];
};

const ALIAS_SKUS: AliasSku[] = [
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

function resolveUsdPrice(product: any, snapshot?: { price_usd: number | null; price_cny: number | null } | null) {
  const snapUsd = snapshot?.price_usd ?? null;
  if (snapUsd != null && Number.isFinite(snapUsd) && snapUsd > 0) return snapUsd;

  const prodUsd = toNumber(product?.priceUsd ?? 0);
  if (Number.isFinite(prodUsd) && prodUsd > 0) return prodUsd;

  const snapCny = snapshot?.price_cny ?? null;
  if (snapCny != null && Number.isFinite(snapCny) && snapCny > 0) return snapCny / USD_TO_CNY;

  const prodCny = toNumber(product?.priceCny ?? 0);
  if (Number.isFinite(prodCny) && prodCny > 0) return prodCny / USD_TO_CNY;

  return 0;
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
    if (f.includes("high_irritation") || f.includes("irritation")) out.add("high_irritation");
  }

  return Array.from(out);
}

function buildSocialStats(row: { socialStats: any } | null): SocialStats {
  const ss = row?.socialStats;
  const redScore = normalizeScore01(ss?.redScore ?? 0);
  const redditScore = normalizeScore01(ss?.redditScore ?? 0);
  const burnRate = normalizeScore01(toNumber(ss?.burnRate ?? 0));

  const platform_scores = { RED: redScore, Reddit: redditScore, Ecommerce: 0, DermSources: 0 };

  return {
    platform_scores,
    RED_score: redScore,
    Reddit_score: redditScore,
    burn_rate: burnRate,
    key_phrases: ss?.topKeywords ? { RED: Array.isArray(ss.topKeywords) ? ss.topKeywords : [String(ss.topKeywords)] } : undefined,
  };
}

function aliasForIdentity(brand: string, name: string) {
  return ALIAS_SKUS.find((a) => a.brand === brand && a.name === name) ?? null;
}

function aliasForSkuId(skuId: string) {
  return ALIAS_SKUS.find((a) => a.sku_id === skuId) ?? null;
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

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mapProductToSkuVector(product: any, opts: { price_snapshot?: { price_usd: number | null; price_cny: number | null } | null } = {}): SkuVector | null {
  const vectors = product?.vectors;
  if (!vectors) return null;

  const alias = aliasForIdentity(product.brand, product.name);

  const mechanismRaw = vectors.mechanism ?? {};
  const experienceRaw = vectors.experience ?? {};

  const oil = normalizeScore01((mechanismRaw as any).oil_control);
  const soothing = normalizeScore01((mechanismRaw as any).soothing);
  const repair = normalizeScore01((mechanismRaw as any).repair ?? (mechanismRaw as any).barrier_repair);
  const brightening = normalizeScore01((mechanismRaw as any).brightening ?? (mechanismRaw as any).anti_aging);

  // Heuristic fallbacks when the upstream schema doesn't provide these fields.
  const redness = normalizeScore01((mechanismRaw as any).redness ?? (mechanismRaw as any).soothing);
  const acne = normalizeScore01((mechanismRaw as any).acne_comedonal ?? (mechanismRaw as any).oil_control);

  const price = resolveUsdPrice(product, opts.price_snapshot);

  const sku: SkuVector = {
    sku_id: alias?.sku_id ?? product.id,
    name: product.name,
    brand: product.brand,
    category: alias?.category ?? inferCategory(String(product.name ?? "")),
    price: Number.isFinite(price) ? price : 0,
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
    risk_flags: mapRiskFlags(vectors.riskFlags),
    social_stats: buildSocialStats(product),
    actives: alias?.actives,
    notes: alias?.notes,
  };

  return sku;
}

async function fetchAllSkusFromDb(): Promise<SkuVector[]> {
  const products = await prisma.product.findMany({
    include: { vectors: true, socialStats: true },
    orderBy: { updatedAt: "desc" },
  });

  const priceById = await fetchLatestPriceSnapshotsByProductIds(products.map((p) => p.id));
  return products
    .map((p) => mapProductToSkuVector(p, { price_snapshot: priceById.get(p.id) ?? null }))
    .filter((s): s is SkuVector => Boolean(s));
}

async function fetchSkuByIdentity(brand: string, name: string): Promise<SkuVector | null> {
  const product = await prisma.product.findFirst({
    where: { brand, name },
    include: { vectors: true, socialStats: true },
  });

  if (!product) return null;
  const priceById = await fetchLatestPriceSnapshotsByProductIds([product.id]);
  return mapProductToSkuVector(product, { price_snapshot: priceById.get(product.id) ?? null });
}

async function fetchSkuByProductId(productId: string): Promise<SkuVector | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { vectors: true, socialStats: true },
  });

  if (!product) return null;
  const priceById = await fetchLatestPriceSnapshotsByProductIds([product.id]);
  return mapProductToSkuVector(product, { price_snapshot: priceById.get(product.id) ?? null });
}

function shouldUseDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  // If it's a Railway template placeholder, it's not usable outside Railway runtime.
  if (url.includes("${{")) return false;
  return true;
}

export async function resolveProductIdForSkuId(skuId: string): Promise<string | null> {
  if (!shouldUseDb()) return null;
  if (looksLikeUuid(skuId)) return skuId;

  const alias = aliasForSkuId(skuId);
  if (!alias) return null;

  const product = await prisma.product.findFirst({
    where: { brand: alias.brand, name: alias.name },
    select: { id: true },
  });

  return product?.id ?? null;
}

export async function getSkuById(skuId: string): Promise<SkuVector | null> {
  if (!shouldUseDb()) {
    return AURORA_SKU_DB.find((s) => s.sku_id === skuId) ?? null;
  }

  if (looksLikeUuid(skuId)) return await fetchSkuByProductId(skuId);

  const alias = aliasForSkuId(skuId);
  if (alias) return await fetchSkuByIdentity(alias.brand, alias.name);

  // Fallback: treat unknown strings as product ids if they look uuid-ish, else try mock.
  return await fetchSkuByProductId(skuId);
}

export async function getSkuDatabase(): Promise<SkuVector[]> {
  if (!shouldUseDb()) return AURORA_SKU_DB;
  return await fetchAllSkusFromDb();
}
