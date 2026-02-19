"use client";

import { EmployeeFeedbackPanel } from "@/components/chat/EmployeeFeedbackPanel";
import { cn } from "@/lib/cn";
import { extractDogfoodViewModel } from "@/lib/recoDogfoodView";
import { formatSuggestionConfidence, normalizeLlmSuggestion, suggestionLabelText } from "@/lib/recoPrelabelUi";
import type { RecoBlockName, RecoEmployeeFeedbackPayload, RecoInterleaveClickPayload } from "@/lib/pivotaAgentBff";

type AnyObj = Record<string, unknown>;

type Candidate = {
  product_id?: string;
  sku_id?: string;
  name?: string;
  display_name?: string;
  brand?: string;
  price_band?: string;
  source?: { type?: string; url?: string };
  why_candidate?: {
    summary?: string;
    reasons_user_visible?: string[];
    boundary_user_visible?: string;
  } | string[];
  social_summary_user_visible?: {
    themes?: string[];
    top_keywords?: string[];
    sentiment_hint?: string;
    volume_bucket?: string;
  };
  evidence_refs?: Array<{ id?: string; source_type?: string }>;
  llm_suggestion?: Record<string, unknown>;
};

type BlockPayload = {
  candidates: Candidate[];
};

function asObj(value: unknown): AnyObj | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as AnyObj;
}

function parseCandidates(value: unknown): Candidate[] {
  const obj = asObj(value);
  const rows = Array.isArray(obj?.candidates) ? obj.candidates : [];
  return rows.filter((r) => r && typeof r === "object") as Candidate[];
}

function whySummary(candidate: Candidate) {
  const why = candidate.why_candidate;
  if (Array.isArray(why)) return why[0] || "";
  if (why && typeof why === "object") return String(why.summary || "").trim();
  return "";
}

function whyReasons(candidate: Candidate) {
  const why = candidate.why_candidate;
  if (Array.isArray(why)) return why.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 3);
  const rows = Array.isArray(why?.reasons_user_visible) ? why.reasons_user_visible : [];
  return rows.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 3);
}

function whyBoundary(candidate: Candidate) {
  const why = candidate.why_candidate;
  if (!why || Array.isArray(why)) return "";
  return String(why.boundary_user_visible || "").trim();
}

function blockLabel(block: RecoBlockName) {
  if (block === "competitors") return "Competitors";
  if (block === "dupes") return "Dupes";
  return "Related products";
}

function toChannelLabel(raw: string) {
  const token = String(raw || "").trim().toLowerCase();
  if (token === "reddit") return "Reddit";
  if (token === "xiaohongshu") return "Xiaohongshu";
  if (token === "tiktok") return "TikTok";
  if (token === "youtube") return "YouTube";
  if (token === "instagram") return "Instagram";
  return token;
}

function buildOverallSocialSummary(candidates: Candidate[]) {
  const summaries = candidates
    .map((row) => (row && typeof row.social_summary_user_visible === "object" ? row.social_summary_user_visible : null))
    .filter(Boolean) as Array<{
    themes?: string[];
    top_keywords?: string[];
    sentiment_hint?: string;
    volume_bucket?: string;
  }>;
  if (!summaries.length) return "";

  const themes = Array.from(
    new Set(
      summaries
        .flatMap((s) => (Array.isArray(s.themes) ? s.themes : []))
        .map((x) => String(x || "").trim())
        .filter(Boolean),
    ),
  ).slice(0, 3);
  const sentimentRows = summaries
    .map((s) => String(s.sentiment_hint || "").trim())
    .filter(Boolean);
  const sentimentText = sentimentRows[0] || "";
  const volumeRank = { unknown: 0, low: 1, mid: 2, high: 3 } as const;
  let volume: keyof typeof volumeRank = "unknown";
  for (const summary of summaries) {
    const raw = String(summary.volume_bucket || "").trim().toLowerCase() as keyof typeof volumeRank;
    if (!(raw in volumeRank)) continue;
    if (volumeRank[raw] > volumeRank[volume]) volume = raw;
  }

  const themeText = themes.length ? `Key themes: ${themes.join(" · ")}.` : "";
  const sentiment = sentimentText ? `Overall sentiment: ${sentimentText}` : "Overall sentiment: mixed.";
  return `${sentiment} ${themeText} Discussion volume: ${volume}.`.trim();
}

export function ProductAnalysisCard({
  cardId,
  payload,
  requestId,
  sessionId,
  onEmployeeFeedback,
  onInterleaveClick,
}: {
  cardId: string;
  payload: Record<string, unknown>;
  requestId: string;
  sessionId: string;
  onEmployeeFeedback?: (payload: RecoEmployeeFeedbackPayload) => void;
  onInterleaveClick?: (payload: RecoInterleaveClickPayload) => void;
}) {
  const assessment = asObj(payload?.assessment) || {};
  const verdict = typeof assessment.verdict === "string" ? assessment.verdict : "";
  const reasons = Array.isArray(assessment.reasons) ? assessment.reasons.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const anchor = asObj(assessment.anchor_product) || {};
  const provenance = asObj(payload?.provenance) || {};
  const socialChannels = Array.isArray(provenance.social_channels_used)
    ? Array.from(
        new Set(
          provenance.social_channels_used
            .map((x) => toChannelLabel(String(x || "")))
            .filter(Boolean),
        ),
      ).slice(0, 5)
    : [];
  const socialFetchMode = typeof provenance.social_fetch_mode === "string" ? provenance.social_fetch_mode : "";
  const anchorProductId =
    (typeof anchor.product_id === "string" && anchor.product_id) ||
    (typeof anchor.sku_id === "string" && anchor.sku_id) ||
    (typeof anchor.name === "string" && anchor.name) ||
    "";
  const dogfood = extractDogfoodViewModel(payload);

  const blocks: Array<{ block: RecoBlockName; data: BlockPayload }> = [
    { block: "competitors", data: { candidates: parseCandidates(payload.competitors) } },
    { block: "related_products", data: { candidates: parseCandidates(payload.related_products) } },
    { block: "dupes", data: { candidates: parseCandidates(payload.dupes) } },
  ];

  return (
    <section key={cardId} className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Product analysis">
      <div className="text-xs font-semibold text-slate-900">Product Deep Scan</div>
      {verdict ? <div className="mt-1 text-sm font-semibold text-slate-900">Verdict: {verdict}</div> : null}
      {reasons.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-slate-700">
          {reasons.slice(0, 3).map((r, idx) => (
            <li key={`${cardId}_reason_${idx}`}>{r}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 space-y-3">
        {blocks.map(({ block, data }) => (
          <div key={`${cardId}_${block}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-slate-900">{blockLabel(block)}</div>
              <div className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                {data.candidates.length} items
              </div>
            </div>
            {(() => {
              const summary = buildOverallSocialSummary(data.candidates);
              if (!summary && !socialChannels.length) return null;
              return (
                <div className="mt-2 rounded-md border border-emerald-100 bg-emerald-50 p-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Overall social signal</div>
                  {summary ? <div className="mt-1 text-[11px] text-emerald-800">{summary}</div> : null}
                  {!summary && socialFetchMode === "async_refresh" ? (
                    <div className="mt-1 text-[11px] text-emerald-700">Cross-platform signal is syncing. Refresh to see updated highlights.</div>
                  ) : null}
                  {socialChannels.length ? (
                    <div className="mt-1 text-[11px] text-emerald-700">Sources: {socialChannels.join(", ")}</div>
                  ) : null}
                </div>
              );
            })()}

            {data.candidates.length ? (
              <div className="mt-2 space-y-2">
                {data.candidates.slice(0, 8).map((candidate, idx) => {
                  const name = String(candidate.display_name || candidate.name || "Unnamed candidate");
                  const brand = typeof candidate.brand === "string" ? candidate.brand : "";
                  const sourceType = String(candidate.source?.type || "").trim();
                  const sourceUrl = String(candidate.source?.url || "").trim();
                  const summary = whySummary(candidate);
                  const reasonRows = whyReasons(candidate);
                  const boundary = whyBoundary(candidate);
                  const social = candidate.social_summary_user_visible || {};
                  const socialThemes = Array.isArray(social.themes) ? social.themes.slice(0, 3) : [];
                  const socialKeywords = Array.isArray(social.top_keywords) ? social.top_keywords.slice(0, 6) : [];
                  const evidenceRefs = Array.isArray(candidate.evidence_refs) ? candidate.evidence_refs : [];
                  const llmSuggestion = normalizeLlmSuggestion(candidate.llm_suggestion);
                  const candidateId = String(candidate.product_id || candidate.sku_id || name);

                  const interleavePayload: RecoInterleaveClickPayload = {
                    anchor_product_id: anchorProductId || "unknown_anchor",
                    block,
                    candidate_product_id: candidate.product_id,
                    candidate_name: name,
                    request_id: requestId,
                    session_id: sessionId,
                    pipeline_version: dogfood.pipeline_version || undefined,
                    models: dogfood.models,
                    price_band: typeof candidate.price_band === "string" ? candidate.price_band : undefined,
                  };

                  return (
                    <article key={`${cardId}_${block}_${candidateId}_${idx}`} className="rounded-lg border border-slate-200 bg-white p-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-slate-900 truncate">{name}</div>
                          <div className="mt-0.5 text-[11px] text-slate-600">
                            {[brand, candidate.price_band ? String(candidate.price_band) : "", sourceType].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        {sourceUrl ? (
                          <a
                            href={sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-1 text-[10px] font-semibold text-indigo-700"
                            onClick={() => onInterleaveClick?.(interleavePayload)}
                          >
                            Open
                          </a>
                        ) : (
                          <button
                            type="button"
                            className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-700"
                            onClick={() => onInterleaveClick?.(interleavePayload)}
                          >
                            Compare click
                          </button>
                        )}
                      </div>

                      {summary ? <div className="mt-1.5 text-[11px] text-slate-700">{summary}</div> : null}
                      {dogfood.dogfood_mode && llmSuggestion?.suggested_label ? (
                        <div className="mt-1.5 rounded-md border border-indigo-200 bg-indigo-50 p-2 text-[11px] text-indigo-700">
                          <div className="font-semibold">
                            LLM suggestion: {suggestionLabelText(llmSuggestion.suggested_label)}
                            {llmSuggestion.wrong_block_target ? ` -> ${llmSuggestion.wrong_block_target}` : ""}
                            {llmSuggestion.confidence != null ? ` (${formatSuggestionConfidence(llmSuggestion.confidence)})` : ""}
                          </div>
                          {llmSuggestion.rationale_user_visible ? <div className="mt-1">{llmSuggestion.rationale_user_visible}</div> : null}
                          {llmSuggestion.flags.length ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {llmSuggestion.flags.slice(0, 6).map((flag) => (
                                <span key={`${candidateId}_${flag}`} className="rounded-full border border-indigo-200 bg-white px-1.5 py-0.5 text-[10px]">
                                  {flag}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {reasonRows.length ? (
                        <ul className="mt-1.5 list-disc pl-4 text-[11px] text-slate-600">
                          {reasonRows.map((r, reasonIdx) => (
                            <li key={`${candidateId}_reason_${reasonIdx}`}>{r}</li>
                          ))}
                        </ul>
                      ) : null}
                      {boundary ? (
                        <div className="mt-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700">
                          {boundary}
                        </div>
                      ) : null}

                      {(socialThemes.length || socialKeywords.length || social.sentiment_hint) ? (
                        <div className="mt-1.5 rounded-md border border-emerald-100 bg-emerald-50 p-2">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Social summary</div>
                          {socialThemes.length ? <div className="mt-1 text-[11px] text-emerald-800">Themes: {socialThemes.join(" · ")}</div> : null}
                          {socialKeywords.length ? (
                            <div className="mt-1 text-[11px] text-emerald-700">Keywords: {socialKeywords.join(", ")}</div>
                          ) : null}
                          {social.sentiment_hint ? (
                            <div className="mt-1 text-[11px] text-emerald-700">
                              {String(social.sentiment_hint)} ({String(social.volume_bucket || "unknown")})
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {evidenceRefs.length ? (
                        <div className={cn("mt-1.5 text-[10px] text-slate-500")}>Evidence refs: {Math.min(6, evidenceRefs.length)}</div>
                      ) : null}

                      {dogfood.show_employee_feedback_controls && onEmployeeFeedback ? (
                        <EmployeeFeedbackPanel
                          anchorProductId={anchorProductId || "unknown_anchor"}
                          block={block}
                          candidateProductId={candidate.product_id}
                          candidateName={name}
                          rankPosition={idx + 1}
                          requestId={requestId}
                          sessionId={sessionId}
                          pipelineVersion={dogfood.pipeline_version || undefined}
                          models={dogfood.models}
                          llmSuggestion={llmSuggestion}
                          onSubmit={onEmployeeFeedback}
                        />
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="mt-2 text-xs text-slate-500">No candidates returned.</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
