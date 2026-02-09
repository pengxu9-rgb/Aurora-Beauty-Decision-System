"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Beaker, CircleCheckBig, ExternalLink, FlaskConical, Loader2 } from "lucide-react";

import { inferSourceHintFromProductRef } from "@/lib/product-ref-hints";

type ProductIngredientsResponseV1 = {
  ok: boolean;
  schema_version: "aurora.product_ingredients.v1";
  product_id: string;
  resolved?: {
    product_ref: string;
    product_id: string;
    matched_by: "product_id" | "crosswalk" | "alias";
    source_system: string | null;
    source_type: string | null;
    matched_ref: string | null;
    confidence: number | null;
  };
  product: {
    brand: string;
    name: string;
    region_availability: string[];
  };
  ingredients: {
    full_list: string[];
    hero_actives: unknown;
    count: number;
  };
  raw_ingredient: {
    text: string | null;
    source_sheet: string | null;
    source_ref: string | null;
    updated_at: string | null;
  };
  raw_ingredient_candidates: Array<{
    source_sheet: string;
    source_ref: string | null;
    content: string;
    updated_at: string;
  }>;
};

function normalizeHeroActives(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const name = (item as { name?: unknown }).name;
          return typeof name === "string" ? name.trim() : "";
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof value === "string") return [value.trim()].filter(Boolean);
  return [];
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function ProductIngredientsPage({
  productId,
  sourceSystem,
  sourceType,
}: {
  productId: string;
  sourceSystem?: string;
  sourceType?: string;
}) {
  const [data, setData] = useState<ProductIngredientsResponseV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inferred = useMemo(() => inferSourceHintFromProductRef(productId), [productId]);
  const effectiveSourceSystem = sourceSystem?.trim() || inferred?.sourceSystem || "";
  const effectiveSourceType = sourceType?.trim() || inferred?.sourceType || "";

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const query = new URLSearchParams();
        if (effectiveSourceSystem) query.set("source_system", effectiveSourceSystem);
        if (effectiveSourceType) query.set("source_type", effectiveSourceType);
        const suffix = query.toString() ? `?${query.toString()}` : "";
        const res = await fetch(`/v1/kb/products/${encodeURIComponent(productId)}/ingredients${suffix}`, {
          method: "GET",
          cache: "no-store",
        });
        const json = (await res.json()) as ProductIngredientsResponseV1 | { ok: false; error?: string };
        if (!res.ok || !("ok" in json) || !json.ok) {
          const msg = "error" in json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
          throw new Error(msg);
        }
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load product ingredients");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [productId, effectiveSourceSystem, effectiveSourceType]);

  const heroActives = useMemo(() => normalizeHeroActives(data?.ingredients?.hero_actives), [data?.ingredients?.hero_actives]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white px-4 py-8">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Aurora Product Ingredients</p>
              <h1 className="mt-1 text-2xl font-bold text-slate-900">
                {data ? `${data.product.brand} ${data.product.name}` : "Loading product..."}
              </h1>
              <p className="mt-2 font-mono text-xs text-slate-500">request_ref: {productId}</p>
              {data?.resolved ? (
                <p className="mt-1 font-mono text-xs text-slate-500">
                  resolved_product_id: {data.resolved.product_id} ({data.resolved.matched_by})
                </p>
              ) : data?.product_id ? (
                <p className="mt-1 font-mono text-xs text-slate-500">product_id: {data.product_id}</p>
              ) : null}
            </div>
            {loading ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading
              </span>
            ) : error ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-rose-50 px-3 py-1 text-sm text-rose-700">
                <AlertCircle className="h-4 w-4" />
                Error
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-sm text-emerald-700">
                <CircleCheckBig className="h-4 w-4" />
                Ready
              </span>
            )}
          </div>
        </header>

        {error ? (
          <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-rose-800">
            <p className="font-semibold">Failed to load product details</p>
            <p className="mt-1 text-sm">{error}</p>
          </section>
        ) : null}

        {data ? (
          <>
            <section className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs uppercase text-slate-500">Ingredients Count</p>
                <p className="mt-2 text-2xl font-bold text-slate-900">{data.ingredients.count}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs uppercase text-slate-500">Hero Actives</p>
                <p className="mt-2 text-2xl font-bold text-slate-900">{heroActives.length}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs uppercase text-slate-500">Regions</p>
                <p className="mt-2 text-base font-semibold text-slate-900">
                  {data.product.region_availability.length ? data.product.region_availability.join(", ") : "N/A"}
                </p>
              </div>
            </section>

            {data.resolved ? (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs uppercase text-slate-500">Resolution</p>
                <p className="mt-2 text-sm text-slate-700">
                  matched_by=<span className="font-semibold text-slate-900">{data.resolved.matched_by}</span>
                  {" · "}source_system=
                  <span className="font-semibold text-slate-900">{data.resolved.source_system || "N/A"}</span>
                  {" · "}source_type=
                  <span className="font-semibold text-slate-900">{data.resolved.source_type || "N/A"}</span>
                  {" · "}confidence=
                  <span className="font-semibold text-slate-900">{data.resolved.confidence ?? "N/A"}</span>
                </p>
              </section>
            ) : null}

            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-2">
                <Beaker className="h-5 w-5 text-slate-700" />
                <h2 className="text-lg font-semibold text-slate-900">Raw Ingredient Text</h2>
              </div>
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{data.raw_ingredient.text || "N/A"}</p>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-slate-600">
                <span>
                  Source: <span className="font-medium text-slate-800">{data.raw_ingredient.source_sheet || "N/A"}</span>
                </span>
                <span>Updated: {formatUpdatedAt(data.raw_ingredient.updated_at)}</span>
                {data.raw_ingredient.source_ref ? (
                  <a
                    href={data.raw_ingredient.source_ref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-indigo-700 hover:underline"
                  >
                    View Source
                    <ExternalLink className="h-4 w-4" />
                  </a>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-2">
                <FlaskConical className="h-5 w-5 text-slate-700" />
                <h2 className="text-lg font-semibold text-slate-900">INCI Full List (Ordered)</h2>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {data.ingredients.full_list.map((item, idx) => (
                  <span key={`${idx}_${item}`} className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-sm text-slate-700">
                    {idx + 1}. {item}
                  </span>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <details>
                <summary className="cursor-pointer text-base font-semibold text-slate-900">
                  Other Raw Candidates ({data.raw_ingredient_candidates.length})
                </summary>
                <div className="mt-4 space-y-4">
                  {data.raw_ingredient_candidates.map((item, idx) => (
                    <article key={`${item.source_sheet}_${idx}`} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">
                        <span>
                          Source: <span className="font-medium text-slate-800">{item.source_sheet}</span>
                        </span>
                        <span>Updated: {formatUpdatedAt(item.updated_at)}</span>
                        {item.source_ref ? (
                          <a href={item.source_ref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-700 hover:underline">
                            Open
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        ) : null}
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{item.content}</p>
                    </article>
                  ))}
                </div>
              </details>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
