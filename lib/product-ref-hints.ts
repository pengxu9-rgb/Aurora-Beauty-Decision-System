type SourceHint = {
  sourceSystem: string;
  sourceType: string;
};

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function looksLikeCandidateId(value: string): boolean {
  return /^[a-f0-9]{8,32}$/i.test(value);
}

export function inferSourceHintFromProductRef(value: string): SourceHint | null {
  const ref = String(value ?? "").trim();
  if (!ref) return null;

  if (/^ext_[a-z0-9]+$/i.test(ref)) {
    return { sourceSystem: "pivota", sourceType: "external_product_id" };
  }

  if (/^eps_[a-z0-9]+$/i.test(ref)) {
    return { sourceSystem: "pivota", sourceType: "external_seed_id" };
  }

  if (looksLikeUrl(ref)) {
    return { sourceSystem: "merchant", sourceType: "canonical_url" };
  }

  if (looksLikeCandidateId(ref)) {
    return { sourceSystem: "harvester", sourceType: "candidate_id" };
  }

  return null;
}
