import { AURORA_SKU_DB } from "@/data/mock-db";
import type { SkuVector } from "@/types";

export function getSkuById(skuId: string): SkuVector | null {
  return AURORA_SKU_DB.find((s) => s.sku_id === skuId) ?? null;
}

export function getSkuDatabase(): SkuVector[] {
  return AURORA_SKU_DB;
}

