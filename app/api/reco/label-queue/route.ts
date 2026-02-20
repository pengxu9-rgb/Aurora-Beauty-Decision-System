import { NextRequest, NextResponse } from "next/server";

function getBaseUrl() {
  const raw =
    process.env.PIVOTA_AGENT_URL?.trim() ||
    process.env.NEXT_PUBLIC_PIVOTA_AGENT_URL?.trim() ||
    "https://pivota-agent-production.up.railway.app";
  return raw.replace(/\/$/, "");
}

function sanitizeQueueItem(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  return {
    suggestion_id: String(row.suggestion_id || "").trim(),
    anchor_product_id: String(row.anchor_product_id || "").trim(),
    block: String(row.block || "").trim(),
    candidate_product_id: String(row.candidate_product_id || "").trim(),
    suggested_label: String(row.suggested_label || "").trim(),
    wrong_block_target: row.wrong_block_target ? String(row.wrong_block_target).trim() : null,
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : 0,
    rationale_user_visible: String(row.rationale_user_visible || "").trim(),
    flags: Array.isArray(row.flags) ? row.flags.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 10) : [],
    priority_score: Number.isFinite(Number(row.priority_score)) ? Number(row.priority_score) : 0,
    review_url: row.review_url ? String(row.review_url).trim() : undefined,
    updated_at: row.updated_at || null,
  };
}

export async function GET(req: NextRequest) {
  const adminKey = String(process.env.AURORA_BFF_RECO_PRELABEL_ADMIN_KEY || "").trim();
  if (!adminKey) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  const uid = req.headers.get("x-aurora-uid") || req.headers.get("X-Aurora-UID") || "aurora_dogfood_ui";
  const search = req.nextUrl.searchParams.toString();
  const res = await fetch(`${getBaseUrl()}/internal/label-queue${search ? `?${search}` : ""}`, {
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
      items: Array.isArray(raw.items) ? raw.items.map(sanitizeQueueItem).filter(Boolean) : [],
      error: raw.error ? String(raw.error) : undefined,
    },
    { status: res.status },
  );
}
