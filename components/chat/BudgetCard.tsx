"use client";

import { cn } from "@/lib/cn";

type BudgetTier = "Low" | "Mid" | "High";

export type BudgetContext = {
  tier: BudgetTier | null;
  tier_cap_usd: number | null;
  threshold_multiplier?: number | null;
  current_routine_cost_usd_known?: number | null;
  current_routine_cost_usd?: number | null;
  current_routine_cost_unknown_count?: number | null;
  estimated_savings_usd_if_strict_budget?: number | null;
  over_tier_threshold?: boolean | null;
  trigger_budget_optimization_protocol?: boolean | null;
  suggested_swap?: {
    step: string;
    from: { brand: string; name: string; price_usd: number | null };
    to: { brand: string; name: string; price_usd: number | null };
    estimated_savings_usd: number | null;
  } | null;
};

function fmtUsd(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  return `$${n.toFixed(0)}`;
}

export function BudgetCard({
  budgetCny,
  budgetUsdEst,
  budget,
  className,
}: {
  budgetCny: number | null;
  budgetUsdEst: number | null;
  budget: BudgetContext | null;
  className?: string;
}) {
  if (!budget && budgetCny == null && budgetUsdEst == null) return null;

  const over = budget?.over_tier_threshold === true || budget?.trigger_budget_optimization_protocol === true;
  const unknown = (budget?.current_routine_cost_unknown_count ?? 0) > 0;

  return (
    <section
      className={cn("mt-4 rounded-2xl border bg-white p-4 shadow-sm", over ? "border-amber-200" : "border-slate-200", className)}
      aria-label="Budget"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-slate-900">Budget</div>
          <div className="mt-1 text-xs text-slate-600">
            {budgetCny != null ? `¥${budgetCny}` : "—"}
            {budgetUsdEst != null ? ` (≈${fmtUsd(budgetUsdEst)})` : ""}
            {budget?.tier ? ` · ${budget.tier}` : ""}
          </div>
        </div>
        {over ? (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
            Over range
          </span>
        ) : (
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
            OK
          </span>
        )}
      </div>

      {budget ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[11px] font-semibold text-slate-700">Known total</div>
            <div className="mt-1 text-sm font-semibold text-slate-900">{fmtUsd(budget.current_routine_cost_usd_known ?? null)}</div>
            <div className="mt-0.5 text-[11px] text-slate-500">{unknown ? "Prices missing" : "Complete"}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[11px] font-semibold text-slate-700">Tier cap</div>
            <div className="mt-1 text-sm font-semibold text-slate-900">{fmtUsd(budget.tier_cap_usd ?? null)}</div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              ×{budget.threshold_multiplier ?? 1.2} trigger
            </div>
          </div>
        </div>
      ) : null}

      {budget?.suggested_swap ? (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
          <div className="text-[11px] font-semibold text-slate-900">Suggested swap (wash-off step)</div>
          <div className="mt-1 text-xs text-slate-700">
            {budget.suggested_swap.step}: {budget.suggested_swap.from.brand} {budget.suggested_swap.from.name} →{" "}
            {budget.suggested_swap.to.brand} {budget.suggested_swap.to.name}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">Save ≈ {fmtUsd(budget.suggested_swap.estimated_savings_usd)}</div>
        </div>
      ) : null}
    </section>
  );
}

