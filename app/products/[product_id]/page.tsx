import { ProductIngredientsPage } from "@/components/products/ProductIngredientsPage";

export default function ProductIngredientsRoutePage({
  params,
  searchParams,
}: {
  params: { product_id: string };
  searchParams?: { source_system?: string; source_type?: string };
}) {
  const productId = decodeURIComponent(String(params?.product_id ?? "").trim());
  const sourceSystem = typeof searchParams?.source_system === "string" ? searchParams.source_system : undefined;
  const sourceType = typeof searchParams?.source_type === "string" ? searchParams.source_type : undefined;
  return <ProductIngredientsPage productId={productId} sourceSystem={sourceSystem} sourceType={sourceType} />;
}
