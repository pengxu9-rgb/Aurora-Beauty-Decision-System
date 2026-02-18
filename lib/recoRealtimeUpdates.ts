export type AuroraLang = "EN" | "CN";

type RecoBlockName = "competitors" | "dupes" | "related_products";

type CandidateLike = Record<string, unknown>;

function buildCandidateKey(row: CandidateLike, index: number): string {
  const productId = typeof row.product_id === "string" ? row.product_id.trim().toLowerCase() : "";
  if (productId) return productId;
  const name = typeof row.name === "string" ? row.name.trim().toLowerCase() : "";
  if (name) return name;
  const sku = typeof row.sku_id === "string" ? row.sku_id.trim().toLowerCase() : "";
  if (sku) return sku;
  return `idx_${index}`;
}

export function lockTopNOrder(currentRows: CandidateLike[], nextRows: CandidateLike[], lockTopN: number): CandidateLike[] {
  const current = Array.isArray(currentRows) ? currentRows : [];
  const next = Array.isArray(nextRows) ? nextRows : [];
  const lockN = Math.max(0, Math.min(12, Number.isFinite(Number(lockTopN)) ? Math.trunc(Number(lockTopN)) : 0));
  if (!lockN) return next.slice();

  const nextByKey = new Map<string, CandidateLike>();
  for (let i = 0; i < next.length; i += 1) {
    const key = buildCandidateKey(next[i], i);
    if (!nextByKey.has(key)) nextByKey.set(key, next[i]);
  }

  const locked = current.slice(0, lockN).map((row, idx) => {
    const key = buildCandidateKey(row, idx);
    return nextByKey.get(key) || row;
  });
  const lockedKeySet = new Set(locked.map((row, idx) => buildCandidateKey(row, idx)));

  const out: CandidateLike[] = [...locked];
  for (let i = 0; i < next.length; i += 1) {
    const row = next[i];
    const key = buildCandidateKey(row, i);
    if (lockedKeySet.has(key)) continue;
    out.push(row);
  }
  return out;
}

function getBlockCandidates(payload: Record<string, unknown>, block: RecoBlockName): CandidateLike[] {
  const blockObj = payload?.[block];
  if (!blockObj || typeof blockObj !== "object" || Array.isArray(blockObj)) return [];
  const candidates = (blockObj as Record<string, unknown>).candidates;
  return Array.isArray(candidates) ? (candidates.filter((r) => r && typeof r === "object") as CandidateLike[]) : [];
}

export function mergeRecoPayloadWithAsyncPatch(
  currentPayload: Record<string, unknown>,
  patchPayload: Record<string, unknown>,
  lockTopN: number,
) {
  const next = { ...(currentPayload || {}) } as Record<string, unknown>;
  for (const block of ["competitors", "related_products", "dupes"] as RecoBlockName[]) {
    const currentRows = getBlockCandidates(currentPayload, block);
    const patchRows = getBlockCandidates(patchPayload, block);
    if (!patchRows.length && !currentRows.length) continue;
    const mergedRows = lockTopNOrder(currentRows, patchRows, lockTopN);
    const currentBlock = currentPayload?.[block];
    const patchBlock = patchPayload?.[block];
    const fromBlock =
      patchBlock && typeof patchBlock === "object" && !Array.isArray(patchBlock)
        ? (patchBlock as Record<string, unknown>)
        : currentBlock && typeof currentBlock === "object" && !Array.isArray(currentBlock)
          ? (currentBlock as Record<string, unknown>)
          : {};
    next[block] = {
      ...fromBlock,
      candidates: mergedRows,
    };
  }
  const patchProvenance = patchPayload?.provenance;
  if (patchProvenance && typeof patchProvenance === "object" && !Array.isArray(patchProvenance)) {
    next.provenance = { ...(currentPayload?.provenance as Record<string, unknown>), ...(patchProvenance as Record<string, unknown>) };
  }
  return next;
}

export type RecoAsyncPollingOptions = {
  uid: string;
  ticketId: string;
  sinceVersion?: number;
  intervalMs?: number;
  lang?: AuroraLang;
  traceId?: string;
  briefId?: string;
  onPatch: (patchPayload: Record<string, unknown>, version: number) => void;
  onError?: (err: unknown) => void;
  requestAsyncUpdates: (params: { ticket_id: string; since_version?: number }) => Promise<{
    ok: boolean;
    version?: number;
    has_update?: boolean;
    payload_patch?: Record<string, unknown>;
  }>;
};

export function startRecoAsyncPolling(options: RecoAsyncPollingOptions) {
  const ticketId = String(options.ticketId || "").trim();
  if (!ticketId) return () => {};
  const intervalMs = Math.max(120, Math.trunc(options.intervalMs ?? 2500));
  let stopped = false;
  let sinceVersion = Math.max(0, Math.trunc(options.sinceVersion ?? 1));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const requestAsyncUpdates = options.requestAsyncUpdates;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const response = await requestAsyncUpdates({ ticket_id: ticketId, since_version: sinceVersion });
      if (response?.ok && typeof response.version === "number") {
        if (response.has_update && response.payload_patch && typeof response.payload_patch === "object") {
          options.onPatch(response.payload_patch, response.version);
        }
        sinceVersion = Math.max(sinceVersion, Math.trunc(response.version));
      }
    } catch (err) {
      options.onError?.(err);
    } finally {
      schedule();
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
