"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { logSkinStatus } from "@/actions/userProfile";

const UID_KEY = "aurora_uid";
const COOKIE_NAME = "aurora_uid";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function getOrCreateAuroraUid() {
  if (typeof window === "undefined") return null;

  const existing = window.localStorage.getItem(UID_KEY);
  if (existing && existing.trim()) return existing.trim();

  const cryptoObj = globalThis.crypto as Crypto | undefined;
  const uid = (cryptoObj?.randomUUID?.() ?? `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`).slice(0, 64);
  window.localStorage.setItem(UID_KEY, uid);
  return uid;
}

function setAuroraUidCookie(uid: string) {
  if (typeof document === "undefined") return;
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  document.cookie = [
    `${COOKIE_NAME}=${encodeURIComponent(uid)}`,
    "Path=/",
    `Max-Age=${ONE_YEAR_SECONDS}`,
    "SameSite=Lax",
    secure ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

export function SkinTracker() {
  const [userId, setUserId] = useState<string | null>(null);

  const [rednessLevel, setRednessLevel] = useState(0);
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);

  useEffect(() => {
    const uid = getOrCreateAuroraUid();
    if (!uid) return;
    setAuroraUidCookie(uid);
    setUserId(uid);
  }, []);

  const canSubmit = useMemo(() => Boolean(userId) && !isSubmitting, [isSubmitting, userId]);

  const handleSubmit = useCallback(async () => {
    if (!userId) return;
    setIsSubmitting(true);
    setSubmitError(null);
    setSubmittedAt(null);

    try {
      await logSkinStatus(userId, {
        rednessLevel,
        notes,
      });
      setSubmittedAt(Date.now());
      setNotes("");
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed to save log");
    } finally {
      setIsSubmitting(false);
    }
  }, [notes, rednessLevel, userId]);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-slate-900">Skin Tracker</div>
          <div className="mt-1 text-xs text-slate-500">Log today’s status so Aurora can adapt your routine.</div>
        </div>
        <div className="text-[11px] text-slate-400">{userId ? `UID: ${userId.slice(0, 8)}…` : "UID: —"}</div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-slate-600">Redness</div>
          <div className="text-xs text-slate-500">{rednessLevel} / 5</div>
        </div>
        <input
          className="mt-2 w-full"
          type="range"
          min={0}
          max={5}
          step={1}
          value={rednessLevel}
          onChange={(e) => setRednessLevel(Number(e.target.value))}
        />
        <div className="mt-1 flex justify-between text-[10px] text-slate-400">
          <span>0</span>
          <span>1</span>
          <span>2</span>
          <span>3</span>
          <span>4</span>
          <span>5</span>
        </div>
      </div>

      <div className="mt-4">
        <div className="text-xs font-semibold text-slate-600">Notes (optional)</div>
        <textarea
          className="mt-2 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
          rows={3}
          placeholder="e.g., stinging after cleanser, redness around nose, tried a new serum…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {submitError ? (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{submitError}</div>
      ) : null}
      {submittedAt ? (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Saved. Aurora will use this in future suggestions.
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-end">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={cx(
            "rounded-xl px-4 py-2 text-sm font-semibold",
            canSubmit ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-slate-100 text-slate-400 cursor-not-allowed",
          )}
        >
          {isSubmitting ? "Saving…" : "Save log"}
        </button>
      </div>
    </section>
  );
}

