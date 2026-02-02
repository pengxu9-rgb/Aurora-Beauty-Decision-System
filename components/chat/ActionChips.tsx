"use client";

import { cn } from "@/lib/cn";

export type ActionChip = {
  id: string;
  label: string;
  kind?: "quick_reply" | "action";
  text?: string;
  data?: Record<string, unknown>;
};

export function ActionChips({
  title,
  actions,
  onSelect,
}: {
  title?: string;
  actions: ActionChip[];
  onSelect: (action: ActionChip) => void;
}) {
  if (!actions.length) return null;

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Next actions">
      <div className="text-xs font-semibold text-slate-900">{title ?? "Quick actions (tap to continue)"}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelect(a)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
              "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100",
              "focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-200",
            )}
            aria-label={a.label}
          >
            {a.label}
          </button>
        ))}
      </div>
    </section>
  );
}
