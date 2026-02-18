type AnyObj = Record<string, unknown>;

function asObj(value: unknown): AnyObj | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as AnyObj;
}

export function extractDogfoodViewModel(payload: Record<string, unknown>) {
  const provenance = asObj(payload?.provenance) || {};
  const features = asObj(provenance.dogfood_features_effective) || {};
  const interleave = asObj(provenance.interleave) || {};
  return {
    dogfood_mode: Boolean(provenance.dogfood_mode),
    show_employee_feedback_controls: Boolean(features.show_employee_feedback_controls),
    async_ticket_id: typeof provenance.async_ticket_id === "string" ? provenance.async_ticket_id : "",
    lock_top_n_on_first_paint: Number.isFinite(Number(provenance.lock_top_n_on_first_paint))
      ? Math.max(0, Math.trunc(Number(provenance.lock_top_n_on_first_paint)))
      : 3,
    pipeline_version: typeof provenance.pipeline === "string" ? provenance.pipeline : "",
    models: interleave && Object.keys(interleave).length ? interleave : undefined,
  };
}
