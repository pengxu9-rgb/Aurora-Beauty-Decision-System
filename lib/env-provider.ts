export type EnvUnitsV1 = "metric";
export type EnvProviderIdV1 = "openweather";

export type EnvHourlySpikeV1 = {
  metric: "pm2_5" | "uv_index";
  observed_at: string; // ISO timestamp
  value: number;
  threshold: number;
};

export type EnvSnapshotV1 = {
  schema_version: "aurora.env_snapshot.v1";
  source: {
    provider: EnvProviderIdV1;
    provider_version?: string;
  };
  observed_at: string; // ISO timestamp (current observation time)
  lat: number;
  lon: number;
  units: EnvUnitsV1;
  current: {
    temperature_c: number | null;
    humidity_pct: number | null;
    uv_index: number | null;
    air_quality: {
      aqi: number | null;
      components: {
        co?: number | null;
        no?: number | null;
        no2?: number | null;
        o3?: number | null;
        so2?: number | null;
        pm2_5?: number | null;
        pm10?: number | null;
        nh3?: number | null;
      };
    };
  };
  hourly_48h: Array<{
    observed_at: string; // ISO timestamp
    temperature_c: number | null;
    humidity_pct: number | null;
    uv_index: number | null;
    pm2_5_ug_m3: number | null;
  }>;
  derived: {
    uv_index_max_48h: number | null;
    pm2_5_max_48h: number | null;
    pm2_5_log_score_48h: number | null; // 0..100 (log-scaled above threshold=25)
    hourly_spikes: EnvHourlySpikeV1[];
  };
  cache: {
    status: "fresh" | "cache_hit" | "lkg_fallback";
    revalidate_s: number;
    age_s: number;
  };
  missing_inputs: string[];
};

export type EnvProviderErrorCodeV1 =
  | "missing_api_key"
  | "fetch_timeout"
  | "http_error"
  | "invalid_json"
  | "schema_invalid"
  | "unknown";

export type EnvProviderResultV1 = {
  ok: boolean;
  provider: EnvProviderIdV1;
  cache_status: EnvSnapshotV1["cache"]["status"] | "unavailable";
  snapshot: EnvSnapshotV1 | null;
  provider_error_code?: EnvProviderErrorCodeV1;
  provider_http_status?: number | null;
  provider_error_message?: string | null;
  provider_error_issues?: string[] | null;
  missing_inputs: string[];
};

export type EnvProviderMetricsV1 = {
  schema_version: "aurora.env_provider_metrics.v1";
  provider: EnvProviderIdV1;
  requests_total: number;
  cache_hits: number;
  lkg_fallbacks: number;
  upstream_fetches: number;
  upstream_successes: number;
  upstream_failures: number;
  upstream_success_rate: number; // 0..1
  upstream_failure_rate: number; // 0..1
  upstream_latency_p95_ms: number | null;
  provider_error_codes: Record<string, number>;
};

const DEFAULT_REVALIDATE_S = 3600;
const DEFAULT_TIMEOUT_MS = 4500;
const LATENCY_WINDOW_SIZE = 200;

type NextFetchInit = RequestInit & { next?: { revalidate?: number } };

function nowMs(now: Date) {
  return now.getTime();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coerceNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clamp0to100(value: number) {
  return clamp(value, 0, 100);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2;
  return sorted[mid] ?? null;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function isoFromUnixSeconds(dt: number) {
  return new Date(dt * 1000).toISOString();
}

function pickNearestUnixSeconds(map: Map<number, unknown>, target: number, maxDeltaS: number): number | null {
  if (!Number.isFinite(target)) return null;
  if (!Number.isFinite(maxDeltaS) || maxDeltaS <= 0) return null;

  let bestDt: number | null = null;
  let bestAbs = Infinity;

  for (const dt of map.keys()) {
    if (!Number.isFinite(dt)) continue;
    const abs = Math.abs(dt - target);
    if (abs < bestAbs) {
      bestAbs = abs;
      bestDt = dt;
      continue;
    }

    if (abs === bestAbs && bestDt != null) {
      // Tie-breaker: prefer the past (<= target) over the future; otherwise prefer smaller dt for stability.
      const dtIsPast = dt <= target;
      const bestIsPast = bestDt <= target;
      if (dtIsPast && !bestIsPast) {
        bestDt = dt;
      } else if (dtIsPast === bestIsPast && dt < bestDt) {
        bestDt = dt;
      }
    }
  }

  if (bestDt == null) return null;
  return bestAbs <= maxDeltaS ? bestDt : null;
}

export function scalePm25LogScore(pm2_5_ug_m3: number, threshold = 25, rangeAbove = 100): number {
  if (!Number.isFinite(pm2_5_ug_m3) || pm2_5_ug_m3 <= 0) return 0;
  const above = Math.max(0, pm2_5_ug_m3 - threshold);
  const score01 = Math.log1p(above) / Math.log1p(rangeAbove);
  return clamp0to100(score01 * 100);
}

export function detectHourlySpikesV1(input: {
  hourly: Array<{ observed_at: string; pm2_5_ug_m3: number | null; uv_index: number | null }>;
  pm2_5_threshold?: number;
  uv_index_threshold?: number;
  max_spikes?: number;
}): EnvHourlySpikeV1[] {
  const pmThreshold = typeof input.pm2_5_threshold === "number" ? input.pm2_5_threshold : 25;
  const uvThreshold = typeof input.uv_index_threshold === "number" ? input.uv_index_threshold : 7;
  const max = typeof input.max_spikes === "number" ? input.max_spikes : 6;

  const pmValues = input.hourly.map((h) => h.pm2_5_ug_m3).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const pmMed = pmValues.length >= 4 ? median(pmValues) : null;
  const pmSpikeThreshold = Math.max(pmThreshold, pmMed != null ? pmMed + 15 : pmThreshold);

  const spikes: EnvHourlySpikeV1[] = [];

  for (const h of input.hourly) {
    if (typeof h.pm2_5_ug_m3 === "number" && Number.isFinite(h.pm2_5_ug_m3) && h.pm2_5_ug_m3 >= pmSpikeThreshold) {
      spikes.push({ metric: "pm2_5", observed_at: h.observed_at, value: h.pm2_5_ug_m3, threshold: pmSpikeThreshold });
      continue;
    }

    if (typeof h.uv_index === "number" && Number.isFinite(h.uv_index) && h.uv_index >= uvThreshold) {
      spikes.push({ metric: "uv_index", observed_at: h.observed_at, value: h.uv_index, threshold: uvThreshold });
    }
  }

  return spikes.sort((a, b) => b.value - a.value).slice(0, max);
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: NextFetchInit, timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function normalizeProviderErrorCode(err: unknown): EnvProviderErrorCodeV1 {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (msg.toLowerCase().includes("abort")) return "fetch_timeout";
  return "unknown";
}

function buildCacheKey(input: { provider: EnvProviderIdV1; lat: number; lon: number; units: EnvUnitsV1 }) {
  // Normalize to reduce key explosion while keeping sufficient precision for city-level lookups.
  const latKey = Math.round(input.lat * 1000) / 1000;
  const lonKey = Math.round(input.lon * 1000) / 1000;
  return `${input.provider}:${input.units}:${latKey}:${lonKey}`;
}

type CacheEntry = {
  snapshot: Omit<EnvSnapshotV1, "cache">;
  fetched_at_ms: number;
  last_ok_at_ms: number;
};

type RuntimeDeps = {
  fetchImpl?: typeof fetch;
  now?: Date;
  revalidate_s?: number;
  timeout_ms?: number;
};

type OpenWeatherOneCall = {
  current: { dt: number; temp?: number; humidity?: number; uvi?: number };
  hourly: Array<{ dt: number; temp?: number; humidity?: number; uvi?: number }>;
};

type OpenWeatherAir = {
  list: Array<{ dt: number; main?: { aqi?: number }; components?: Record<string, unknown> }>;
};

function parseOpenWeatherOneCall(value: unknown): { ok: true; data: OpenWeatherOneCall } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!isPlainObject(value)) return { ok: false, issues: ["body must be an object"] };

  const current = (value as any).current;
  if (!isPlainObject(current)) issues.push("current must be an object");
  const currentDt = coerceNumber((current as any)?.dt);
  if (currentDt == null) issues.push("current.dt must be a number");

  const hourly = (value as any).hourly;
  if (!Array.isArray(hourly)) issues.push("hourly must be an array");
  else if (hourly.length < 1) issues.push("hourly must not be empty");
  else {
    const first = hourly[0];
    if (!isPlainObject(first)) issues.push("hourly[0] must be an object");
    else if (coerceNumber((first as any).dt) == null) issues.push("hourly[0].dt must be a number");
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, data: value as OpenWeatherOneCall };
}

function parseOpenWeatherAir(value: unknown): { ok: true; data: OpenWeatherAir } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!isPlainObject(value)) return { ok: false, issues: ["body must be an object"] };
  const list = (value as any).list;
  if (!Array.isArray(list)) issues.push("list must be an array");
  else if (list.length < 1) issues.push("list must not be empty");
  else {
    const first = list[0];
    if (!isPlainObject(first)) issues.push("list[0] must be an object");
    else if (coerceNumber((first as any).dt) == null) issues.push("list[0].dt must be a number");
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, data: value as OpenWeatherAir };
}

async function fetchJson(fetchImpl: typeof fetch, url: string, init: NextFetchInit, timeoutMs: number) {
  const res = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const bodyPreview = text.slice(0, 500);
    const err = new Error(`HTTP ${res.status}: ${bodyPreview}`);
    (err as any).code = "http_error";
    (err as any).http_status = res.status;
    (err as any).http_body_preview = bodyPreview;
    throw err;
  }

  try {
    return await res.json();
  } catch (err) {
    const e = new Error("Invalid JSON");
    (e as any).code = "invalid_json";
    throw e;
  }
}

async function fetchOpenWeatherSnapshotV1(input: {
  lat: number;
  lon: number;
  units: EnvUnitsV1;
  revalidate_s: number;
  timeout_ms: number;
  now: Date;
  fetchImpl: typeof fetch;
}): Promise<{ snapshot: Omit<EnvSnapshotV1, "cache">; missing_inputs: string[] }> {
  const apiKey = (process.env.OPENWEATHER_API_KEY ?? "").trim();
  if (!apiKey) {
    const err = new Error("Missing OPENWEATHER_API_KEY");
    (err as any).code = "missing_api_key";
    throw err;
  }

  const oneCallBase = (process.env.OPENWEATHER_ONECALL_BASE_URL ?? "https://api.openweathermap.org/data/3.0/onecall").trim().replace(/\/$/, "");
  const airForecastBase = (process.env.OPENWEATHER_AIR_FORECAST_BASE_URL ?? "https://api.openweathermap.org/data/2.5/air_pollution/forecast")
    .trim()
    .replace(/\/$/, "");

  const missing_inputs: string[] = [];

  const oneCallUrl = `${oneCallBase}?lat=${encodeURIComponent(String(input.lat))}&lon=${encodeURIComponent(String(input.lon))}&units=${encodeURIComponent(input.units)}&exclude=minutely,daily,alerts&appid=${encodeURIComponent(apiKey)}`;
  const airUrl = `${airForecastBase}?lat=${encodeURIComponent(String(input.lat))}&lon=${encodeURIComponent(String(input.lon))}&appid=${encodeURIComponent(apiKey)}`;

  const [oneCallRaw, airRaw] = await Promise.all([
    fetchJson(input.fetchImpl, oneCallUrl, { method: "GET", next: { revalidate: input.revalidate_s } }, input.timeout_ms),
    fetchJson(input.fetchImpl, airUrl, { method: "GET", next: { revalidate: input.revalidate_s } }, input.timeout_ms),
  ]);

  const oneCallParsed = parseOpenWeatherOneCall(oneCallRaw);
  if (!oneCallParsed.ok) {
    const err = new Error("OpenWeather OneCall schema invalid");
    (err as any).code = "schema_invalid";
    (err as any).issues = oneCallParsed.issues;
    throw err;
  }

  const airParsed = parseOpenWeatherAir(airRaw);
  if (!airParsed.ok) {
    const err = new Error("OpenWeather Air schema invalid");
    (err as any).code = "schema_invalid";
    (err as any).issues = airParsed.issues;
    throw err;
  }

  const oneCall = oneCallParsed.data;
  const air = airParsed.data;

  const airByDt = new Map<number, { aqi: number | null; components: Record<string, unknown> }>();
  for (const item of air.list) {
    if (!isPlainObject(item)) continue;
    const dt = coerceNumber((item as any).dt);
    if (dt == null) continue;
    const main = isPlainObject((item as any).main) ? (item as any).main : null;
    const aqi = main ? coerceNumber((main as any).aqi) : null;
    const components = isPlainObject((item as any).components) ? ((item as any).components as Record<string, unknown>) : {};
    airByDt.set(dt, { aqi: aqi == null ? null : clamp(aqi, 1, 5), components });
  }

  const currentDt = coerceNumber(oneCall.current.dt) ?? Math.floor(nowMs(input.now) / 1000);
  const currentAirExact = airByDt.get(currentDt) ?? null;
  const nearestAirDt = currentAirExact ? null : pickNearestUnixSeconds(airByDt, currentDt, 3600);
  const currentAir = currentAirExact ?? (nearestAirDt != null ? airByDt.get(nearestAirDt) ?? null : null);

  const currentTemp = coerceNumber((oneCall.current as any).temp);
  const currentHumidity = coerceNumber((oneCall.current as any).humidity);
  const currentUvi = coerceNumber((oneCall.current as any).uvi);

  if (currentUvi == null) missing_inputs.push("uv_index.current");
  if (currentAir == null) missing_inputs.push("air.current");

  const hourly = Array.isArray(oneCall.hourly) ? oneCall.hourly.slice(0, 48) : [];
  if (hourly.length < 48) missing_inputs.push("weather.hourly_48h");

  const hourly_48h = hourly
    .map((h) => {
      if (!isPlainObject(h)) return null;
      const dt = coerceNumber((h as any).dt);
      if (dt == null) return null;

      const airItem = airByDt.get(dt) ?? null;
      const pm2_5 = airItem ? coerceNumber((airItem.components as any)?.pm2_5) : null;

      return {
        observed_at: isoFromUnixSeconds(dt),
        temperature_c: coerceNumber((h as any).temp),
        humidity_pct: coerceNumber((h as any).humidity),
        uv_index: coerceNumber((h as any).uvi),
        pm2_5_ug_m3: pm2_5,
      };
    })
    .filter(Boolean) as EnvSnapshotV1["hourly_48h"];

  const uvMax = hourly_48h
    .map((h) => h.uv_index)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .reduce((acc, v) => Math.max(acc, v), -Infinity);

  const pmMax = hourly_48h
    .map((h) => h.pm2_5_ug_m3)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .reduce((acc, v) => Math.max(acc, v), -Infinity);

  const uv_index_max_48h = uvMax === -Infinity ? null : clamp0to100(uvMax);
  const pm2_5_max_48h = pmMax === -Infinity ? null : pmMax;
  const pm2_5_log_score_48h = typeof pm2_5_max_48h === "number" ? scalePm25LogScore(pm2_5_max_48h, 25, 100) : null;

  const hourly_spikes = detectHourlySpikesV1({
    hourly: hourly_48h.map((h) => ({ observed_at: h.observed_at, pm2_5_ug_m3: h.pm2_5_ug_m3, uv_index: h.uv_index })),
    pm2_5_threshold: 25,
    max_spikes: 6,
  });

  const snapshot: Omit<EnvSnapshotV1, "cache"> = {
    schema_version: "aurora.env_snapshot.v1",
    source: { provider: "openweather", provider_version: "onecall3+airpollution2.5" },
    observed_at: isoFromUnixSeconds(currentDt),
    lat: input.lat,
    lon: input.lon,
    units: input.units,
    current: {
      temperature_c: currentTemp == null ? null : currentTemp,
      humidity_pct: currentHumidity == null ? null : clamp(currentHumidity, 0, 100),
      uv_index: currentUvi == null ? null : clamp0to100(currentUvi),
      air_quality: {
        aqi: currentAir?.aqi ?? null,
        components: {
          co: coerceNumber(currentAir?.components?.co) ?? null,
          no: coerceNumber(currentAir?.components?.no) ?? null,
          no2: coerceNumber(currentAir?.components?.no2) ?? null,
          o3: coerceNumber(currentAir?.components?.o3) ?? null,
          so2: coerceNumber(currentAir?.components?.so2) ?? null,
          pm2_5: coerceNumber(currentAir?.components?.pm2_5) ?? null,
          pm10: coerceNumber(currentAir?.components?.pm10) ?? null,
          nh3: coerceNumber(currentAir?.components?.nh3) ?? null,
        },
      },
    },
    hourly_48h,
    derived: {
      uv_index_max_48h,
      pm2_5_max_48h,
      pm2_5_log_score_48h,
      hourly_spikes,
    },
    missing_inputs,
  };

  return { snapshot, missing_inputs };
}

function withCacheFields(input: {
  snapshot: Omit<EnvSnapshotV1, "cache">;
  cache: EnvSnapshotV1["cache"];
}): EnvSnapshotV1 {
  return { ...input.snapshot, cache: input.cache };
}

type ProviderMetricsState = {
  requests_total: number;
  cache_hits: number;
  lkg_fallbacks: number;
  upstream_fetches: number;
  upstream_successes: number;
  upstream_failures: number;
  upstream_latencies_ms: number[];
  provider_error_codes: Record<string, number>;
};

function createProviderMetricsState(): ProviderMetricsState {
  return {
    requests_total: 0,
    cache_hits: 0,
    lkg_fallbacks: 0,
    upstream_fetches: 0,
    upstream_successes: 0,
    upstream_failures: 0,
    upstream_latencies_ms: [],
    provider_error_codes: {},
  };
}

function bumpCounter(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

export function createEnvProviderRuntimeV1() {
  const cache = new Map<string, CacheEntry>();
  const metrics = createProviderMetricsState();

  async function getEnvSnapshot(input: { lat: number; lon: number; units?: EnvUnitsV1 } & RuntimeDeps): Promise<EnvProviderResultV1> {
    const provider: EnvProviderIdV1 = "openweather";
    const units: EnvUnitsV1 = input.units ?? "metric";
    const now = input.now ?? new Date();
    const revalidate_s = typeof input.revalidate_s === "number" ? input.revalidate_s : DEFAULT_REVALIDATE_S;
    const timeout_ms = typeof input.timeout_ms === "number" ? input.timeout_ms : DEFAULT_TIMEOUT_MS;
    const fetchImpl = input.fetchImpl ?? fetch;

    metrics.requests_total += 1;

    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon)) {
      return { ok: false, provider, cache_status: "unavailable", snapshot: null, provider_error_code: "schema_invalid", missing_inputs: ["lat/lon"] };
    }

    const key = buildCacheKey({ provider, lat: input.lat, lon: input.lon, units });
    const entry = cache.get(key) ?? null;
    const age_s = entry ? Math.max(0, Math.round((nowMs(now) - entry.fetched_at_ms) / 1000)) : 0;

    if (entry && nowMs(now) - entry.fetched_at_ms < revalidate_s * 1000) {
      metrics.cache_hits += 1;
      const snapshot = withCacheFields({
        snapshot: entry.snapshot,
        cache: { status: "cache_hit", revalidate_s, age_s },
      });
      return { ok: true, provider, cache_status: "cache_hit", snapshot, missing_inputs: [] };
    }

    metrics.upstream_fetches += 1;
    const start = nowMs(now);
    try {
      const { snapshot: rawSnapshot } = await fetchOpenWeatherSnapshotV1({
        lat: input.lat,
        lon: input.lon,
        units,
        revalidate_s,
        timeout_ms,
        now,
        fetchImpl,
      });

      const snapshot = withCacheFields({
        snapshot: rawSnapshot,
        cache: { status: "fresh", revalidate_s, age_s: 0 },
      });

      cache.set(key, { snapshot: rawSnapshot, fetched_at_ms: nowMs(now), last_ok_at_ms: nowMs(now) });
      metrics.upstream_successes += 1;
      metrics.upstream_latencies_ms.push(nowMs(now) - start);
      if (metrics.upstream_latencies_ms.length > LATENCY_WINDOW_SIZE) metrics.upstream_latencies_ms.shift();

      return { ok: true, provider, cache_status: "fresh", snapshot, missing_inputs: [] };
    } catch (err) {
      metrics.upstream_failures += 1;
      const codeFromThrown = (err as any)?.code as string | undefined;
      const provider_error_code: EnvProviderErrorCodeV1 =
        codeFromThrown === "missing_api_key" ? "missing_api_key" :
        codeFromThrown === "http_error" ? "http_error" :
        codeFromThrown === "invalid_json" ? "invalid_json" :
        codeFromThrown === "schema_invalid" ? "schema_invalid" :
        normalizeProviderErrorCode(err);
      bumpCounter(metrics.provider_error_codes, provider_error_code);

      const missing_inputs = [`env_snapshot.${provider}.${provider_error_code}`];
      const provider_http_status = typeof (err as any)?.http_status === "number" ? ((err as any).http_status as number) : null;
      const provider_error_message = err instanceof Error ? err.message : (err == null ? null : String(err));
      const provider_error_issues = Array.isArray((err as any)?.issues)
        ? ((err as any).issues as unknown[]).filter((i): i is string => typeof i === "string")
        : null;

      if (entry && entry.snapshot) {
        metrics.lkg_fallbacks += 1;
        const fallback = entry.snapshot;
        const mergedMissing = Array.from(new Set([...(fallback.missing_inputs ?? []), ...missing_inputs]));
        const snapshot = withCacheFields({
          snapshot: { ...fallback, missing_inputs: mergedMissing },
          cache: { status: "lkg_fallback", revalidate_s, age_s },
        });
        return { ok: true, provider, cache_status: "lkg_fallback", snapshot, provider_error_code, provider_http_status, provider_error_message, provider_error_issues, missing_inputs };
      }

      return { ok: false, provider, cache_status: "unavailable", snapshot: null, provider_error_code, provider_http_status, provider_error_message, provider_error_issues, missing_inputs };
    }
  }

  function getMetrics(): EnvProviderMetricsV1 {
    const p95 = percentile(metrics.upstream_latencies_ms, 95);
    const upstreamTotal = metrics.upstream_fetches;
    const successRate = upstreamTotal > 0 ? metrics.upstream_successes / upstreamTotal : 0;
    const failureRate = upstreamTotal > 0 ? metrics.upstream_failures / upstreamTotal : 0;

    return {
      schema_version: "aurora.env_provider_metrics.v1",
      provider: "openweather",
      requests_total: metrics.requests_total,
      cache_hits: metrics.cache_hits,
      lkg_fallbacks: metrics.lkg_fallbacks,
      upstream_fetches: metrics.upstream_fetches,
      upstream_successes: metrics.upstream_successes,
      upstream_failures: metrics.upstream_failures,
      upstream_success_rate: clamp(successRate, 0, 1),
      upstream_failure_rate: clamp(failureRate, 0, 1),
      upstream_latency_p95_ms: p95 == null ? null : Math.round(p95),
      provider_error_codes: { ...metrics.provider_error_codes },
    };
  }

  return { getEnvSnapshot, getMetrics };
}

const defaultRuntime = createEnvProviderRuntimeV1();

export const getEnvSnapshotV1 = defaultRuntime.getEnvSnapshot;
export const getEnvProviderMetricsV1 = defaultRuntime.getMetrics;
