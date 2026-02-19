import { NextRequest, NextResponse } from "next/server";

function getBaseUrl() {
  const raw =
    process.env.NEXT_PUBLIC_PIVOTA_AGENT_URL?.trim() ||
    process.env.PIVOTA_AGENT_URL?.trim() ||
    "https://pivota-agent-production.up.railway.app";
  return raw.replace(/\/$/, "");
}

function sanitizeSuggestionRow(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  return {
    id: String(row.id || "").trim(),
    anchor_product_id: String(row.anchor_product_id || "").trim(),
    block: String(row.block || "").trim(),
    candidate_product_id: String(row.candidate_product_id || "").trim(),
    suggested_label: String(row.suggested_label || "").trim(),
    wrong_block_target: row.wrong_block_target ? String(row.wrong_block_target).trim() : null,
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : 0,
    rationale_user_visible: String(row.rationale_user_visible || "").trim(),
    flags: Array.isArray(row.flags) ? row.flags.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 10) : [],
    model_name: String(row.model_name || "").trim(),
    prompt_version: String(row.prompt_version || "").trim(),
    updated_at: row.updated_at || null,
  };
}

function sanitizePayload(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = { ...(raw as Record<string, unknown>) };
  delete payload.missing_info_internal;
  delete payload.internal_debug_codes;
  delete payload.input_hash;
  delete payload.llm_raw_response;
  delete payload.suggestion_debug;

  for (const block of ["competitors", "dupes", "related_products"]) {
    const blockObj = payload[block];
    if (!blockObj || typeof blockObj !== "object" || Array.isArray(blockObj)) continue;
    const nextBlock = { ...(blockObj as Record<string, unknown>) };
    const rows = Array.isArray(nextBlock.candidates) ? nextBlock.candidates : [];
    nextBlock.candidates = rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return row;
      const item = { ...(row as Record<string, unknown>) };
      delete item.ref_id;
      delete item.internal_reason_codes;
      delete item.input_hash;
      delete item.llm_raw_response;
      delete item.suggestion_debug;
      return item;
    });
    payload[block] = nextBlock;
  }
  return payload;
}

export async function GET(req: NextRequest) {
  const adminKey = String(process.env.AURORA_BFF_RECO_PRELABEL_ADMIN_KEY || "").trim();
  if (!adminKey) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  const uid = req.headers.get("x-aurora-uid") || req.headers.get("X-Aurora-UID") || "aurora_dogfood_ui";
  const search = req.nextUrl.searchParams.toString();
  const res = await fetch(`${getBaseUrl()}/internal/prelabel/suggestions${search ? `?${search}` : ""}`, {
    method: "GET",
    headers: {
      "X-Aurora-UID": uid,
      "X-Aurora-Admin-Key": adminKey,
    },
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({ ok: false, error: "UPSTREAM_INVALID_JSON" }));
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return NextResponse.json({ ok: false, error: "UPSTREAM_INVALID_JSON" }, { status: res.status });
  }
  const raw = json as Record<string, unknown>;
  return NextResponse.json(
    {
      ok: Boolean(raw.ok),
      anchor_product_id: String(raw.anchor_product_id || "").trim(),
      block: raw.block ? String(raw.block) : null,
      suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.map(sanitizeSuggestionRow).filter(Boolean) : [],
      payload: sanitizePayload(raw.payload),
      error: raw.error ? String(raw.error) : undefined,
    },
    { status: res.status },
  );
}
