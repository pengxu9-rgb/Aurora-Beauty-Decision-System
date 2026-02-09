"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

export default function ProductLookupPage() {
  const router = useRouter();
  const [productId, setProductId] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = productId.trim();
    if (!value) return;
    router.push(`/products/${encodeURIComponent(value)}`);
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white px-4 py-10">
      <div className="mx-auto w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">Aurora Product Ingredient Viewer</h1>
        <p className="mt-2 text-sm text-slate-600">
          Enter a `product_id` to open the ingredient detail page (raw ingredient + ordered INCI list).
        </p>

        <form onSubmit={onSubmit} className="mt-6 flex gap-3">
          <input
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            placeholder="e.g. 8d19536a-f675-4be6-a33f-faa89fdf85c2"
            className="flex-1 rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none ring-indigo-200 focus:ring"
          />
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            <Search className="h-4 w-4" />
            Open
          </button>
        </form>
      </div>
    </main>
  );
}
