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

import { normalizeRadarSeriesV1 } from "@/lib/ui-contracts";

export const SkinIdentityRadar = React.memo(function SkinIdentityRadar({
  ariaLabel,
  ...props
}: (
  | { hydration: number; sebum: number; sensitivity: number; resilienceScore: number; radar?: undefined }
  | { radar: Array<{ axis: string; value: unknown }>; hydration?: undefined; sebum?: undefined; sensitivity?: undefined; resilienceScore?: undefined }
) & {
  ariaLabel?: string;
}) {
  const rawRadar =
    "radar" in props
      ? props.radar
      : [
          { axis: "Hydration", value: props.hydration },
          { axis: "Sebum", value: props.sebum },
          { axis: "Sensitivity", value: props.sensitivity },
          { axis: "Resilience", value: props.resilienceScore },
        ];
  const { radar: data, didWarn } = normalizeRadarSeriesV1(rawRadar);

  React.useEffect(() => {
    if (!didWarn) return;
    // eslint-disable-next-line no-console
    console.warn("[Aurora] Radar: non-finite value detected; clamped to 0.");
  }, [didWarn]);

  if (data.length === 0) {
    return <div className="h-44 w-full rounded-xl border border-slate-200 bg-slate-50" aria-label={ariaLabel ?? "Radar chart placeholder"} />;
  }

  return (
    <div className="h-44 w-full" role="img" aria-label={ariaLabel ?? "Skin radar chart"}>
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
