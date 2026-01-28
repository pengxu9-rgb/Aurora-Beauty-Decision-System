"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, Sparkles } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

type StepId = 0 | 1 | 2 | 3 | 4;

export type ConsultSkinType = "oily" | "dry" | "combo" | "sensitive";
export type ConsultConcern = "acne" | "aging" | "dark_spots" | "redness";
export type ConsultBudgetCny = 200 | 500 | 1000;
export type ConsultBarrierStatus = "strong" | "stinging_red";

export type ConsultWizardAnswers = {
  skin_type: ConsultSkinType;
  concerns: ConsultConcern[];
  monthly_budget_cny: ConsultBudgetCny;
  barrier_status: ConsultBarrierStatus;
};

const SKIN_TYPE_OPTIONS: Array<{ value: ConsultSkinType; label: string; helper: string }> = [
  { value: "oily", label: "Oily", helper: "Shiny / clogged pores" },
  { value: "dry", label: "Dry", helper: "Tight / flaky" },
  { value: "combo", label: "Combo", helper: "Oily T-zone" },
  { value: "sensitive", label: "Sensitive", helper: "Easily irritated" },
];

const CONCERN_OPTIONS: Array<{ value: ConsultConcern; label: string }> = [
  { value: "acne", label: "Acne" },
  { value: "aging", label: "Aging" },
  { value: "dark_spots", label: "Dark Spots" },
  { value: "redness", label: "Redness" },
];

const BUDGET_OPTIONS: Array<{ value: ConsultBudgetCny; label: string; helper: string }> = [
  { value: 200, label: "¥200", helper: "Essentials" },
  { value: 500, label: "¥500", helper: "Balanced" },
  { value: 1000, label: "¥1000+", helper: "Premium" },
];

const BARRIER_OPTIONS: Array<{ value: ConsultBarrierStatus; label: string; helper: string }> = [
  { value: "strong", label: "💪 Strong", helper: "Comfortable, stable" },
  { value: "stinging_red", label: "🔴 Stinging/Red", helper: "Burning, redness" },
];

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }).map((_, idx) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={idx}
          className={cx(
            "h-1.5 rounded-full transition-all",
            idx === current ? "w-6 bg-slate-900" : idx < current ? "w-2 bg-slate-400" : "w-2 bg-slate-200",
          )}
        />
      ))}
    </div>
  );
}

function OptionCard({
  selected,
  title,
  subtitle,
  onClick,
}: {
  selected: boolean;
  title: string;
  subtitle?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "w-full rounded-2xl border px-4 py-4 text-left transition shadow-sm active:scale-[0.99]",
        selected ? "border-indigo-300 bg-indigo-50 shadow-indigo-100" : "border-slate-200 bg-white hover:bg-slate-50",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          {subtitle ? <div className="mt-1 text-xs text-slate-500">{subtitle}</div> : null}
        </div>
        <div
          className={cx(
            "mt-0.5 h-5 w-5 rounded-full border flex items-center justify-center",
            selected ? "border-indigo-500 bg-indigo-500" : "border-slate-300 bg-white",
          )}
          aria-hidden="true"
        >
          <div className={cx("h-2 w-2 rounded-full", selected ? "bg-white" : "bg-transparent")} />
        </div>
      </div>
    </button>
  );
}

function Chip({
  selected,
  label,
  disabled,
  onClick,
}: {
  selected: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "rounded-full border px-3 py-2 text-sm transition active:scale-[0.99]",
        selected ? "border-indigo-300 bg-indigo-50 text-indigo-900" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
        disabled ? "opacity-40 cursor-not-allowed" : "",
      )}
    >
      {label}
    </button>
  );
}

export function ConsultWizard({ onComplete }: { onComplete?: (answers: ConsultWizardAnswers) => void }) {
  const [step, setStep] = useState<StepId>(0);
  const [direction, setDirection] = useState<1 | -1>(1);

  const [skinType, setSkinType] = useState<ConsultSkinType | null>(null);
  const [concerns, setConcerns] = useState<ConsultConcern[]>([]);
  const [budget, setBudget] = useState<ConsultBudgetCny | null>(null);
  const [barrier, setBarrier] = useState<ConsultBarrierStatus | null>(null);

  const totalSteps = 4;
  const currentIndex = Math.min(step, 3);

  const canContinue = useMemo(() => {
    switch (step) {
      case 0:
        return Boolean(skinType);
      case 1:
        return concerns.length === 2;
      case 2:
        return Boolean(budget);
      case 3:
        return Boolean(barrier);
      default:
        return false;
    }
  }, [barrier, budget, concerns.length, skinType, step]);

  const answers = useMemo<ConsultWizardAnswers | null>(() => {
    if (!skinType || !budget || !barrier || concerns.length !== 2) return null;
    return {
      skin_type: skinType,
      concerns,
      monthly_budget_cny: budget,
      barrier_status: barrier,
    };
  }, [barrier, budget, concerns, skinType]);

  const go = useCallback(
    (next: StepId) => {
      setDirection(next > step ? 1 : -1);
      setStep(next);
    },
    [step],
  );

  const goNext = useCallback(() => {
    if (!canContinue) return;
    if (step === 3) {
      if (answers) onComplete?.(answers);
      go(4);
      return;
    }
    go((step + 1) as StepId);
  }, [answers, canContinue, go, onComplete, step]);

  const goBack = useCallback(() => {
    if (step <= 0) return;
    go((step - 1) as StepId);
  }, [go, step]);

  const panelVariants = useMemo(
    () => ({
      enter: (dir: number) => ({ x: dir > 0 ? 28 : -28, opacity: 0 }),
      center: { x: 0, opacity: 1 },
      exit: (dir: number) => ({ x: dir > 0 ? -28 : 28, opacity: 0 }),
    }),
    [],
  );

  const header = (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white flex items-center justify-center shadow-sm">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-900">Aurora Consult</div>
          <div className="text-xs text-slate-500">Aesthetician-style routine</div>
        </div>
      </div>
      <ProgressDots current={currentIndex} total={totalSteps} />
    </div>
  );

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/40 overflow-hidden">
      <div className="p-5">{header}</div>

      <div className="px-5 pb-6">
        <div className="relative min-h-[360px]">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              variants={panelVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.24, ease: "easeOut" }}
              className="absolute inset-0"
            >
              {step === 0 ? (
                <div className="h-full flex flex-col">
                  <div className="mt-2 space-y-1">
                    <div className="text-xs font-medium text-slate-500">Step 1</div>
                    <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                      What&apos;s your skin type?
                    </h1>
                    <p className="text-sm text-slate-600">Choose the closest match for how your skin feels today.</p>
                  </div>

                  <div className="mt-6 grid grid-cols-2 gap-3">
                    {SKIN_TYPE_OPTIONS.map((opt) => (
                      <OptionCard
                        key={opt.value}
                        selected={skinType === opt.value}
                        title={opt.label}
                        subtitle={opt.helper}
                        onClick={() => {
                          setSkinType(opt.value);
                          window.setTimeout(() => go(1), 220);
                        }}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {step === 1 ? (
                <div className="h-full flex flex-col">
                  <div className="mt-2 space-y-1">
                    <div className="text-xs font-medium text-slate-500">Step 2</div>
                    <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Top 2 concerns?</h1>
                    <p className="text-sm text-slate-600">
                      Pick <span className="font-semibold">two</span> so I can focus your routine.
                    </p>
                  </div>

                  <div className="mt-6 flex flex-wrap gap-2">
                    {CONCERN_OPTIONS.map((opt) => {
                      const selected = concerns.includes(opt.value);
                      const maxed = !selected && concerns.length >= 2;
                      return (
                        <Chip
                          key={opt.value}
                          selected={selected}
                          label={opt.label}
                          disabled={maxed}
                          onClick={() => {
                            setConcerns((prev) => {
                              const next = prev.includes(opt.value)
                                ? prev.filter((v) => v !== opt.value)
                                : [...prev, opt.value].slice(0, 2);
                              if (next.length === 2) window.setTimeout(() => go(2), 220);
                              return next;
                            });
                          }}
                        />
                      );
                    })}
                  </div>

                  <div className="mt-5 text-xs text-slate-500">
                    Selected: <span className="font-medium text-slate-700">{concerns.length}</span>/2
                  </div>
                </div>
              ) : null}

              {step === 2 ? (
                <div className="h-full flex flex-col">
                  <div className="mt-2 space-y-1">
                    <div className="text-xs font-medium text-slate-500">Step 3</div>
                    <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Monthly budget?</h1>
                    <p className="text-sm text-slate-600">We&apos;ll optimize the routine without wasting money.</p>
                  </div>

                  <div className="mt-6 space-y-3">
                    {BUDGET_OPTIONS.map((opt) => (
                      <OptionCard
                        key={opt.value}
                        selected={budget === opt.value}
                        title={opt.label}
                        subtitle={opt.helper}
                        onClick={() => {
                          setBudget(opt.value);
                          window.setTimeout(() => go(3), 220);
                        }}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="h-full flex flex-col">
                  <div className="mt-2 space-y-1">
                    <div className="text-xs font-medium text-slate-500">Step 4</div>
                    <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Current barrier status?</h1>
                    <p className="text-sm text-slate-600">
                      This affects whether we choose actives or prioritize repair.
                    </p>
                  </div>

                  <div className="mt-6 space-y-3">
                    {BARRIER_OPTIONS.map((opt) => (
                      <OptionCard
                        key={opt.value}
                        selected={barrier === opt.value}
                        title={opt.label}
                        subtitle={opt.helper}
                        onClick={() => setBarrier(opt.value)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {step === 4 ? (
                <div className="h-full flex flex-col items-center justify-center text-center px-2">
                  <div className="h-14 w-14 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-sm">
                    <Sparkles className="h-6 w-6" />
                  </div>
                  <h2 className="mt-4 text-xl font-semibold text-slate-900">Perfect.</h2>
                  <p className="mt-2 text-sm text-slate-600">
                    Your profile is saved. Next we&apos;ll generate your report and routine.
                  </p>
                  {answers ? (
                    <div className="mt-5 w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left">
                      <div className="text-xs font-semibold text-slate-700">Your profile</div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-700">
                        <div className="rounded-xl bg-white border border-slate-200 px-3 py-2">
                          <div className="text-[10px] text-slate-500">Skin</div>
                          <div className="font-medium">{answers.skin_type}</div>
                        </div>
                        <div className="rounded-xl bg-white border border-slate-200 px-3 py-2">
                          <div className="text-[10px] text-slate-500">Budget</div>
                          <div className="font-medium">¥{answers.monthly_budget_cny}</div>
                        </div>
                        <div className="rounded-xl bg-white border border-slate-200 px-3 py-2 col-span-2">
                          <div className="text-[10px] text-slate-500">Concerns</div>
                          <div className="font-medium">{answers.concerns.join(", ")}</div>
                        </div>
                        <div className="rounded-xl bg-white border border-slate-200 px-3 py-2 col-span-2">
                          <div className="text-[10px] text-slate-500">Barrier</div>
                          <div className="font-medium">{answers.barrier_status}</div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 0 || step === 4}
            className={cx(
              "inline-flex items-center gap-1 rounded-full border px-3 py-2 text-sm transition",
              step === 0 || step === 4
                ? "border-slate-200 text-slate-400 cursor-not-allowed"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
            )}
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </button>

          <button
            type="button"
            onClick={goNext}
            disabled={!canContinue}
            className={cx(
              "ml-auto rounded-full px-4 py-2 text-sm font-semibold transition shadow-sm active:scale-[0.99]",
              canContinue ? "bg-slate-900 text-white hover:bg-slate-800" : "bg-slate-200 text-slate-500 cursor-not-allowed",
            )}
          >
            {step === 3 ? "Start" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
