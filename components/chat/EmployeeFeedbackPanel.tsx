"use client";

import { cn } from "@/lib/cn";
import { EMPLOYEE_REASON_TAGS, type EmployeeReasonTag } from "@/lib/recoEmployeeFeedback";
import type { RecoBlockName, RecoEmployeeFeedbackPayload } from "@/lib/pivotaAgentBff";
import { useMemo, useState } from "react";

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
  onSubmit,
}: Props) {
  const [showReasons, setShowReasons] = useState(false);
  const [reasonTags, setReasonTags] = useState<EmployeeReasonTag[]>([]);
  const [wrongBlockTarget, setWrongBlockTarget] = useState<RecoBlockName>("competitors");

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
    };
    onSubmit(payload);
  };

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-2.5" aria-label="Employee feedback panel">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => emit("relevant")}
          className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700"
        >
          ✅ 相关
        </button>
        <button
          type="button"
          onClick={() => emit("not_relevant")}
          className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700"
        >
          ❌ 不相关
        </button>
        <button
          type="button"
          onClick={() => emit("wrong_block")}
          className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700"
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
