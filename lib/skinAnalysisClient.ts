import type { AuroraLang } from "@/lib/pivotaAgentBff";

export const PHOTO_UPLOAD_TIMEOUT_MS = 45000;
export const SKIN_ANALYSIS_TIMEOUT_MS = 55000;

export function isAbortLikeError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && String((error as { name?: unknown }).name || "") === "AbortError";
}

export function photoUploadTemporaryIssueMessage(lang: AuroraLang): string {
  return lang === "CN" ? "照片上传暂时遇到问题，请重试" : "Photo upload encountered a temporary issue — please retry";
}

export function skinAnalysisTemporaryIssueMessage(lang: AuroraLang): string {
  return lang === "CN" ? "皮肤分析暂时遇到问题，请重试" : "Skin analysis encountered a temporary issue — please retry";
}
