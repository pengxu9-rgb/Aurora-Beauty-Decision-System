export type RecoPrelabelBlock = "competitors" | "dupes" | "related_products";

export type RecoPrelabelSuggestion = {
  id: string;
  anchor_product_id: string;
  block: RecoPrelabelBlock;
  candidate_product_id: string;
  suggested_label: "relevant" | "not_relevant" | "wrong_block";
  wrong_block_target: RecoPrelabelBlock | null;
  confidence: number;
  rationale_user_visible: string;
  flags: string[];
  model_name?: string;
  prompt_version?: string;
  updated_at?: string | null;
};

type TriggerPrelabelInput = {
  anchor_product_id: string;
  blocks?: RecoPrelabelBlock[];
  max_candidates_per_block?: Partial<Record<RecoPrelabelBlock, number>>;
  force_refresh?: boolean;
  snapshot_payload?: Record<string, unknown>;
  request_id?: string;
  session_id?: string;
};

type TriggerPrelabelResponse = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
};

type SuggestionsResponse = {
  ok: boolean;
  anchor_product_id: string;
  block: RecoPrelabelBlock | null;
  suggestions: RecoPrelabelSuggestion[];
  payload?: Record<string, unknown> | null;
  error?: string;
};

async function parseJsonSafe(res: Response) {
  try {
    return (await res.json()) as any;
  } catch {
    return null;
  }
}

export async function triggerPrelabel(input: TriggerPrelabelInput): Promise<TriggerPrelabelResponse> {
  const res = await fetch("/api/reco/prelabel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await parseJsonSafe(res);
  if (res.ok && json) return json as TriggerPrelabelResponse;
  throw new Error((json && typeof json.error === "string" && json.error) || `trigger prelabel failed (${res.status})`);
}

export async function fetchPrelabelSuggestions(params: {
  anchor_product_id: string;
  block?: RecoPrelabelBlock;
  limit?: number;
}): Promise<SuggestionsResponse> {
  const qp = new URLSearchParams();
  qp.set("anchor_product_id", params.anchor_product_id);
  if (params.block) qp.set("block", params.block);
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    qp.set("limit", String(Math.max(1, Math.trunc(params.limit))));
  }
  const res = await fetch(`/api/reco/prelabel/suggestions?${qp.toString()}`, { method: "GET" });
  const json = await parseJsonSafe(res);
  if (res.ok && json) return json as SuggestionsResponse;
  throw new Error((json && typeof json.error === "string" && json.error) || `fetch prelabel suggestions failed (${res.status})`);
}
