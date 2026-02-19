import type { RecoBlockName, RecoEmployeeFeedbackType } from "@/lib/pivotaAgentBff";

export type NormalizedLlmSuggestion = {
  suggestion_id: string;
  suggested_label: RecoEmployeeFeedbackType | null;
  wrong_block_target: RecoBlockName | null;
  confidence: number | null;
  rationale_user_visible: string;
  flags: string[];
};

function normalizeFeedbackType(raw: unknown): RecoEmployeeFeedbackType | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "relevant" || v === "not_relevant" || v === "wrong_block") return v;
  return null;
}

function normalizeBlock(raw: unknown): RecoBlockName | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "competitors" || v === "dupes" || v === "related_products") return v;
  return null;
}

function normalizeFlags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const flag = String(item || "").trim();
    if (!flag || seen.has(flag.toLowerCase())) continue;
    seen.add(flag.toLowerCase());
    out.push(flag);
    if (out.length >= 10) break;
  }
  return out;
}

function normalizeConfidence(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

export function normalizeLlmSuggestion(raw: unknown): NormalizedLlmSuggestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const suggested = normalizeFeedbackType(row.suggested_label);
  return {
    suggestion_id: String(row.id || "").trim(),
    suggested_label: suggested,
    wrong_block_target: normalizeBlock(row.wrong_block_target),
    confidence: normalizeConfidence(row.confidence),
    rationale_user_visible: String(row.rationale_user_visible || "").trim(),
    flags: normalizeFlags(row.flags),
  };
}

export function suggestionLabelText(v: RecoEmployeeFeedbackType | null): string {
  if (v === "relevant") return "相关";
  if (v === "not_relevant") return "不相关";
  if (v === "wrong_block") return "分块错了";
  return "unknown";
}

export function formatSuggestionConfidence(confidence: number | null): string {
  if (confidence == null || !Number.isFinite(confidence)) return "";
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

