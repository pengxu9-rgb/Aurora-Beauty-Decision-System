export type AuroraLang = "EN" | "CN";

export type RecoBlockName = "competitors" | "dupes" | "related_products";

export type RecoEmployeeFeedbackPayload = {
  anchor_product_id: string;
  block: RecoBlockName;
  candidate_product_id?: string;
  candidate_name?: string;
  feedback_type: "relevant" | "not_relevant" | "wrong_block";
  wrong_block_target?: RecoBlockName;
  reason_tags?: string[];
  was_exploration_slot?: boolean;
  rank_position?: number;
  pipeline_version?: string;
  models?: string | Record<string, unknown>;
  suggestion_id?: string;
  llm_suggested_label?: "relevant" | "not_relevant" | "wrong_block";
  llm_confidence?: number;
  request_id?: string;
  session_id?: string;
  timestamp?: number;
};

export type RecoInterleaveClickPayload = {
  anchor_product_id: string;
  block: RecoBlockName;
  candidate_product_id?: string;
  candidate_name?: string;
  request_id: string;
  session_id: string;
  pipeline_version?: string;
  models?: string | Record<string, unknown>;
  category_bucket?: string;
  price_band?: string;
  timestamp?: number;
};

export const EMPLOYEE_REASON_TAGS = [
  "use_case_mismatch",
  "ingredient_mismatch",
  "price_off",
  "skin_fit_off",
  "same_brand",
  "on_page_only",
  "other",
] as const;

export type EmployeeReasonTag = (typeof EMPLOYEE_REASON_TAGS)[number];

export type RecoFeedbackReporter = {
  queueFeedback: (payload: RecoEmployeeFeedbackPayload) => void;
  sendInterleaveClick: (payload: RecoInterleaveClickPayload) => Promise<void>;
  flush: () => Promise<void>;
  dispose: () => void;
};

type ReporterOptions = {
  uid: string;
  lang?: AuroraLang;
  traceId?: string;
  briefId?: string;
  debounceMs?: number;
  sendFeedback: (payload: RecoEmployeeFeedbackPayload) => Promise<void>;
  sendClick: (payload: RecoInterleaveClickPayload) => Promise<void>;
};

function keyOf(payload: RecoEmployeeFeedbackPayload) {
  return [
    String(payload.session_id || ""),
    String(payload.request_id || ""),
    String(payload.anchor_product_id || ""),
    String(payload.block || ""),
    String(payload.candidate_product_id || payload.candidate_name || ""),
  ]
    .map((x) => x.trim().toLowerCase())
    .join("::");
}

function nowTs() {
  return Date.now();
}

export function createRecoFeedbackReporter(options: ReporterOptions): RecoFeedbackReporter {
  const debounceMs = Math.max(0, Math.trunc(options.debounceMs ?? 280));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Map<string, Promise<void>>();

  const sendFeedback = options.sendFeedback;
  const sendClick = options.sendClick;

  const queueFeedback = (payload: RecoEmployeeFeedbackPayload) => {
    const event: RecoEmployeeFeedbackPayload = {
      ...payload,
      timestamp: typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp) ? payload.timestamp : nowTs(),
      reason_tags: Array.isArray(payload.reason_tags) ? payload.reason_tags.slice(0, 12) : [],
    };
    const k = keyOf(event);
    if (!k) return;
    const prevTimer = timers.get(k);
    if (prevTimer) clearTimeout(prevTimer);
    const timer = setTimeout(() => {
      timers.delete(k);
      const task = sendFeedback(event).catch(() => {
        // Dogfood telemetry must never block UX.
      });
      inflight.set(k, task);
      void task.finally(() => inflight.delete(k));
    }, debounceMs);
    timers.set(k, timer);
  };

  const flush = async () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (!inflight.size) return;
    await Promise.allSettled(Array.from(inflight.values()));
  };

  const dispose = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    inflight.clear();
  };

  return {
    queueFeedback,
    sendInterleaveClick: async (payload) => {
      const event: RecoInterleaveClickPayload = {
        ...payload,
        timestamp: typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp) ? payload.timestamp : nowTs(),
      };
      await sendClick(event);
    },
    flush,
    dispose,
  };
}

export function parseRecoBlockName(raw: unknown): RecoBlockName | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "competitors" || v === "dupes" || v === "related_products") return v;
  return null;
}
