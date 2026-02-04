"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Camera, User, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import type { EnvStressUiModelV1 } from "@/types";

type SkinHealthStatus = "good" | "attention";

type Metric = {
  label: string;
  value: number; // 0-100
  description?: string;
};

export type SkinIdentityCardProps = {
  className?: string;
  name?: string;
  avatarUrl?: string | null;
  status: SkinHealthStatus;
  resilienceScore: number; // 0-100
  hydration: number; // 0-100
  sebum: number; // 0-100
  sensitivity: number; // 0-100
  concerns: string[];
  onConcernsChange?: (next: string[]) => void;
  onConfirmProfile?: () => void;
  onUploadSelfie?: () => void;
  envStress?: EnvStressUiModelV1 | null;
  envStressLoading?: boolean;
  envStressError?: string | null;
};

const SkinIdentityRadar = dynamic(() => import("./SkinIdentityRadar").then((m) => m.SkinIdentityRadar), {
  ssr: false,
  loading: () => <div className="h-44 w-full rounded-xl border border-slate-200 bg-slate-50" />,
});

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function statusBorderClass(status: SkinHealthStatus) {
  if (status === "good") return "border-emerald-500";
  return "border-amber-500";
}

function statusPill(status: SkinHealthStatus) {
  if (status === "good") return { label: "Good", className: "bg-emerald-50 text-emerald-800 ring-emerald-200" };
  return { label: "Attention", className: "bg-amber-50 text-amber-900 ring-amber-200" };
}

function RadialProgress({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  const clamped = clampPercent(value);
  const size = 56;
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="relative h-14 w-14">
        <svg width={size} height={size} className="block">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            className="fill-none stroke-slate-200"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="fill-none stroke-slate-900"
            style={{ transition: "stroke-dashoffset 400ms ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-[13px] font-semibold tracking-tight text-slate-900">{clamped}</div>
          <div className="text-[9px] font-medium text-slate-500">/100</div>
        </div>
      </div>
      <div className="text-[10px] font-medium text-slate-500">{label}</div>
    </div>
  );
}

function MetricBar({
  metric,
  barClassName,
}: {
  metric: Metric;
  barClassName: string;
}) {
  const value = clampPercent(metric.value);
  const high = value > 80;

  return (
    <div className="rounded-xl border border-slate-200 bg-white/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-700">{metric.label}</div>
        <div className="text-[11px] font-medium text-slate-500">{value}%</div>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={cn("h-full rounded-full transition-colors", high ? "bg-amber-500" : barClassName)}
          style={{ width: `${value}%` }}
          aria-hidden
        />
      </div>
      {metric.description ? <div className="mt-1 text-[10px] text-slate-500">{metric.description}</div> : null}
    </div>
  );
}

export function SkinIdentityCard({
  className,
  name = "You",
  avatarUrl,
  status,
  resilienceScore,
  hydration,
  sebum,
  sensitivity,
  concerns,
  onConcernsChange,
  onConfirmProfile,
  onUploadSelfie,
  envStress,
  envStressLoading,
  envStressError,
}: SkinIdentityCardProps) {
  const [localConcerns, setLocalConcerns] = useState<string[]>(() => concerns);

  useEffect(() => {
    setLocalConcerns(concerns);
  }, [concerns]);

  const pill = useMemo(() => statusPill(status), [status]);

  const metrics: Metric[] = useMemo(
    () => [
      { label: "Hydration", value: hydration },
      { label: "Sebum", value: sebum },
      { label: "Sensitivity", value: sensitivity },
    ],
    [hydration, sebum, sensitivity],
  );

  const removeConcern = useCallback(
    (value: string) => {
      setLocalConcerns((prev) => {
        const next = prev.filter((c) => c !== value);
        onConcernsChange?.(next);
        return next;
      });
    },
    [onConcernsChange],
  );

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className={cn(
        "w-full max-w-sm rounded-2xl border border-slate-200 bg-white/90 backdrop-blur shadow-sm",
        "border-l-4",
        statusBorderClass(status),
        className,
      )}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="relative h-10 w-10 overflow-hidden rounded-full border border-slate-200 bg-slate-50">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt={name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-slate-500">
                  <User className="h-5 w-5" />
                </div>
              )}
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">Skin Identity</div>
              <div className="mt-0.5 flex items-center gap-2">
                <div className="text-xs text-slate-500">{name}</div>
                <div className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1", pill.className)}>
                  {pill.label}
                </div>
              </div>
            </div>
          </div>

          <RadialProgress value={resilienceScore} label="Resilience" />
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <MetricBar metric={metrics[0]} barClassName="bg-sky-500" />
          <MetricBar metric={metrics[1]} barClassName="bg-emerald-500" />
          <MetricBar metric={metrics[2]} barClassName="bg-rose-500" />
        </div>

        <div className="mt-3 rounded-xl border border-slate-200 bg-white/70 p-3">
          <div className="text-xs font-semibold text-slate-700">Vector Snapshot</div>
          <div className="mt-2">
            <SkinIdentityRadar hydration={hydration} sebum={sebum} sensitivity={sensitivity} resilienceScore={resilienceScore} />
          </div>
          <div className="mt-1 text-[10px] text-slate-500">Missing dimensions default to 0.</div>
        </div>

        <div className="mt-3 rounded-xl border border-slate-200 bg-white/70 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-700">Environment Stress</div>
              <div className="mt-0.5 text-[11px] text-slate-500">ESS + explainable radar (0..100)</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[11px] font-semibold text-slate-900">{envStress?.ess != null ? `${envStress.ess}` : "—"}</div>
              <div className="text-[10px] text-slate-500">{envStress?.tier ?? ""}</div>
            </div>
          </div>

          {envStressLoading ? (
            <div className="mt-2 h-44 w-full rounded-xl border border-slate-200 bg-slate-50" aria-label="Env stress loading" />
          ) : envStressError ? (
            <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800" aria-label="Env stress error">
              {envStressError}
            </div>
          ) : envStress ? (
            <>
              <div className="mt-2">
                {envStress.radar.length ? (
                  <SkinIdentityRadar radar={envStress.radar} ariaLabel="Environment stress radar chart" />
                ) : (
                  <div className="h-44 w-full rounded-xl border border-slate-200 bg-slate-50" aria-label="Env stress placeholder" />
                )}
              </div>
              {envStress.notes.length ? (
                <ul className="mt-2 list-disc pl-4 text-[11px] text-slate-600">
                  {envStress.notes.slice(0, 4).map((n, idx) => (
                    <li key={idx}>{n}</li>
                  ))}
                </ul>
              ) : (
                <div className="mt-2 text-[11px] text-slate-500">No notes returned.</div>
              )}
            </>
          ) : (
            <div className="mt-2 text-[11px] text-slate-500">Env stress not available yet.</div>
          )}
        </div>

        <div className="mt-4">
          <div className="text-xs font-semibold text-slate-700">Concerns</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <AnimatePresence initial={false}>
              {localConcerns.map((tag) => (
                <motion.div
                  key={tag}
                  layout
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="inline-flex"
                >
                  <button
                    type="button"
                    onClick={() => removeConcern(tag)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold text-slate-700",
                      "hover:bg-slate-100",
                      "focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-200",
                    )}
                    aria-label={`Remove ${tag}`}
                  >
                    <span>{tag}</span>
                    <X className="h-3 w-3 text-slate-500" />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          {!localConcerns.length ? <div className="mt-2 text-[11px] text-slate-500">No concerns added yet.</div> : null}
        </div>

        <div className="mt-5">
          <button
            type="button"
            onClick={onConfirmProfile}
            className={cn(
              "w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white",
              "bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900",
              "shadow-sm hover:shadow-md hover:brightness-110 transition",
              "focus:outline-none focus:ring-2 focus:ring-slate-300",
            )}
          >
            Confirm Profile
          </button>

          <button
            type="button"
            onClick={onUploadSelfie}
            className={cn(
              "mt-2 w-full rounded-xl border border-transparent bg-transparent px-4 py-2 text-sm font-semibold text-slate-600",
              "hover:bg-slate-50 hover:text-slate-900",
              "focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-200",
              "inline-flex items-center justify-center gap-2",
            )}
          >
            <Camera className="h-4 w-4" />
            Upload Selfie
          </button>
        </div>
      </div>
    </motion.section>
  );
}
