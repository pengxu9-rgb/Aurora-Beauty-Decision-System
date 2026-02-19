"use client";

import { cn } from "@/lib/cn";
import { EMPLOYEE_REASON_TAGS, type EmployeeReasonTag } from "@/lib/recoEmployeeFeedback";
import type { RecoBlockName, RecoEmployeeFeedbackPayload } from "@/lib/pivotaAgentBff";
import { formatSuggestionConfidence, type NormalizedLlmSuggestion, suggestionLabelText } from "@/lib/recoPrelabelUi";
import { useEffect, useMemo, useState } from "react";

type Props = {
  anchorProductId: string;
  block: RecoBlockName;
  candidateProductId?: string;
  candidateName?: string;
  rankPosition: number;
  requestId: string;
  sessionId: string;
  pipelineVersion?: string;
  models?: string | Record<string, unknown>;
  llmSuggestion?: NormalizedLlmSuggestion | null;
  onSubmit: (payload: RecoEmployeeFeedbackPayload) => void;
};

export function EmployeeFeedbackPanel({
  anchorProductId,
  block,
  candidateProductId,
  candidateName,
  rankPosition,
  requestId,
  sessionId,
  pipelineVersion,
  models,
  llmSuggestion,
  onSubmit,
}: Props) {
  const [showReasons, setShowReasons] = useState(false);
  const [reasonTags, setReasonTags] = useState<EmployeeReasonTag[]>([]);
  const [selectedFeedbackType, setSelectedFeedbackType] = useState<RecoEmployeeFeedbackPayload["feedback_type"] | null>(
    llmSuggestion?.suggested_label || null,
  );
  const [wrongBlockTarget, setWrongBlockTarget] = useState<RecoBlockName>(
    llmSuggestion?.wrong_block_target || "competitors",
  );

  useEffect(() => {
    setSelectedFeedbackType(llmSuggestion?.suggested_label || null);
    setWrongBlockTarget(llmSuggestion?.wrong_block_target || "competitors");
  }, [llmSuggestion?.suggested_label, llmSuggestion?.wrong_block_target]);

  const canSubmit = useMemo(() => Boolean(anchorProductId && requestId && sessionId && (candidateProductId || candidateName)), [
    anchorProductId,
    candidateName,
    candidateProductId,
    requestId,
    sessionId,
  ]);

  const toggleReason = (tag: EmployeeReasonTag) => {
    setReasonTags((prev) => {
      if (prev.includes(tag)) return prev.filter((x) => x !== tag);
      return [...prev, tag].slice(0, 12);
    });
  };

  const emit = (feedbackType: RecoEmployeeFeedbackPayload["feedback_type"]) => {
    if (!canSubmit) return;
    setSelectedFeedbackType(feedbackType);
    const payload: RecoEmployeeFeedbackPayload = {
      anchor_product_id: anchorProductId,
      block,
      candidate_product_id: candidateProductId,
      candidate_name: candidateName,
      feedback_type: feedbackType,
      reason_tags: reasonTags,
      rank_position: rankPosition,
      request_id: requestId,
      session_id: sessionId,
      ...(pipelineVersion ? { pipeline_version: pipelineVersion } : {}),
      ...(models ? { models } : {}),
      ...(feedbackType === "wrong_block" ? { wrong_block_target: wrongBlockTarget } : {}),
      ...(llmSuggestion?.suggestion_id ? { suggestion_id: llmSuggestion.suggestion_id } : {}),
      ...(llmSuggestion?.suggested_label ? { llm_suggested_label: llmSuggestion.suggested_label } : {}),
      ...(llmSuggestion?.confidence != null ? { llm_confidence: llmSuggestion.confidence } : {}),
    };
    onSubmit(payload);
  };

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-2.5" aria-label="Employee feedback panel">
      {llmSuggestion?.suggested_label ? (
        <div className="mb-2 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-[11px] text-indigo-700">
          <div className="font-semibold">
            LLM 建议: {suggestionLabelText(llmSuggestion.suggested_label)}
            {llmSuggestion.wrong_block_target ? ` -> ${llmSuggestion.wrong_block_target}` : ""}
            {llmSuggestion.confidence != null ? ` (${formatSuggestionConfidence(llmSuggestion.confidence)})` : ""}
          </div>
          {llmSuggestion.rationale_user_visible ? <div className="mt-0.5 text-indigo-700">{llmSuggestion.rationale_user_visible}</div> : null}
          {llmSuggestion.flags.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {llmSuggestion.flags.slice(0, 6).map((flag) => (
                <span key={flag} className="rounded-full border border-indigo-200 bg-white px-1.5 py-0.5 text-[10px]">
                  {flag}
                </span>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => emit(llmSuggestion.suggested_label as RecoEmployeeFeedbackPayload["feedback_type"])}
            className="mt-1.5 rounded-full border border-indigo-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-indigo-700"
          >
            一键接受建议
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => emit("relevant")}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-semibold",
            selectedFeedbackType === "relevant"
              ? "border-emerald-300 bg-emerald-100 text-emerald-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-700",
          )}
        >
          ✅ 相关
        </button>
        <button
          type="button"
          onClick={() => emit("not_relevant")}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-semibold",
            selectedFeedbackType === "not_relevant"
              ? "border-rose-300 bg-rose-100 text-rose-800"
              : "border-rose-200 bg-rose-50 text-rose-700",
          )}
        >
          ❌ 不相关
        </button>
        <button
          type="button"
          onClick={() => emit("wrong_block")}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-semibold",
            selectedFeedbackType === "wrong_block"
              ? "border-amber-300 bg-amber-100 text-amber-800"
              : "border-amber-200 bg-amber-50 text-amber-700",
          )}
        >
          ⚠️ 分块错了
        </button>
        <select
          aria-label="Wrong block target"
          value={wrongBlockTarget}
          onChange={(e) => setWrongBlockTarget((e.target.value as RecoBlockName) || "competitors")}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
        >
          <option value="competitors">competitors</option>
          <option value="dupes">dupes</option>
          <option value="related_products">related_products</option>
        </select>
      </div>

      <div className="mt-2">
        <button
          type="button"
          className="text-[11px] font-semibold text-slate-600 underline-offset-2 hover:underline"
          onClick={() => setShowReasons((v) => !v)}
        >
          {showReasons ? "Hide reasons" : "Optional reasons"}
        </button>
      </div>
      {showReasons ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EMPLOYEE_REASON_TAGS.map((tag) => {
            const active = reasonTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleReason(tag)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                  active ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600",
                )}
              >
                {tag}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
