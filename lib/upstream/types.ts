export type SupportedProvider = "gemini" | "openai";

export type SupportedTemplateId =
  | "routine_fit_summary_v1"
  | "reco_main_v1_0"
  | "reco_alternatives_v1_0"
  | "dupe_suggest_parse"
  | "dupe_compare_parse"
  | "dupe_compare_main";

export type UpstreamTemplateId = SupportedTemplateId | null;

export type UpstreamChatRequest = {
  prompt: string;
  messages: Array<{ role: string; content: string }>;
  llm_provider: SupportedProvider | null;
  llm_model: string | null;
  intent_hint: string | null;
  disallow_clarify: boolean;
  required_structured_keys: string[];
  prompt_template_id: UpstreamTemplateId;
  prompt_hash: string | null;
  parent_trace_id: string | null;
  parent_request_id: string | null;
  anchor_product_id: string | null;
  anchor_product_url: string | null;
  debug: boolean;
};

export type TemplateValidationFailureReason =
  | "json_parse_failed"
  | "missing_required_keys"
  | "clarify_like_response"
  | "unsupported_prompt_template_id";

export type TemplateValidationResult =
  | {
      ok: true;
      value: Record<string, unknown>;
      failure_reason: null;
      missing_keys: string[];
      partial_structured: boolean;
    }
  | {
      ok: false;
      value: Record<string, unknown> | null;
      failure_reason: TemplateValidationFailureReason;
      missing_keys: string[];
      partial_structured: boolean;
    };

export type TemplateDefinition = {
  template_id: SupportedTemplateId;
  intent: string;
  required_keys: string[];
  validate: (candidate: Record<string, unknown> | null, request: UpstreamChatRequest) => TemplateValidationResult;
  buildRetryPrompt: (input: {
    prompt: string;
    request: UpstreamChatRequest;
    missing_keys: string[];
    failure_reason: TemplateValidationFailureReason;
  }) => string;
};

export type ModelExecutionResult = {
  provider: SupportedProvider;
  model: string;
  text: string;
};

export type UpstreamSuccessPayload = {
  ok: true;
  intent: string;
  prompt_template_id: string | null;
  prompt_hash: string | null;
  structured: Record<string, unknown> | null;
  answer: string;
  text: string;
  raw_text: string;
  failure_reason: null;
  missing_keys: string[];
  retry_count: number;
  llm_provider: SupportedProvider;
  llm_model: string;
  debug?: Record<string, unknown>;
};

export type UpstreamFailurePayload = {
  ok: false;
  error: string;
  intent: string | null;
  prompt_template_id: string | null;
  prompt_hash: string | null;
  structured: Record<string, unknown> | null;
  answer: string;
  text: string;
  raw_text: string;
  failure_reason: string;
  missing_keys: string[];
  retry_count: number;
  llm_provider: SupportedProvider | null;
  llm_model: string | null;
  debug?: Record<string, unknown>;
};
