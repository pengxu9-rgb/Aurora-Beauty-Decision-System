import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/server/prisma";

type IngredientMasterRow = {
  ingredient_id: string;
  inci_name: string | null;
  zh_name: string | null;
  synonyms: string | null;
  evidence_grade: string | null;
  categories: string | null;
  primary_benefits: string | null;
  market_presence_notes: string | null;
  social_buzz_notes: string | null;
  representative_products: string | null;
  created_at: Date | null;
  updated_at: Date | null;
};

type IngredientClaimRow = {
  claim_id: string;
  ingredient_id: string | null;
  claim_text: string;
  claim_type: string | null;
  report_location: string | null;
  needs_citation: string | null;
  suggested_source_types: string | null;
  created_at: Date | null;
  updated_at: Date | null;
};

type IngredientProductRow = {
  product_id: string;
  ingredient_id: string;
  brand: string | null;
  product_name: string | null;
  product_rank: number | null;
  size: string | null;
  price_range: string | null;
  key_claims: string | null;
  ingredient_form_or_percent_if_known: string | null;
  skin_types: string | null;
  where_it_sells: string | null;
  evidence_links: string | null;
  created_at: Date | null;
  updated_at: Date | null;
};

type SocialThemeRow = {
  theme_id: string;
  ingredient_id: string;
  theme_label: string | null;
  sentiment: string | null;
  what_users_report: string | null;
  common_conditions: string | null;
  channels_covered: string | null;
  takeaway: string | null;
  created_at: Date | null;
  updated_at: Date | null;
};

type IngredientSuitabilityRuleRow = {
  ingredient_id: string;
  good_for: string | null;
  caution_for: string | null;
  avoid_for: string | null;
  pairing_recommended: string | null;
  pairing_conflicts: string | null;
  layering_am_pm: string | null;
  frequency: string | null;
  order_notes: string | null;
  build_tolerance_notes: string | null;
  safety_notes: string | null;
  regulatory_notes: string | null;
  created_at: Date | null;
  updated_at: Date | null;
};

export type IngredientResearchProfileV1 = {
  schema_version: "aurora.ingredient_research_profile.v1";
  ingredient_id: string;
  kb_schema: string;
  kb_ready: boolean;
  missing_tables: string[];
  ingredient: IngredientMasterRow | null;
  claims: IngredientClaimRow[];
  top_products: IngredientProductRow[];
  social_themes: SocialThemeRow[];
  suitability_rule: IngredientSuitabilityRuleRow | null;
};

export type IngredientKbHealthV1 = {
  kb_schema: string;
  kb_ready: boolean;
  missing_tables: string[];
  present_tables: string[];
};

export type IngredientResearchSearchHitV1 = Pick<
  IngredientMasterRow,
  "ingredient_id" | "inci_name" | "zh_name" | "synonyms" | "categories" | "primary_benefits" | "evidence_grade"
>;

export type IngredientResearchSearchOutputV1 = {
  schema_version: "aurora.ingredient_research_search.v1";
  query: string;
  kb_schema: string;
  kb_ready: boolean;
  missing_tables: string[];
  hits: IngredientResearchSearchHitV1[];
};

const REQUIRED_TABLES = [
  "ingredients_master",
  "ingredient_claims",
  "ingredient_products",
  "social_themes",
  "ingredient_suitability_rules",
] as const;

function safeSchemaName(raw: string | undefined | null): string {
  const s = String(raw ?? "public").trim();
  if (!s) return "public";
  // Strict identifier: avoid SQL injection via env var.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) return "public";
  return s;
}

function qIdent(ident: string): string {
  // Ident must already be validated; still escape quotes defensively.
  return `"${ident.replace(/"/g, '""')}"`;
}

function tableRef(schema: string, table: string) {
  const sch = safeSchemaName(schema);
  const tbl = safeSchemaName(table);
  return Prisma.raw(`${qIdent(sch)}.${qIdent(tbl)}`);
}

function isMissingTableError(err: unknown): boolean {
  const e = err as any;
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? "");
  return code === "42P01" || /relation .* does not exist/i.test(msg);
}

export async function ingredientKbHealthV1(): Promise<{
  kb_schema: string;
  kb_ready: boolean;
  missing_tables: string[];
  present_tables: string[];
}> {
  const schema = safeSchemaName(process.env.AURORA_KB_SCHEMA);
  const rows = await prisma.$queryRaw<{ table_name: string }[]>(
    Prisma.sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${schema}
        AND table_name IN (${Prisma.join([...REQUIRED_TABLES])})
    `,
  );
  const present = Array.isArray(rows) ? rows.map((r) => String(r.table_name)) : [];
  const presentSet = new Set(present);
  const missing = REQUIRED_TABLES.filter((t) => !presentSet.has(t));
  return { kb_schema: schema, kb_ready: missing.length === 0, missing_tables: [...missing], present_tables: present };
}

export async function getIngredientResearchProfileV1(
  ingredientIdRaw: string,
  opts: { claims_limit?: number; products_limit?: number; themes_limit?: number } = {},
  ctx: { health?: IngredientKbHealthV1 } = {},
): Promise<IngredientResearchProfileV1> {
  const ingredient_id = String(ingredientIdRaw ?? "").trim();
  const schema = safeSchemaName(process.env.AURORA_KB_SCHEMA);

  const health = ctx.health ?? (await ingredientKbHealthV1());
  const claimsLimit = typeof opts.claims_limit === "number" && opts.claims_limit > 0 ? Math.min(200, opts.claims_limit) : 50;
  const productsLimit = typeof opts.products_limit === "number" && opts.products_limit > 0 ? Math.min(200, opts.products_limit) : 50;
  const themesLimit = typeof opts.themes_limit === "number" && opts.themes_limit > 0 ? Math.min(200, opts.themes_limit) : 30;

  if (!ingredient_id) {
    return {
      schema_version: "aurora.ingredient_research_profile.v1",
      ingredient_id: "",
      kb_schema: schema,
      kb_ready: health.kb_ready,
      missing_tables: health.missing_tables,
      ingredient: null,
      claims: [],
      top_products: [],
      social_themes: [],
      suitability_rule: null,
    };
  }

  if (!health.kb_ready) {
    return {
      schema_version: "aurora.ingredient_research_profile.v1",
      ingredient_id,
      kb_schema: schema,
      kb_ready: false,
      missing_tables: health.missing_tables,
      ingredient: null,
      claims: [],
      top_products: [],
      social_themes: [],
      suitability_rule: null,
    };
  }

  try {
    const ingredientRows = await prisma.$queryRaw<IngredientMasterRow[]>(
      Prisma.sql`
        SELECT *
        FROM ${tableRef(schema, "ingredients_master")}
        WHERE ingredient_id = ${ingredient_id}
        LIMIT 1
      `,
    );
    const ingredient = ingredientRows?.[0] ?? null;

    const claims = await prisma.$queryRaw<IngredientClaimRow[]>(
      Prisma.sql`
        SELECT *
        FROM ${tableRef(schema, "ingredient_claims")}
        WHERE ingredient_id = ${ingredient_id}
        ORDER BY claim_id ASC
        LIMIT ${claimsLimit}
      `,
    );

    const top_products = await prisma.$queryRaw<IngredientProductRow[]>(
      Prisma.sql`
        SELECT *
        FROM ${tableRef(schema, "ingredient_products")}
        WHERE ingredient_id = ${ingredient_id}
        ORDER BY product_rank ASC NULLS LAST, product_id ASC
        LIMIT ${productsLimit}
      `,
    );

    const social_themes = await prisma.$queryRaw<SocialThemeRow[]>(
      Prisma.sql`
        SELECT *
        FROM ${tableRef(schema, "social_themes")}
        WHERE ingredient_id = ${ingredient_id}
        ORDER BY theme_id ASC
        LIMIT ${themesLimit}
      `,
    );

    const suitability = await prisma.$queryRaw<IngredientSuitabilityRuleRow[]>(
      Prisma.sql`
        SELECT *
        FROM ${tableRef(schema, "ingredient_suitability_rules")}
        WHERE ingredient_id = ${ingredient_id}
        LIMIT 1
      `,
    );

    return {
      schema_version: "aurora.ingredient_research_profile.v1",
      ingredient_id,
      kb_schema: schema,
      kb_ready: true,
      missing_tables: [],
      ingredient,
      claims: Array.isArray(claims) ? claims : [],
      top_products: Array.isArray(top_products) ? top_products : [],
      social_themes: Array.isArray(social_themes) ? social_themes : [],
      suitability_rule: suitability?.[0] ?? null,
    };
  } catch (err) {
    if (isMissingTableError(err)) {
      return {
        schema_version: "aurora.ingredient_research_profile.v1",
        ingredient_id,
        kb_schema: schema,
        kb_ready: false,
        missing_tables: [...REQUIRED_TABLES],
        ingredient: null,
        claims: [],
        top_products: [],
        social_themes: [],
        suitability_rule: null,
      };
    }
    throw err;
  }
}

export async function searchIngredientResearchV1(queryRaw: string, limitRaw = 20): Promise<IngredientResearchSearchOutputV1> {
  const query = String(queryRaw ?? "").trim();
  const schema = safeSchemaName(process.env.AURORA_KB_SCHEMA);
  const health = await ingredientKbHealthV1();
  const limit = typeof limitRaw === "number" && limitRaw > 0 ? Math.min(50, limitRaw) : 20;

  if (!query) {
    return {
      schema_version: "aurora.ingredient_research_search.v1",
      query: "",
      kb_schema: schema,
      kb_ready: health.kb_ready,
      missing_tables: health.missing_tables,
      hits: [],
    };
  }

  if (!health.kb_ready) {
    return {
      schema_version: "aurora.ingredient_research_search.v1",
      query,
      kb_schema: schema,
      kb_ready: false,
      missing_tables: health.missing_tables,
      hits: [],
    };
  }

  const like = `%${query}%`;
  try {
    const rows = await prisma.$queryRaw<IngredientResearchSearchHitV1[]>(
      Prisma.sql`
        SELECT ingredient_id, inci_name, zh_name, synonyms, categories, primary_benefits, evidence_grade
        FROM ${tableRef(schema, "ingredients_master")}
        WHERE ingredient_id ILIKE ${like}
           OR inci_name ILIKE ${like}
           OR zh_name ILIKE ${like}
           OR synonyms ILIKE ${like}
        ORDER BY
          CASE WHEN ingredient_id ILIKE ${query} THEN 0 ELSE 1 END,
          ingredient_id ASC
        LIMIT ${limit}
      `,
    );
    return {
      schema_version: "aurora.ingredient_research_search.v1",
      query,
      kb_schema: schema,
      kb_ready: true,
      missing_tables: [],
      hits: Array.isArray(rows) ? rows : [],
    };
  } catch (err) {
    if (isMissingTableError(err)) {
      return {
        schema_version: "aurora.ingredient_research_search.v1",
        query,
        kb_schema: schema,
        kb_ready: false,
        missing_tables: [...REQUIRED_TABLES],
        hits: [],
      };
    }
    throw err;
  }
}
