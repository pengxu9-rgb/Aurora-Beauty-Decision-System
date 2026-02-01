"use client";

import { cn } from "@/lib/cn";
import { Moon, Sun } from "lucide-react";

type RoutineSku = {
  sku_id: string;
  brand: string;
  name: string;
  category: string;
  price: number;
  currency?: string;
};

type RoutineStep = {
  step: string;
  sku: RoutineSku;
  notes?: string[];
  evidence_pack?: { citations?: string[] };
};

export type RoutineRec = {
  am: RoutineStep[];
  pm: RoutineStep[];
  total_usd?: number;
  total_cny?: number;
};

function priceLabel(price: number) {
  if (!Number.isFinite(price) || price <= 0) return "价格未知";
  return `$${price.toFixed(0)}`;
}

function StepRow({ icon, item }: { icon: React.ReactNode; item: RoutineStep }) {
  const cite = item.evidence_pack?.citations?.[0] ?? null;
  return (
    <div className="flex gap-3">
      <div className="shrink-0 pt-0.5">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold tracking-wide text-slate-500">{item.step}</div>
            <div className="mt-0.5 text-sm font-semibold text-slate-900 truncate">
              {item.sku.brand} {item.sku.name}
            </div>
          </div>
          <div className="shrink-0 text-xs font-semibold text-slate-700">{priceLabel(item.sku.price)}</div>
        </div>
        {Array.isArray(item.notes) && item.notes.length ? (
          <ul className="mt-1 list-disc pl-4 text-[11px] text-slate-600">
            {item.notes.slice(0, 3).map((n, idx) => (
              <li key={idx}>{n}</li>
            ))}
          </ul>
        ) : null}
        {cite ? <div className="mt-1 text-[11px] text-slate-400">{cite}</div> : null}
      </div>
    </div>
  );
}

export function RoutineTimeline({
  title,
  routine,
  className,
}: {
  title?: string;
  routine: RoutineRec | null;
  className?: string;
}) {
  if (!routine) return null;

  return (
    <section className={cn("mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm", className)} aria-label="Routine">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-slate-900">{title ?? "Routine"}</div>
          <div className="mt-1 text-xs text-slate-500">AM/PM timeline (evidence-first)</div>
        </div>
        <div className="text-[11px] text-slate-500">
          {routine.total_cny ? `¥${routine.total_cny}` : ""}
          {routine.total_usd ? ` · $${routine.total_usd}` : ""}
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-900">
            <Sun className="h-4 w-4 text-amber-500" /> AM
          </div>
          <div className="space-y-3">
            {routine.am.map((s) => (
              <StepRow
                key={`${s.step}:${s.sku.sku_id}`}
                icon={<span className="mt-1 h-2 w-2 rounded-full bg-indigo-600" aria-hidden />}
                item={s}
              />
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-900">
            <Moon className="h-4 w-4 text-indigo-600" /> PM
          </div>
          <div className="space-y-3">
            {routine.pm.map((s) => (
              <StepRow
                key={`${s.step}:${s.sku.sku_id}`}
                icon={<span className="mt-1 h-2 w-2 rounded-full bg-indigo-600" aria-hidden />}
                item={s}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

