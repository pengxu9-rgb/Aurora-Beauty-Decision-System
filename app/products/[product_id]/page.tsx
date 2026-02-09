import { ProductIngredientsPage } from "@/components/products/ProductIngredientsPage";

export default function ProductIngredientsRoutePage({ params }: { params: { product_id: string } }) {
  const productId = decodeURIComponent(String(params?.product_id ?? "").trim());
  return <ProductIngredientsPage productId={productId} />;
}
