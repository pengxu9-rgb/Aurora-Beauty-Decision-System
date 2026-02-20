import { NextRequest, NextResponse } from "next/server";

function getBaseUrl() {
  const raw =
    process.env.PIVOTA_AGENT_URL?.trim() ||
    process.env.NEXT_PUBLIC_PIVOTA_AGENT_URL?.trim() ||
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

function sanitizePrelabelData(rawData: unknown) {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) return null;
  const raw = rawData as Record<string, unknown>;
  const byBlockRaw =
    raw.suggestions_by_block && typeof raw.suggestions_by_block === "object" && !Array.isArray(raw.suggestions_by_block)
      ? (raw.suggestions_by_block as Record<string, unknown>)
      : {};
  const suggestions_by_block = {
    competitors: Array.isArray(byBlockRaw.competitors) ? byBlockRaw.competitors.map(sanitizeSuggestionRow).filter(Boolean) : [],
    dupes: Array.isArray(byBlockRaw.dupes) ? byBlockRaw.dupes.map(sanitizeSuggestionRow).filter(Boolean) : [],
    related_products: Array.isArray(byBlockRaw.related_products)
      ? byBlockRaw.related_products.map(sanitizeSuggestionRow).filter(Boolean)
      : [],
  };
  return {
    ok: true,
    anchor_product_id: String(raw.anchor_product_id || "").trim(),
    model_name: String(raw.model_name || "").trim(),
    prompt_version: String(raw.prompt_version || "").trim(),
    generated_count: Number(raw.generated_count || 0),
    cache_hit_count: Number(raw.cache_hit_count || 0),
    candidates_total: Number(raw.candidates_total || 0),
    requested_by_block:
      raw.requested_by_block && typeof raw.requested_by_block === "object" && !Array.isArray(raw.requested_by_block)
        ? raw.requested_by_block
        : {},
    generated_by_block:
      raw.generated_by_block && typeof raw.generated_by_block === "object" && !Array.isArray(raw.generated_by_block)
        ? raw.generated_by_block
        : {},
    invalid_json_by_block:
      raw.invalid_json_by_block && typeof raw.invalid_json_by_block === "object" && !Array.isArray(raw.invalid_json_by_block)
        ? raw.invalid_json_by_block
        : {},
    suggestions_by_block,
    errors: Array.isArray(raw.errors) ? raw.errors.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 40) : [],
  };
}

export async function POST(req: NextRequest) {
  const adminKey = String(process.env.AURORA_BFF_RECO_PRELABEL_ADMIN_KEY || "").trim();
  if (!adminKey) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const uid = req.headers.get("x-aurora-uid") || req.headers.get("X-Aurora-UID") || "aurora_dogfood_ui";
  const res = await fetch(`${getBaseUrl()}/internal/prelabel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Aurora-UID": uid,
      "X-Aurora-Admin-Key": adminKey,
    },
    body: JSON.stringify(body || {}),
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
      data: sanitizePrelabelData(raw.data),
      error: raw.error ? String(raw.error) : undefined,
    },
    { status: res.status },
  );
}
