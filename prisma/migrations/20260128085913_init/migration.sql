-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_usd" DECIMAL(10,2) NOT NULL,
    "price_cny" DECIMAL(10,2) NOT NULL,
    "product_url" TEXT,
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_vectors" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "mechanism" JSONB NOT NULL,
    "experience" JSONB NOT NULL,
    "risk_flags" TEXT[],
    "embedding" vector(1536),

    CONSTRAINT "sku_vectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredients" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "full_list" TEXT[],
    "hero_actives" JSONB NOT NULL,

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_stats" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "red_score" INTEGER NOT NULL DEFAULT 0,
    "reddit_score" INTEGER NOT NULL DEFAULT 0,
    "burn_rate" DECIMAL(65,30) NOT NULL DEFAULT 0.0,
    "top_keywords" TEXT[],
    "last_updated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_brand_idx" ON "products"("brand");

-- CreateIndex
CREATE INDEX "products_name_idx" ON "products"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sku_vectors_product_id_key" ON "sku_vectors"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ingredients_product_id_key" ON "ingredients"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_stats_product_id_key" ON "social_stats"("product_id");

-- AddForeignKey
ALTER TABLE "sku_vectors" ADD CONSTRAINT "sku_vectors_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_stats" ADD CONSTRAINT "social_stats_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
