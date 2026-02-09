"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

import { inferSourceHintFromProductRef } from "@/lib/product-ref-hints";

export default function ProductLookupPage() {
  const router = useRouter();
  const [productRef, setProductRef] = useState("");
  const [sourceSystem, setSourceSystem] = useState("");
  const [sourceType, setSourceType] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = productRef.trim();
    if (!value) return;
    const inferred = inferSourceHintFromProductRef(value);
    const finalSourceSystem = sourceSystem.trim() || inferred?.sourceSystem || "";
    const finalSourceType = sourceType.trim() || inferred?.sourceType || "";
    const query = new URLSearchParams();
    if (finalSourceSystem) query.set("source_system", finalSourceSystem);
    if (finalSourceType) query.set("source_type", finalSourceType);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    router.push(`/products/${encodeURIComponent(value)}${suffix}`);
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white px-4 py-10">
      <div className="mx-auto w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">Aurora Product Ingredient Viewer</h1>
        <p className="mt-2 text-sm text-slate-600">
          Enter Aurora `product_id` or external reference (`ext_*`, `eps_*`, URL) to open ingredient details.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-3">
          <input
            value={productRef}
            onChange={(e) => setProductRef(e.target.value)}
            placeholder="e.g. 8d19536a-f675-4be6-a33f-faa89fdf85c2 / ext_xxx / https://..."
            className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none ring-indigo-200 focus:ring"
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <input
              value={sourceSystem}
              onChange={(e) => setSourceSystem(e.target.value)}
              placeholder="source_system (optional)"
              className="rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none ring-indigo-200 focus:ring"
            />
            <input
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
              placeholder="source_type (optional)"
              className="rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none ring-indigo-200 focus:ring"
            />
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              <Search className="h-4 w-4" />
              Open
            </button>
          </div>
        </form>
        <p className="mt-3 text-xs text-slate-500">
          Defaults: `ext_*` → `pivota/external_product_id`, `eps_*` → `pivota/external_seed_id`, URL → `merchant/canonical_url`, hex id → `harvester/candidate_id`.
        </p>
      </div>
    </main>
  );
}
