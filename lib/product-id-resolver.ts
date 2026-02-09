import "server-only";

import { prisma } from "@/lib/server/prisma";

export type ProductIdResolution = {
  product_id: string;
  matched_by: "product_id" | "crosswalk" | "alias";
  source_system: string | null;
  source_type: string | null;
  matched_ref: string | null;
  confidence: number | null;
};

export type ResolveProductIdInput = {
  value: string;
  sourceSystem?: string | null;
  sourceType?: string | null;
  allowAliasFallback?: boolean;
};

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeText(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}

function normalizeToken(value: string | null | undefined): string | null {
  const out = normalizeText(String(value ?? ""));
  return out || null;
}

function normalizeAliasText(value: string) {
  const nkfc = String(value ?? "").normalize("NFKC").toLowerCase();
  return nkfc.replace(/\s+/g, "").replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
}

function canonicalizeUrlReference(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    const hostname = parsed.hostname.toLowerCase();
    const normalizedPath = decodeURIComponent(parsed.pathname || "/")
      .replace(/\/+$/g, "")
      .replace(/\/{2,}/g, "/");

    return `${hostname}${normalizedPath || "/"}`;
  } catch {
    return null;
  }
}

function buildRefCandidates(raw: string): string[] {
  const out = new Set<string>();
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return [];

  out.add(normalizeText(trimmed));

  const canonical = canonicalizeUrlReference(trimmed);
  if (canonical) out.add(canonical);

  try {
    const decoded = decodeURIComponent(trimmed);
    if (decoded && decoded !== trimmed) {
      out.add(normalizeText(decoded));
      const decodedCanonical = canonicalizeUrlReference(decoded);
      if (decodedCanonical) out.add(decodedCanonical);
    }
  } catch {
    // Ignore malformed URI inputs and keep best-effort candidates.
  }

  return Array.from(out).filter(Boolean);
}

async function resolveByCrosswalk(input: {
  value: string;
  sourceSystem: string | null;
  sourceType: string | null;
}): Promise<ProductIdResolution | null> {
  const refs = buildRefCandidates(input.value);
  if (!refs.length) return null;

  const rows = await prisma.productCrosswalk.findMany({
    where: {
      externalRefNormalized: { in: refs },
      ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {}),
      ...(input.sourceType ? { sourceType: input.sourceType } : {}),
    },
    orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
    take: 5,
    select: {
      productId: true,
      sourceSystem: true,
      sourceType: true,
      externalRef: true,
      confidence: true,
    },
  });

  const match = rows[0] ?? null;
  if (!match) return null;

  return {
    product_id: match.productId,
    matched_by: "crosswalk",
    source_system: match.sourceSystem,
    source_type: match.sourceType,
    matched_ref: match.externalRef,
    confidence: Number.isFinite(match.confidence) ? Number(match.confidence) : null,
  };
}

async function resolveByAlias(value: string): Promise<ProductIdResolution | null> {
  const aliasNormalized = normalizeAliasText(value);
  if (!aliasNormalized || aliasNormalized.length < 2) return null;

  const row = await prisma.productAlias.findFirst({
    where: { aliasNormalized },
    orderBy: [{ weight: "desc" }, { updatedAt: "desc" }],
    select: {
      productId: true,
      alias: true,
      kind: true,
      weight: true,
    },
  });

  if (!row) return null;

  return {
    product_id: row.productId,
    matched_by: "alias",
    source_system: "aurora",
    source_type: row.kind ?? "alias",
    matched_ref: row.alias,
    confidence: Number.isFinite(row.weight) ? Number(row.weight) : null,
  };
}

export async function resolveAuroraProductId(input: ResolveProductIdInput): Promise<ProductIdResolution | null> {
  const raw = String(input.value ?? "").trim();
  if (!raw) return null;

  if (looksLikeUuid(raw)) {
    const row = await prisma.product.findUnique({ where: { id: raw }, select: { id: true } });
    if (row?.id) {
      return {
        product_id: row.id,
        matched_by: "product_id",
        source_system: "aurora",
        source_type: "product_id",
        matched_ref: raw,
        confidence: 100,
      };
    }
  }

  const byCrosswalk = await resolveByCrosswalk({
    value: raw,
    sourceSystem: normalizeToken(input.sourceSystem),
    sourceType: normalizeToken(input.sourceType),
  });
  if (byCrosswalk) return byCrosswalk;

  if (input.allowAliasFallback === false) return null;

  const byAlias = await resolveByAlias(raw);
  if (byAlias) return byAlias;

  return null;
}
