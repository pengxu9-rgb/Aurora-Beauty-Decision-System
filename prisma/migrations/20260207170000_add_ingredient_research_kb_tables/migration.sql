-- Ingredient Research KB (Layer2) tables
-- These tables are intentionally kept outside Prisma models for now; access is via raw SQL.

CREATE TABLE IF NOT EXISTS "ingredients_master" (
    "ingredient_id" TEXT NOT NULL,
    "inci_name" TEXT,
    "zh_name" TEXT,
    "synonyms" TEXT,
    "categories" TEXT,
    "primary_benefits" TEXT,
    "evidence_grade" TEXT,
    "market_presence_notes" TEXT,
    "social_buzz_notes" TEXT,
    "representative_products" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingredients_master_pkey" PRIMARY KEY ("ingredient_id")
);

CREATE TABLE IF NOT EXISTS "ingredient_claims" (
    "claim_id" TEXT NOT NULL,
    "ingredient_id" TEXT,
    "claim_text" TEXT NOT NULL,
    "claim_type" TEXT,
    "report_location" TEXT,
    "needs_citation" TEXT,
    "suggested_source_types" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingredient_claims_pkey" PRIMARY KEY ("claim_id")
);

CREATE TABLE IF NOT EXISTS "ingredient_products" (
    "product_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "product_rank" INTEGER,
    "brand" TEXT,
    "product_name" TEXT,
    "size" TEXT,
    "price_range" TEXT,
    "key_claims" TEXT,
    "ingredient_form_or_percent_if_known" TEXT,
    "skin_types" TEXT,
    "where_it_sells" TEXT,
    "evidence_links" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingredient_products_pkey" PRIMARY KEY ("product_id")
);

CREATE TABLE IF NOT EXISTS "social_themes" (
    "theme_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "theme_label" TEXT,
    "sentiment" TEXT,
    "what_users_report" TEXT,
    "common_conditions" TEXT,
    "channels_covered" TEXT,
    "takeaway" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_themes_pkey" PRIMARY KEY ("theme_id")
);

CREATE TABLE IF NOT EXISTS "ingredient_suitability_rules" (
    "ingredient_id" TEXT NOT NULL,
    "good_for" TEXT,
    "caution_for" TEXT,
    "avoid_for" TEXT,
    "pairing_recommended" TEXT,
    "pairing_conflicts" TEXT,
    "layering_am_pm" TEXT,
    "frequency" TEXT,
    "order_notes" TEXT,
    "build_tolerance_notes" TEXT,
    "safety_notes" TEXT,
    "regulatory_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingredient_suitability_rules_pkey" PRIMARY KEY ("ingredient_id")
);

-- Optional tables (present in data dir but may be empty). We keep them for schema completeness.
CREATE TABLE IF NOT EXISTS "ingredient_papers" (
    "paper_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "citation" TEXT,
    "year" INTEGER,
    "study_type" TEXT,
    "n" INTEGER,
    "concentration_or_formulation" TEXT,
    "duration" TEXT,
    "outcomes" TEXT,
    "limitations" TEXT,
    "doi_or_link" TEXT,
    "evidence_level" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingredient_papers_pkey" PRIMARY KEY ("paper_id")
);

CREATE TABLE IF NOT EXISTS "ingredient_brand_claims" (
    "claim_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "claim_summary" TEXT,
    "common_wording_examples" TEXT,
    "alignment_with_science" TEXT,
    "source_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingredient_brand_claims_pkey" PRIMARY KEY ("claim_id")
);

CREATE TABLE IF NOT EXISTS "ingredient_social_quotes" (
    "quote_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "theme_id" TEXT,
    "channel" TEXT,
    "short_quote" TEXT,
    "context" TEXT,
    "sentiment" TEXT,
    "url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingredient_social_quotes_pkey" PRIMARY KEY ("quote_id")
);

CREATE INDEX IF NOT EXISTS "ingredient_claims_ingredient_id_idx" ON "ingredient_claims" ("ingredient_id");
CREATE INDEX IF NOT EXISTS "ingredient_products_ingredient_id_idx" ON "ingredient_products" ("ingredient_id");
CREATE INDEX IF NOT EXISTS "social_themes_ingredient_id_idx" ON "social_themes" ("ingredient_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingredient_claims_ingredient_id_fkey') THEN
    ALTER TABLE "ingredient_claims"
      ADD CONSTRAINT "ingredient_claims_ingredient_id_fkey"
      FOREIGN KEY ("ingredient_id") REFERENCES "ingredients_master"("ingredient_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingredient_products_ingredient_id_fkey') THEN
    ALTER TABLE "ingredient_products"
      ADD CONSTRAINT "ingredient_products_ingredient_id_fkey"
      FOREIGN KEY ("ingredient_id") REFERENCES "ingredients_master"("ingredient_id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_themes_ingredient_id_fkey') THEN
    ALTER TABLE "social_themes"
      ADD CONSTRAINT "social_themes_ingredient_id_fkey"
      FOREIGN KEY ("ingredient_id") REFERENCES "ingredients_master"("ingredient_id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingredient_suitability_rules_ingredient_id_fkey') THEN
    ALTER TABLE "ingredient_suitability_rules"
      ADD CONSTRAINT "ingredient_suitability_rules_ingredient_id_fkey"
      FOREIGN KEY ("ingredient_id") REFERENCES "ingredients_master"("ingredient_id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingredient_papers_ingredient_id_fkey') THEN
    ALTER TABLE "ingredient_papers"
      ADD CONSTRAINT "ingredient_papers_ingredient_id_fkey"
      FOREIGN KEY ("ingredient_id") REFERENCES "ingredients_master"("ingredient_id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingredient_brand_claims_ingredient_id_fkey') THEN
    ALTER TABLE "ingredient_brand_claims"
      ADD CONSTRAINT "ingredient_brand_claims_ingredient_id_fkey"
      FOREIGN KEY ("ingredient_id") REFERENCES "ingredients_master"("ingredient_id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingredient_social_quotes_ingredient_id_fkey') THEN
    ALTER TABLE "ingredient_social_quotes"
      ADD CONSTRAINT "ingredient_social_quotes_ingredient_id_fkey"
      FOREIGN KEY ("ingredient_id") REFERENCES "ingredients_master"("ingredient_id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

