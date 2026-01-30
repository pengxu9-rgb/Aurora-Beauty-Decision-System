import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/server/prisma";
import type { RegionPreference } from "@/lib/vector-service";

export type EffectivePriceSnapshot = {
  product_id: string;
  region: string | null;
  currency: string | null;
  price_usd: number | null;
  price_cny: number | null;
  source: string | null;
  source_url: string | null;
  confidence: number | null;
  captured_at: string | null; // ISO
};

type PriceRow = {
  product_id: string;
  region: string | null;
  currency: string | null;
  price_usd: unknown;
  price_cny: unknown;
  source: string | null;
  source_url: string | null;
  confidence: unknown;
  captured_at: Date | null;
};

let _priceSnapshotsTableAvailable: boolean | null = null;

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "object" && value && "toNumber" in value && typeof (value as any).toNumber === "function") {
    try {
      const n = (value as any).toNumber();
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIso(value: Date | null): string | null {
  if (!value) return null;
  try {
    return value.toISOString();
  } catch {
    return null;
  }
}

/**
 * Fetch the latest price snapshot per product id.
 *
 * Region selection (when region is provided):
 * - Prefer exact region match
 * - Else prefer "Global"
 * - Else accept NULL region
 *
 * NOTE: this is read-only and safe for hot paths.
 */
export async function fetchLatestPriceSnapshotsByProductIds(
  productIds: string[],
  region: RegionPreference = null,
): Promise<Map<string, EffectivePriceSnapshot>> {
  if (!productIds.length) return new Map();
  if (_priceSnapshotsTableAvailable === false) return new Map();

  // Deduplicate to keep SQL smaller.
  const ids = Array.from(new Set(productIds));

  const whereClauses: Prisma.Sql[] = [Prisma.sql`pps.product_id IN (${Prisma.join(ids)})`];
  if (region) {
    whereClauses.push(Prisma.sql`(pps.region IS NULL OR pps.region = ${region} OR pps.region = 'Global')`);
  }

  const orderByParts: Prisma.Sql[] = [Prisma.sql`pps.product_id`];
  if (region) {
    orderByParts.push(
      Prisma.sql`CASE
        WHEN pps.region = ${region} THEN 0
        WHEN pps.region = 'Global' THEN 1
        WHEN pps.region IS NULL THEN 2
        ELSE 3
      END`,
    );
  }
  orderByParts.push(Prisma.sql`pps.captured_at DESC`);

  let rows: PriceRow[] = [];
  try {
    rows = await prisma.$queryRaw<PriceRow[]>(
      Prisma.sql`
        SELECT DISTINCT ON (pps.product_id)
          pps.product_id,
          pps.region,
          pps.currency,
          pps.price_usd,
          pps.price_cny,
          pps.source,
          pps.source_url,
          pps.confidence,
          pps.captured_at
        FROM product_price_snapshots pps
        WHERE ${Prisma.join(whereClauses, " AND ")}
        ORDER BY ${Prisma.join(orderByParts, ", ")};
      `,
    );
    _priceSnapshotsTableAvailable = true;
  } catch (e) {
    // Backward compatible: the table may not be migrated yet in some environments.
    // Treat as "no snapshots" rather than failing the request.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("product_price_snapshots") && msg.toLowerCase().includes("does not exist")) {
      _priceSnapshotsTableAvailable = false;
      return new Map();
    }
    return new Map();
  }

  const out = new Map<string, EffectivePriceSnapshot>();
  for (const row of rows) {
    out.set(row.product_id, {
      product_id: row.product_id,
      region: row.region,
      currency: row.currency,
      price_usd: toNumber(row.price_usd),
      price_cny: toNumber(row.price_cny),
      source: row.source,
      source_url: row.source_url,
      confidence: toNumber(row.confidence),
      captured_at: toIso(row.captured_at),
    });
  }

  return out;
}
