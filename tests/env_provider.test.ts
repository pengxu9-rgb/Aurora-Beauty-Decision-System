import assert from "node:assert/strict";
import test from "node:test";

import { createEnvProviderRuntimeV1, detectHourlySpikesV1, scalePm25LogScore } from "../lib/env-provider.ts";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function buildOneCall48h(dt0 = 1700000000) {
  return {
    current: { dt: dt0, temp: 20, humidity: 55, uvi: 5 },
    hourly: Array.from({ length: 48 }, (_, i) => ({ dt: dt0 + i * 3600, temp: 20 + i * 0.1, humidity: 55, uvi: i < 12 ? 0 : 6 })),
  };
}

function buildAir48h(dt0 = 1700000000, pm2_5 = 18) {
  return {
    list: Array.from({ length: 48 }, (_, i) => ({
      dt: dt0 + i * 3600,
      main: { aqi: 2 },
      components: { pm2_5, pm10: pm2_5 * 1.2, o3: 20, no2: 10 },
    })),
  };
}

test("EnvProvider: hourly spike detection (PM2.5 threshold + UV)", () => {
  const spikes = detectHourlySpikesV1({
    hourly: [
      { observed_at: "2026-02-01T00:00:00.000Z", pm2_5_ug_m3: 10, uv_index: 0 },
      { observed_at: "2026-02-01T01:00:00.000Z", pm2_5_ug_m3: 12, uv_index: 0 },
      { observed_at: "2026-02-01T02:00:00.000Z", pm2_5_ug_m3: 11, uv_index: 8 },
      { observed_at: "2026-02-01T03:00:00.000Z", pm2_5_ug_m3: 80, uv_index: 0 },
      { observed_at: "2026-02-01T04:00:00.000Z", pm2_5_ug_m3: 9, uv_index: 0 },
    ],
    pm2_5_threshold: 25,
    uv_index_threshold: 7,
  });

  assert.ok(
    spikes.some((s) => s.metric === "pm2_5" && s.value === 80 && s.threshold >= 25),
  );
  assert.ok(spikes.some((s) => s.metric === "uv_index" && s.value === 8 && s.threshold === 7));
});

test("EnvProvider: pm2_5 log score is bounded 0..100 and increases above threshold", () => {
  const low = scalePm25LogScore(10, 25, 100);
  const mid = scalePm25LogScore(25, 25, 100);
  const high = scalePm25LogScore(80, 25, 100);
  assert.ok(low >= 0 && low <= 100);
  assert.ok(mid >= 0 && mid <= 100);
  assert.ok(high >= 0 && high <= 100);
  assert.ok(low <= mid);
  assert.ok(mid <= high);
});

test("EnvProvider: schema invalid => ok=false + provider_error_code=schema_invalid", async () => {
  const prev = process.env.OPENWEATHER_API_KEY;
  process.env.OPENWEATHER_API_KEY = "test";

  try {
    const runtime = createEnvProviderRuntimeV1();
    const fetchImpl = async (url: any) => {
      const u = String(url);
      if (u.includes("onecall")) {
        return jsonResponse({ current: { temp: 20 }, hourly: [] }); // invalid: missing dt + empty hourly
      }
      if (u.includes("air_pollution")) {
        return jsonResponse({ list: [{ dt: 1700000000, main: { aqi: 2 }, components: { pm2_5: 20 } }] });
      }
      return jsonResponse({ error: "unknown" }, 404);
    };

    const res = await runtime.getEnvSnapshot({ lat: 1, lon: 2, fetchImpl, revalidate_s: 0, timeout_ms: 50, now: new Date("2026-02-03T00:00:00.000Z") });
    assert.equal(res.ok, false);
    assert.equal(res.snapshot, null);
    assert.equal(res.provider_error_code, "schema_invalid");
    assert.ok(res.missing_inputs.some((s) => s.includes("schema_invalid")));
  } finally {
    process.env.OPENWEATHER_API_KEY = prev;
  }
});

test("EnvProvider: timeout => ok=false + provider_error_code=fetch_timeout", async () => {
  const prev = process.env.OPENWEATHER_API_KEY;
  process.env.OPENWEATHER_API_KEY = "test";

  try {
    const runtime = createEnvProviderRuntimeV1();
    const fetchImpl = (_url: any, init?: any) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as any)?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as any).name = "AbortError";
            reject(err);
          });
        }
      });

    const res = await runtime.getEnvSnapshot({ lat: 1, lon: 2, fetchImpl: fetchImpl as any, revalidate_s: 0, timeout_ms: 5, now: new Date("2026-02-03T00:00:00.000Z") });
    assert.equal(res.ok, false);
    assert.equal(res.snapshot, null);
    assert.equal(res.provider_error_code, "fetch_timeout");
  } finally {
    process.env.OPENWEATHER_API_KEY = prev;
  }
});

test("EnvProvider: LKG fallback on upstream http_error", async () => {
  const prev = process.env.OPENWEATHER_API_KEY;
  process.env.OPENWEATHER_API_KEY = "test";

  try {
    const runtime = createEnvProviderRuntimeV1();
    let call = 0;
    const dt0 = 1700000000;

    const fetchImpl = async (url: any) => {
      call += 1;
      const u = String(url);

      // First snapshot: 2 calls (onecall + air) => succeed
      if (call <= 2) {
        if (u.includes("onecall")) return jsonResponse(buildOneCall48h(dt0));
        if (u.includes("air_pollution")) return jsonResponse(buildAir48h(dt0, 30));
      }

      // Second snapshot: fail
      return new Response("upstream down", { status: 502, headers: { "Content-Type": "text/plain" } });
    };

    const first = await runtime.getEnvSnapshot({ lat: 1, lon: 2, fetchImpl, revalidate_s: 0, timeout_ms: 50, now: new Date("2026-02-03T00:00:00.000Z") });
    assert.equal(first.ok, true);
    assert.ok(first.snapshot);
    assert.equal(first.snapshot?.cache.status, "fresh");

    const second = await runtime.getEnvSnapshot({ lat: 1, lon: 2, fetchImpl, revalidate_s: 0, timeout_ms: 50, now: new Date("2026-02-03T00:05:00.000Z") });
    assert.equal(second.ok, true);
    assert.ok(second.snapshot);
    assert.equal(second.cache_status, "lkg_fallback");
    assert.equal(second.snapshot?.cache.status, "lkg_fallback");
    assert.equal(second.provider_error_code, "http_error");
    assert.ok((second.snapshot?.missing_inputs ?? []).some((s) => s.includes("http_error")));

    const metrics = runtime.getMetrics();
    assert.equal(metrics.provider, "openweather");
    assert.ok(metrics.requests_total >= 2);
    assert.ok(metrics.lkg_fallbacks >= 1);
    assert.ok((metrics.provider_error_codes["http_error"] ?? 0) >= 1);
    assert.ok(metrics.upstream_latency_p95_ms != null);
  } finally {
    process.env.OPENWEATHER_API_KEY = prev;
  }
});
