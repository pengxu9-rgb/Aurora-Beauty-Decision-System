import type { RecoPrelabelBlock, RecoPrelabelSuggestion } from "@/lib/recoPrelabelClient";

export type RecoLabelQueueItem = {
  suggestion_id: string;
  anchor_product_id: string;
  block: RecoPrelabelBlock;
  candidate_product_id: string;
  suggested_label: "relevant" | "not_relevant" | "wrong_block";
  wrong_block_target: RecoPrelabelBlock | null;
  confidence: number;
  rationale_user_visible: string;
  flags: string[];
  priority_score: number;
  review_url?: string;
  updated_at?: string | null;
};

type QueueResponse = {
  ok: boolean;
  items: RecoLabelQueueItem[];
  error?: string;
};

async function parseJsonSafe(res: Response) {
  try {
    return (await res.json()) as any;
  } catch {
    return null;
  }
}

export function buildLabelQueueQuery(params: {
  block?: RecoPrelabelBlock;
  limit?: number;
  anchor_product_id?: string;
  low_confidence?: boolean;
  wrong_block_only?: boolean;
  exploration_only?: boolean;
  missing_info_only?: boolean;
}) {
  const qp = new URLSearchParams();
  if (params.block) qp.set("block", params.block);
  if (params.anchor_product_id) qp.set("anchor_product_id", params.anchor_product_id);
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) qp.set("limit", String(Math.max(1, Math.trunc(params.limit))));
  if (params.low_confidence) qp.set("low_confidence", "true");
  if (params.wrong_block_only) qp.set("wrong_block_only", "true");
  if (params.exploration_only) qp.set("exploration_only", "true");
  if (params.missing_info_only) qp.set("missing_info_only", "true");
  return qp.toString();
}

export async function fetchLabelQueue(params: {
  block?: RecoPrelabelBlock;
  limit?: number;
  anchor_product_id?: string;
  low_confidence?: boolean;
  wrong_block_only?: boolean;
  exploration_only?: boolean;
  missing_info_only?: boolean;
}): Promise<QueueResponse> {
  const query = buildLabelQueueQuery(params);
  const res = await fetch(`/api/reco/label-queue?${query}`, { method: "GET" });
  const json = await parseJsonSafe(res);
  if (res.ok && json) return json as QueueResponse;
  throw new Error((json && typeof json.error === "string" && json.error) || `fetch label queue failed (${res.status})`);
}

export type { RecoPrelabelSuggestion };
