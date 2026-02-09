-- Create product crosswalk table to map external system references to Aurora product IDs.
CREATE TABLE IF NOT EXISTS "product_crosswalks" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "source_system" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "external_ref_normalized" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 100,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_crosswalks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "product_crosswalks_product_id_idx" ON "product_crosswalks"("product_id");
CREATE INDEX IF NOT EXISTS "product_crosswalks_external_ref_normalized_idx" ON "product_crosswalks"("external_ref_normalized");
CREATE UNIQUE INDEX IF NOT EXISTS "product_crosswalks_source_type_ref_norm_uidx"
  ON "product_crosswalks"("source_system", "source_type", "external_ref_normalized");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_crosswalks_product_id_fkey') THEN
    ALTER TABLE "product_crosswalks"
      ADD CONSTRAINT "product_crosswalks_product_id_fkey"
      FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
