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

export type ConflictDetectorOutputV1 = {
  schema_version: "aurora.conflicts.v1";
  safe: boolean;
  conflicts: Array<{
    severity: "warn" | "block";
    rule_id?: string;
    message: string;
    step_index?: number;
  }>;
  summary: string;
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
  conflictDetector,
  className,
}: {
  title?: string;
  routine: RoutineRec | null;
  conflictDetector?: ConflictDetectorOutputV1 | null;
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

      {conflictDetector ? (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3" aria-label="Routine conflicts">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-900">Compatibility</div>
              <div className="mt-1 text-[11px] text-slate-600">{conflictDetector.summary}</div>
            </div>
            <div className="shrink-0">
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1",
                  conflictDetector.safe ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-amber-50 text-amber-900 ring-amber-200",
                )}
              >
                {conflictDetector.safe ? "Safe" : "Needs attention"}
              </span>
            </div>
          </div>

          {conflictDetector.conflicts.length ? (
            <ul className="mt-2 space-y-2">
              {conflictDetector.conflicts.slice(0, 6).map((c, idx) => (
                <li key={`${c.rule_id ?? "conflict"}_${idx}`} className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-0.5 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1",
                      c.severity === "block"
                        ? "bg-rose-50 text-rose-800 ring-rose-200"
                        : "bg-amber-50 text-amber-900 ring-amber-200",
                    )}
                    title={c.rule_id ? `rule: ${c.rule_id}` : undefined}
                  >
                    {c.severity}
                  </span>
                  <div className="text-[11px] text-slate-700">{c.message}</div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-2 text-[11px] text-slate-500">No conflicts detected.</div>
          )}

          <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500" aria-label="Heatmap placeholder">
            Heatmap (TODO): contract placeholder only — hidden/disabled until `aurora.ui.conflict_heatmap.v1` is defined.
          </div>
        </div>
      ) : null}

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
