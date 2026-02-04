import { NextResponse } from "next/server";

import { ingredientSearchV1, type IngredientSearchInputV1 } from "@/lib/ingredient-search";

import { corsPreflight, withCors } from "../_cors";

const SCHEMA_VERSION = "aurora.ingredient_search.v1" as const;
const REGION_CODES = new Set(["CN", "US", "EU"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseInput(body: unknown): { ok: true; input: IngredientSearchInputV1 } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: "Body must be an object" };
  if (body.schema_version !== SCHEMA_VERSION) return { ok: false, error: `schema_version must be "${SCHEMA_VERSION}"` };

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return { ok: false, error: "`query` is required" };

  const limitRaw = (body as any).limit;
  const limitNum = typeof limitRaw === "number" ? limitRaw : typeof limitRaw === "string" ? Number(limitRaw) : undefined;
  const limit = Number.isFinite(limitNum) && (limitNum as number) > 0 ? Math.min(50, limitNum as number) : undefined;

  const regionRaw = (body as any).region;
  const region = typeof regionRaw === "string" ? regionRaw.trim().toUpperCase() : null;
  const regionNormalized = region && REGION_CODES.has(region) ? (region as "CN" | "US" | "EU") : null;

  const filters = isObject((body as any).filters) ? ((body as any).filters as Record<string, unknown>) : null;
  const productIds =
    filters && Array.isArray(filters.product_ids)
      ? (filters.product_ids as unknown[]).map((v) => String(v).trim()).filter(Boolean)
      : undefined;

  const includeKbSnippets = Boolean(filters?.include_kb_snippets);

  const input: IngredientSearchInputV1 = {
    schema_version: SCHEMA_VERSION,
    query,
    region: regionNormalized,
    limit,
    filters: {
      product_ids: productIds,
      include_kb_snippets: includeKbSnippets,
    },
  };

  return { ok: true, input };
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return withCors(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  const parsed = parseInput(body);
  if (!parsed.ok) return withCors(NextResponse.json({ error: parsed.error }, { status: 400 }));

  const out = await ingredientSearchV1(parsed.input);
  return withCors(NextResponse.json(out));
}

export function OPTIONS() {
  return corsPreflight();
}

