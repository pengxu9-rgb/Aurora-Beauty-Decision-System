import { NextResponse } from "next/server.js";

import { parseUpstreamChatRequest } from "./request.ts";
import { classifyProviderExecutionFailure, executePromptText } from "./providers.ts";
import { listSupportedTemplateIds, parseCandidateFromText, resolveTemplateDefinition, validateRequiredKeysObject } from "./templates.ts";
import type {
  ModelExecutionResult,
  SupportedProvider,
  TemplateValidationFailureReason,
  UpstreamChatRequest,
  UpstreamFailurePayload,
  UpstreamSuccessPayload,
} from "./types.ts";

type HandleUpstreamChatArgs = {
  req: Request;
  body: unknown;
  executePrompt?: (input: {
    prompt: string;
    preferredProvider: SupportedProvider | null;
    requestedModel: string | null;
  }) => Promise<ModelExecutionResult>;
};

function buildSuccess(payload: UpstreamSuccessPayload) {
  return NextResponse.json(payload);
}

function buildFailure(payload: UpstreamFailurePayload, status = 200) {
  return NextResponse.json(payload, { status });
}

function buildProviderFailure({
  request,
  templateIntent,
  attempts,
  err,
}: {
  request: UpstreamChatRequest;
  templateIntent: string | null;
  attempts: number;
  err: unknown;
}) {
  const classified = classifyProviderExecutionFailure(err);
  return buildFailure({
    ok: false,
    error: classified.error,
    intent: templateIntent || request.intent_hint || "generic",
    prompt_template_id: request.prompt_template_id,
    prompt_hash: request.prompt_hash,
    structured: null,
    answer: "",
    text: "",
    raw_text: "",
    failure_reason: classified.failure_reason,
    missing_keys: [],
    retry_count: Math.max(0, attempts - 1),
    llm_provider: request.llm_provider,
    llm_model: request.llm_model,
    upstream_status: classified.upstream_status,
    upstream_error_code: classified.upstream_error_code,
    ...(request.debug
      ? {
          debug: {
            validator_failure_reason: null,
            missing_keys: [],
            retry_count: Math.max(0, attempts - 1),
            provider_error: classified.error,
            upstream_status: classified.upstream_status,
            upstream_error_code: classified.upstream_error_code,
          },
        }
      : {}),
  });
}

export async function handleUpstreamChatRequest({
  req,
  body,
  executePrompt = executePromptText,
}: HandleUpstreamChatArgs) {
  const parsed = parseUpstreamChatRequest(req, body);
  if (!parsed.ok) {
    return buildFailure(
      {
        ok: false,
        error: parsed.error,
        intent: null,
        prompt_template_id: null,
        prompt_hash: null,
        structured: null,
        answer: "",
        text: "",
        raw_text: "",
        failure_reason: "bad_request",
        missing_keys: [],
        retry_count: 0,
        llm_provider: null,
        llm_model: null,
      },
      parsed.status,
    );
  }

  const request = parsed.value;
  const template = resolveTemplateDefinition(request.prompt_template_id);
  if (request.prompt_template_id && !template) {
    return buildFailure(
      {
        ok: false,
        error: `unsupported_prompt_template_id: ${request.prompt_template_id}`,
        intent: request.intent_hint,
        prompt_template_id: request.prompt_template_id,
        prompt_hash: request.prompt_hash,
        structured: null,
        answer: "",
        text: "",
        raw_text: "",
        failure_reason: "unsupported_prompt_template_id",
        missing_keys: [],
        retry_count: 0,
        llm_provider: request.llm_provider,
        llm_model: request.llm_model,
      },
      400,
    );
  }

  const performAttempt = async (prompt: string) => {
    const llm = await executePrompt({
      prompt,
      preferredProvider: request.llm_provider,
      requestedModel: request.llm_model,
    });
    const requiredKeys = template ? template.required_keys : request.required_structured_keys;
    const candidate = parseCandidateFromText(llm.text, requiredKeys);
    const validation = template
      ? template.validate(candidate, request)
      : request.required_structured_keys.length
        ? validateRequiredKeysObject(candidate, request.required_structured_keys)
        : candidate
          ? { ok: true as const, value: candidate, failure_reason: null, missing_keys: [], partial_structured: false }
          : { ok: false as const, value: null, failure_reason: "json_parse_failed", missing_keys: [], partial_structured: false };
    return { llm, candidate, validation };
  };

  let attempts = 0;
  let lastResult: Awaited<ReturnType<typeof performAttempt>> | null = null;
  let activePrompt = request.prompt;
  const attemptSummaries: Array<Record<string, unknown>> = [];

  while (attempts < 2) {
    attempts += 1;
    try {
      lastResult = await performAttempt(activePrompt);
    } catch (err) {
      return buildProviderFailure({
        request,
        templateIntent: template?.intent || null,
        attempts,
        err,
      });
    }
    const recommendationCount =
      Array.isArray(lastResult.candidate?.recommendations) ? lastResult.candidate.recommendations.length : 0;
    attemptSummaries.push({
      attempt: attempts,
      recommendation_count: recommendationCount,
      validator_failure_reason: lastResult.validation.failure_reason,
      missing_keys: lastResult.validation.missing_keys,
      empty_recommendations_rejected: lastResult.validation.failure_reason === "empty_recommendations_rejected",
    });
    if (lastResult.validation.ok) {
      const structured = lastResult.validation.value;
      return buildSuccess({
        ok: true,
        intent: template?.intent || request.intent_hint || "generic",
        prompt_template_id: request.prompt_template_id,
        prompt_hash: request.prompt_hash,
        structured,
        answer: JSON.stringify(structured),
        text: JSON.stringify(structured),
        raw_text: lastResult.llm.text,
        failure_reason: null,
        missing_keys: [],
        retry_count: attempts - 1,
        llm_provider: lastResult.llm.provider,
        llm_model: lastResult.llm.model,
        ...(request.debug
          ? {
              debug: {
                validator_failure_reason: null,
                missing_keys: [],
                retry_count: attempts - 1,
                provider_text_preview: lastResult.llm.text.slice(0, 500),
                attempts: attemptSummaries,
              },
            }
          : {}),
      });
    }

    if (attempts >= 2) break;
    if (template) {
      const failureReason = (
        lastResult.validation.failure_reason ?? "json_parse_failed"
      ) as TemplateValidationFailureReason;
      activePrompt = template.buildRetryPrompt({
        prompt: request.prompt,
        request,
        missing_keys: lastResult.validation.missing_keys,
        failure_reason: failureReason,
      });
      continue;
    }
    const missingKeys = lastResult.validation.missing_keys.length ? lastResult.validation.missing_keys.join(", ") : lastResult.validation.failure_reason;
    activePrompt = `${request.prompt.trim()}\n\n[SYSTEM]\nRetry. Return exactly one JSON object only. Missing or invalid fields: ${missingKeys}.\nDo not add markdown. Do not add commentary. Do not ask clarifying questions.\n[/SYSTEM]`;
  }

  const failure = lastResult;
  return buildFailure({
    ok: false,
    error: failure?.validation.failure_reason || "upstream_validation_failed",
    intent: template?.intent || request.intent_hint || "generic",
    prompt_template_id: request.prompt_template_id,
    prompt_hash: request.prompt_hash,
    structured: failure?.candidate || failure?.validation.value || null,
    answer: failure?.llm.text || "",
    text: failure?.llm.text || "",
    raw_text: failure?.llm.text || "",
    failure_reason: failure?.validation.failure_reason || "upstream_validation_failed",
    missing_keys: failure?.validation.missing_keys || [],
    retry_count: Math.max(0, attempts - 1),
    llm_provider: failure?.llm.provider || request.llm_provider,
    llm_model: failure?.llm.model || request.llm_model,
    ...(request.debug
      ? {
          debug: {
            validator_failure_reason: failure?.validation.failure_reason || "upstream_validation_failed",
            missing_keys: failure?.validation.missing_keys || [],
            retry_count: Math.max(0, attempts - 1),
            provider_text_preview: (failure?.llm.text || "").slice(0, 500),
            attempts: attemptSummaries,
            empty_recommendations_rejected:
              (failure?.validation.failure_reason || "") === "empty_recommendations_rejected",
          },
        }
      : {}),
  });
}

export function getUpstreamRouteHealth() {
  return {
    supported_templates: listSupportedTemplateIds(),
  };
}
