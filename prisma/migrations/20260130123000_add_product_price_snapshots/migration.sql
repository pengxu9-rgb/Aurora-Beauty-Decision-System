-- CreateTable
CREATE TABLE "product_price_snapshots" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "region" TEXT,
    "currency" TEXT,
    "price_usd" DECIMAL(10,2),
    "price_cny" DECIMAL(10,2),
    "source" TEXT NOT NULL,
    "source_url" TEXT,
    "confidence" DOUBLE PRECISION,
    "metadata" JSONB,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_price_snapshots_product_id_idx" ON "product_price_snapshots"("product_id");
CREATE INDEX "product_price_snapshots_region_idx" ON "product_price_snapshots"("region");
CREATE INDEX "product_price_snapshots_captured_at_idx" ON "product_price_snapshots"("captured_at");
CREATE INDEX "product_price_snapshots_product_region_captured_at_idx" ON "product_price_snapshots"("product_id", "region", "captured_at");

-- AddForeignKey
ALTER TABLE "product_price_snapshots"
ADD CONSTRAINT "product_price_snapshots_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

