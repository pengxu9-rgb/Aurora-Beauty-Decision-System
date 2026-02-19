"use client";

import { fetchLabelQueue, type RecoLabelQueueItem } from "@/lib/recoLabelQueueClient";
import { postRecoEmployeeFeedback, type AuroraLang } from "@/lib/pivotaAgentBff";
import { useEffect, useMemo, useState } from "react";

function safeUuid() {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getOrCreateUid() {
  if (typeof window === "undefined") return "";
  const key = "aurora_uid";
  const existing = window.localStorage.getItem(key);
  if (existing && existing.trim()) return existing.trim();
  const next = safeUuid().slice(0, 64);
  window.localStorage.setItem(key, next);
  return next;
}

function normalizeLang(raw: string): AuroraLang {
  const up = String(raw || "").trim().toUpperCase();
  return up === "CN" ? "CN" : "EN";
}

type Filters = {
  block: "" | "competitors" | "dupes" | "related_products";
  low_confidence: boolean;
  wrong_block_only: boolean;
  exploration_only: boolean;
  missing_info_only: boolean;
};

export function LabelQueuePage() {
  const [uid, setUid] = useState("");
  const [items, setItems] = useState<RecoLabelQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittingKey, setSubmittingKey] = useState<string>("");
  const [filters, setFilters] = useState<Filters>({
    block: "",
    low_confidence: false,
    wrong_block_only: false,
    exploration_only: false,
    missing_info_only: false,
  });

  const lang = useMemo(() => normalizeLang(typeof navigator !== "undefined" ? navigator.language : "EN"), []);

  useEffect(() => {
    setUid(getOrCreateUid());
  }, []);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchLabelQueue({
        block: filters.block || undefined,
        limit: 80,
        low_confidence: filters.low_confidence || undefined,
        wrong_block_only: filters.wrong_block_only || undefined,
        exploration_only: filters.exploration_only || undefined,
        missing_info_only: filters.missing_info_only || undefined,
      });
      setItems(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load label queue");
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.block, filters.low_confidence, filters.wrong_block_only, filters.exploration_only, filters.missing_info_only]);

  const acceptSuggestion = async (item: RecoLabelQueueItem) => {
    if (!uid) return;
    const key = `${item.suggestion_id}:${item.block}:${item.candidate_product_id}`;
    setSubmittingKey(key);
    setError(null);
    try {
      await postRecoEmployeeFeedback(
        {
          anchor_product_id: item.anchor_product_id,
          block: item.block,
          candidate_product_id: item.candidate_product_id,
          feedback_type: item.suggested_label,
          ...(item.suggested_label === "wrong_block" && item.wrong_block_target ? { wrong_block_target: item.wrong_block_target } : {}),
          suggestion_id: item.suggestion_id,
          llm_suggested_label: item.suggested_label,
          llm_confidence: item.confidence,
          request_id: `queue_${safeUuid()}`,
          session_id: uid,
        },
        {
          uid,
          lang,
        },
      );
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit feedback");
    } finally {
      setSubmittingKey("");
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-lg font-semibold text-slate-900">Dogfood Label Queue</div>
          <div className="mt-1 text-sm text-slate-600">LLM pre-label suggestions for employee review.</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <select
              value={filters.block}
              onChange={(e) => setFilters((prev) => ({ ...prev, block: (e.target.value as Filters["block"]) || "" }))}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
            >
              <option value="">all blocks</option>
              <option value="competitors">competitors</option>
              <option value="dupes">dupes</option>
              <option value="related_products">related_products</option>
            </select>
            <label className="flex items-center gap-1 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={filters.low_confidence}
                onChange={(e) => setFilters((prev) => ({ ...prev, low_confidence: e.target.checked }))}
              />
              low_confidence
            </label>
            <label className="flex items-center gap-1 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={filters.wrong_block_only}
                onChange={(e) => setFilters((prev) => ({ ...prev, wrong_block_only: e.target.checked }))}
              />
              wrong_block_only
            </label>
            <label className="flex items-center gap-1 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={filters.exploration_only}
                onChange={(e) => setFilters((prev) => ({ ...prev, exploration_only: e.target.checked }))}
              />
              exploration_only
            </label>
            <label className="flex items-center gap-1 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={filters.missing_info_only}
                onChange={(e) => setFilters((prev) => ({ ...prev, missing_info_only: e.target.checked }))}
              />
              missing_info_only
            </label>
          </div>
        </section>

        {error ? (
          <section className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</section>
        ) : null}

        <section className="space-y-3">
          {loading ? <div className="text-sm text-slate-500">Loading queue...</div> : null}
          {!loading && !items.length ? <div className="text-sm text-slate-500">No queue items.</div> : null}
          {items.map((item) => {
            const key = `${item.suggestion_id}:${item.block}:${item.candidate_product_id}`;
            const submitting = submittingKey === key;
            return (
              <article key={key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">
                      {item.block} · {item.candidate_product_id}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      anchor: {item.anchor_product_id} · confidence: {Math.round(item.confidence * 100)}% · priority:{" "}
                      {item.priority_score.toFixed(3)}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void acceptSuggestion(item)}
                    className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 disabled:opacity-60"
                  >
                    {submitting ? "Submitting..." : "接受建议并提交反馈"}
                  </button>
                </div>
                <div className="mt-2 text-sm text-slate-700">
                  LLM suggestion: <span className="font-semibold">{item.suggested_label}</span>
                  {item.wrong_block_target ? ` -> ${item.wrong_block_target}` : ""}
                </div>
                <div className="mt-1 text-sm text-slate-700">{item.rationale_user_visible}</div>
                {item.flags.length ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {item.flags.map((flag) => (
                      <span key={`${key}_${flag}`} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">
                        {flag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}
