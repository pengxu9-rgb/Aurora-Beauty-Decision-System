-- CreateTable
CREATE TABLE "product_aliases" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "alias_normalized" TEXT NOT NULL,
    "kind" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "locale" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_aliases_product_id_idx" ON "product_aliases"("product_id");
CREATE INDEX "product_aliases_alias_normalized_idx" ON "product_aliases"("alias_normalized");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "product_aliases_product_alias_norm_uidx" ON "product_aliases"("product_id", "alias_normalized");

-- AddForeignKey
ALTER TABLE "product_aliases"
ADD CONSTRAINT "product_aliases_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

