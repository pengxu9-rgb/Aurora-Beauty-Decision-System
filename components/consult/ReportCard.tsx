"use client";

import ReactMarkdown from "react-markdown";
import { Moon, ShieldAlert, Sun } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConsultWizardAnswers } from "@/components/consult/ConsultWizard";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function prettifySkinType(skin: ConsultWizardAnswers["skin_type"]) {
  switch (skin) {
    case "oily":
      return "Oily";
    case "dry":
      return "Dry";
    case "combo":
      return "Combination";
    case "sensitive":
      return "Sensitive";
    default:
      return skin;
  }
}

function prettifyBarrier(status: ConsultWizardAnswers["barrier_status"]) {
  return status === "strong" ? "Strong barrier" : "Impaired barrier";
}

function looksLikeWarning(text: string) {
  const t = text.toLowerCase();
  return (
    t.includes("warning") ||
    t.includes("caution") ||
    text.includes("严重警告") ||
    text.includes("警告") ||
    text.includes("不推荐") ||
    text.includes("慎用") ||
    text.includes("🚫")
  );
}

function extractWarningBlock(text: string) {
  // Grab the first 1-3 non-empty lines that look like a warning.
  const lines = text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);
  const idx = lines.findIndex((l) => looksLikeWarning(l));
  if (idx === -1) return null;
  return lines.slice(idx, idx + 3).join(" ");
}

type TimelineItem = { label: string; detail: string; priceUsd?: number; tier: "budget" | "splurge" | "neutral" };

function parsePriceUsd(line: string) {
  const m = line.match(/\$(\d+(?:\.\d+)?)/);
  if (!m?.[1]) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function splitRoutine(text: string) {
  const lines = text.split(/\r?\n/g);

  const normalize = (l: string) => l.replace(/\*\*/g, "").trim();
  const isAmHeader = (l: string) => /^(am|morning|早|晨)/i.test(normalize(l));
  const isPmHeader = (l: string) => /^(pm|night|晚|夜)/i.test(normalize(l));

  const amIdx = lines.findIndex((l) => isAmHeader(l));
  const pmIdx = lines.findIndex((l) => isPmHeader(l));

  const takeBullets = (slice: string[]) =>
    slice
      .map((l) => l.trim())
      .filter((l) => /^[-*•]\s+/.test(l) || /^\d+\.\s+/.test(l))
      .map((l) => l.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim())
      .filter(Boolean);

  const am = amIdx !== -1 ? takeBullets(lines.slice(amIdx + 1, pmIdx !== -1 ? pmIdx : undefined)) : [];
  const pm = pmIdx !== -1 ? takeBullets(lines.slice(pmIdx + 1)) : [];

  return { am, pm };
}

function toTimelineItems(lines: string[]): TimelineItem[] {
  return lines.map((line) => {
    const raw = line.trim();
    const parts = raw.split(/[:：]/);
    const label = parts.length >= 2 ? parts[0].trim() : "Step";
    const detail = parts.length >= 2 ? parts.slice(1).join(":").trim() : raw;

    const price = parsePriceUsd(raw);
    const tier = price != null ? (price <= 20 ? "budget" : price >= 35 ? "splurge" : "neutral") : "neutral";

    return { label, detail, priceUsd: price ?? undefined, tier };
  });
}

function ScoreRing({ score, label }: { score: number; label: string }) {
  const pct = clamp(score, 0, 100);
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const dash = (pct / 100) * circumference;
  const gap = circumference - dash;

  const tone =
    pct >= 80 ? "text-emerald-600" : pct >= 60 ? "text-indigo-600" : pct >= 40 ? "text-amber-600" : "text-rose-600";

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-20 w-20">
        <svg viewBox="0 0 40 40" className="h-20 w-20 -rotate-90">
          <circle cx="20" cy="20" r={radius} className="fill-none stroke-slate-100" strokeWidth="5" />
          <circle
            cx="20"
            cy="20"
            r={radius}
            className={cx("fill-none", tone)}
            stroke="currentColor"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${gap}`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-2xl font-semibold text-slate-900">{Math.round(pct)}</div>
          <div className="text-[10px] text-slate-500 -mt-0.5">/ 100</div>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-slate-500">{label}</div>
        <div className="text-base font-semibold text-slate-900">Your personalized routine</div>
      </div>
    </div>
  );
}

function Timeline({
  title,
  icon,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  items: TimelineItem[];
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-700">
            {icon}
          </div>
          <div className="text-sm font-semibold text-slate-900">{title}</div>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {items.length === 0 ? <div className="text-sm text-slate-500">No steps detected in the response.</div> : null}
        {items.map((it, idx) => (
          <div key={`${it.label}-${idx}`} className="flex items-start gap-3">
            <div className="mt-1 flex flex-col items-center">
              <div className="h-2.5 w-2.5 rounded-full bg-slate-900" />
              {idx < items.length - 1 ? <div className="h-10 w-px bg-slate-200" /> : null}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-900">{it.label}</div>
                <div className="flex items-center gap-2 shrink-0">
                  {it.priceUsd != null ? <div className="text-xs text-slate-500">${it.priceUsd}</div> : null}
                  {it.tier !== "neutral" ? (
                    <span
                      className={cx(
                        "rounded-full px-2 py-1 text-[11px] font-semibold border",
                        it.tier === "budget"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-indigo-200 bg-indigo-50 text-indigo-700",
                      )}
                    >
                      {it.tier === "budget" ? "Budget pick" : "Splurge pick"}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="mt-1 text-sm text-slate-600 break-words">{it.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReportCard({
  profile,
  answer,
  isStreaming,
  onRestart,
}: {
  profile: ConsultWizardAnswers;
  answer: string;
  isStreaming: boolean;
  onRestart?: () => void;
}) {
  const warning = useMemo(() => extractWarningBlock(answer), [answer]);
  const { am, pm } = useMemo(() => splitRoutine(answer), [answer]);
  const amItems = useMemo(() => toTimelineItems(am), [am]);
  const pmItems = useMemo(() => toTimelineItems(pm), [pm]);

  const computedScore = useMemo(() => {
    let score = profile.barrier_status === "strong" ? 88 : 62;
    if (profile.skin_type === "sensitive") score -= 10;
    if (warning) score -= 12;
    return clamp(score, 0, 100);
  }, [profile.barrier_status, profile.skin_type, warning]);

  const [copied, setCopied] = useState(false);

  return (
    <div className="pb-20">
      <div className="rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/40 overflow-hidden">
        <div className="p-6">
          <ScoreRing score={computedScore} label="Safety / match score" />

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
              {prettifySkinType(profile.skin_type)} skin
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
              ¥{profile.monthly_budget_cny} / month
            </span>
            <span
              className={cx(
                "rounded-full border px-3 py-1 text-xs font-semibold",
                profile.barrier_status === "strong"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-rose-200 bg-rose-50 text-rose-700",
              )}
            >
              {prettifyBarrier(profile.barrier_status)}
            </span>
            {isStreaming ? (
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                Streaming…
              </span>
            ) : null}
          </div>

          {warning ? (
            <div
              className={cx(
                "mt-5 rounded-2xl border px-4 py-3 flex gap-3 items-start",
                "border-rose-200 bg-rose-50 text-rose-800",
              )}
            >
              <div className="mt-0.5 h-8 w-8 rounded-xl bg-white/70 border border-rose-200 flex items-center justify-center">
                <ShieldAlert className="h-4 w-4 text-rose-700" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold">Safety note</div>
                <div className="mt-1 text-sm leading-relaxed break-words">{warning}</div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="px-6 pb-6 space-y-4">
          <Timeline title="Morning" icon={<Sun className="h-4 w-4" />} items={amItems} />
          <Timeline title="Night" icon={<Moon className="h-4 w-4" />} items={pmItems} />

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-slate-900">Why it works</div>
              {onRestart ? (
                <button
                  type="button"
                  onClick={onRestart}
                  className="text-xs font-semibold text-slate-600 hover:text-slate-900"
                >
                  Start over
                </button>
              ) : null}
            </div>

            <div className="mt-3 prose prose-sm max-w-none prose-slate">
              <ReactMarkdown>{answer}</ReactMarkdown>
            </div>
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 border-t border-slate-200 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/70">
        <div className="mx-auto w-full max-w-sm px-4 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(answer);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              } catch {
                setCopied(false);
              }
            }}
            className={cx(
              "flex-1 rounded-full px-4 py-2 text-sm font-semibold border transition",
              copied ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-900 hover:bg-slate-50",
            )}
          >
            {copied ? "Saved" : "Save routine"}
          </button>
          <button
            type="button"
            className="flex-1 rounded-full px-4 py-2 text-sm font-semibold bg-slate-900 text-white hover:bg-slate-800 transition"
          >
            Shop all
          </button>
        </div>
      </div>
    </div>
  );
}

