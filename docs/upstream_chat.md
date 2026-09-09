# Aurora Chat Endpoints

This service now has two distinct chat entrypoints.

## Public facade

- Path: `/api/chat`
- Audience: browser/client traffic
- Behavior:
  - proxies public chat requests toward the BFF when proxy mode is enabled
  - returns a conservative public fallback when proxy mode is disabled
  - rejects machine upstream payloads with `400 wrong_endpoint`

`/api/chat` is not the decision-core endpoint anymore.

## Machine upstream

- Path: `/api/upstream/chat`
- Audience: `PIVOTA-Agent` and other machine callers
- Behavior:
  - treats `query` as a fully constructed upstream prompt
  - supports `prompt_template_id`, `required_structured_keys`, `intent_hint`, trace headers, and retry/validation
  - never runs the public proxy prelude

Supported templates, as of `reco_main_v1_3`:

- `routine_fit_summary_v1`
- `reco_main_v1_0`
- `reco_main_v1_2`
- `reco_main_v1_3`
- `reco_alternatives_v1_0`
- `reco_alternatives_hybrid_v1`
- `dupe_suggest_parse`
- `dupe_compare_parse`
- `dupe_compare_main`

Unknown non-empty `prompt_template_id` values return `400 unsupported_prompt_template_id`.

**This list is a copy, and it has been wrong before.** The authority is `TEMPLATE_MAP` in
`lib/upstream/templates.ts`, exposed at runtime by `listSupportedTemplateIds()` — query that rather
than trusting this page. It went stale after `reco_main_v1_2` and `reco_alternatives_hybrid_v1` were
registered, still ending at `reco_main_v1_0`, while sitting directly above the sentence saying unknown
ids 400.

**A prompt template is a contract with THIS service, not a file in the gateway.** An id the gateway
sends but this registry does not hold answers `400` on every call, and the caller does not see an
error — the reco lane falls back to its catalog path and returns plausible products, so latency
(~6s with the LLM leg, ~2.5s without) is the only tell. That has happened twice: `reco_main_v1_2`
(2026-08-19) and `reco_main_v1_3` (2026-09-09). **Register the id here and deploy this service before
pointing the gateway at a new prompt.**
