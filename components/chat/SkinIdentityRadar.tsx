"use client";

import React from "react";
import {
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

type RadarDatum = { axis: string; value: number };

function clamp0to100(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export const SkinIdentityRadar = React.memo(function SkinIdentityRadar({
  hydration,
  sebum,
  sensitivity,
  resilienceScore,
}: {
  hydration: number;
  sebum: number;
  sensitivity: number;
  resilienceScore: number;
}) {
  const data: RadarDatum[] = React.useMemo(() => {
    const values = { Hydration: hydration, Sebum: sebum, Sensitivity: sensitivity, Resilience: resilienceScore };
    const out = Object.entries(values).map(([axis, v]) => ({ axis, value: clamp0to100(v) }));
    if (out.some((d) => !Number.isFinite(d.value))) {
      // eslint-disable-next-line no-console
      console.warn("[Aurora] SkinIdentityRadar: non-finite value detected; using 0 fallback.");
    }
    return out;
  }, [hydration, sebum, sensitivity, resilienceScore]);

  return (
    <div className="h-44 w-full" aria-label="Skin radar chart">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="70%">
          <PolarGrid stroke="rgba(148,163,184,0.35)" />
          <PolarAngleAxis dataKey="axis" tick={{ fontSize: 10, fill: "#475569" }} />
          <Tooltip formatter={(v) => [`${v}`, "Score"]} />
          <Radar
            dataKey="value"
            stroke="hsl(var(--aurora-accent))"
            fill="hsl(var(--aurora-accent))"
            fillOpacity={0.18}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
});

