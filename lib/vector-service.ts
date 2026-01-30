import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/server/prisma";
import { findSimilarProductsByAnchorProductId, findSimilarProductsByEmbedding, type SimilarSku } from "@/lib/search";

export type RegionPreference = "CN" | "US" | "EU" | null;

export type SimilarSkuWithAvailability = SimilarSku & {
  availability: string[]; // products.region_availability
};

type AvailabilityRow = { id: string; region_availability: string[] | null };

function normalizeAvailability(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function isProductAvailableInRegion(availability: string[], region: RegionPreference): boolean {
  if (!region) return true;
  if (!availability.length) return true; // treat unknown/empty as "not restricted" for MVP

  const upper = availability.map((r) => r.toUpperCase());
  return upper.includes(region) || upper.includes("GLOBAL");
}

async function fetchAvailabilityByProductIds(productIds: string[]): Promise<Map<string, string[]>> {
  if (!productIds.length) return new Map();
  const rows = await prisma.$queryRaw<AvailabilityRow[]>(
    Prisma.sql`SELECT id, region_availability FROM products WHERE id IN (${Prisma.join(productIds)});`,
  );
  const out = new Map<string, string[]>();
  for (const row of rows) out.set(row.id, normalizeAvailability(row.region_availability));
  return out;
}

export async function findSimilarSkusByAnchorProductId(
  anchorProductId: string,
  opts: { limit?: number; cheaper_than_anchor?: boolean; region?: RegionPreference } = {},
): Promise<SimilarSkuWithAvailability[]> {
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? Math.min(50, opts.limit) : 8;
  const region = opts.region ?? null;

  // Over-fetch then filter to avoid "empty results" when a region filter is applied.
  const overfetch = Math.min(50, Math.max(limit, limit * 10));

  const raw = await findSimilarProductsByAnchorProductId(anchorProductId, {
    limit: overfetch,
    cheaper_than_anchor: opts.cheaper_than_anchor,
    region,
  });

  const availabilityById = await fetchAvailabilityByProductIds(raw.map((r) => r.product_id));

  const out: SimilarSkuWithAvailability[] = [];
  for (const row of raw) {
    const availability = availabilityById.get(row.product_id) ?? [];
    if (!isProductAvailableInRegion(availability, region)) continue;
    out.push({ ...row, availability });
    if (out.length >= limit) break;
  }

  return out;
}

export async function findSimilarSkusByEmbedding(
  embedding: number[],
  opts: { limit?: number; region?: RegionPreference } = {},
): Promise<SimilarSkuWithAvailability[]> {
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? Math.min(50, opts.limit) : 8;
  const region = opts.region ?? null;

  const overfetch = Math.min(50, Math.max(limit, limit * 10));
  const raw = await findSimilarProductsByEmbedding(embedding, { limit: overfetch, region });

  const availabilityById = await fetchAvailabilityByProductIds(raw.map((r) => r.product_id));

  const out: SimilarSkuWithAvailability[] = [];
  for (const row of raw) {
    const availability = availabilityById.get(row.product_id) ?? [];
    if (!isProductAvailableInRegion(availability, region)) continue;
    out.push({ ...row, availability });
    if (out.length >= limit) break;
  }

  return out;
}

// Simple alias matching the spec: findSimilarSkus(embedding, limit, region)
export async function findSimilarSkus(embedding: number[], limit = 5, region: RegionPreference = null) {
  return await findSimilarSkusByEmbedding(embedding, { limit, region });
}
