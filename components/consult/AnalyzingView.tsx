"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const DEFAULT_STEPS = [
  "Analyzing skin profile…",
  "Searching ingredient database…",
  "Checking safety protocols…",
  "Optimizing budget…",
];

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function AnalyzingView({
  title = "One moment",
  subtitle = "I’m building your personalized routine.",
  steps = DEFAULT_STEPS,
}: {
  title?: string;
  subtitle?: string;
  steps?: string[];
}) {
  const [idx, setIdx] = useState(0);

  const current = useMemo(() => steps[Math.min(idx, steps.length - 1)] ?? "Analyzing…", [idx, steps]);

  useEffect(() => {
    if (steps.length <= 1) return;
    const t = window.setInterval(() => setIdx((v) => (v + 1) % steps.length), 900);
    return () => window.clearInterval(t);
  }, [steps.length]);

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/40 overflow-hidden">
      <div className="p-6">
        <div className="flex items-center gap-3">
          <div className="relative h-12 w-12">
            <motion.div
              className="absolute inset-0 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600"
              animate={{ opacity: [0.9, 1, 0.9] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              className="absolute -inset-2 rounded-3xl border border-indigo-200"
              animate={{ opacity: [0.15, 0.35, 0.15], scale: [0.98, 1.03, 0.98] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
            />
            <div className="absolute inset-0 rounded-2xl text-white flex items-center justify-center">
              <Sparkles className="h-6 w-6" />
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-base font-semibold text-slate-900">{title}</div>
            <div className="text-sm text-slate-600">{subtitle}</div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <AnimatePresence mode="wait">
            <motion.div
              key={current}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22 }}
              className="text-sm text-slate-700"
            >
              {current}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
            <motion.div
              className={cx("h-2 rounded-full", "bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-600")}
              initial={{ x: "-60%" }}
              animate={{ x: "120%" }}
              transition={{ duration: 1.3, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>
          <div className="text-xs text-slate-500">Live</div>
        </div>
      </div>
    </div>
  );
}

