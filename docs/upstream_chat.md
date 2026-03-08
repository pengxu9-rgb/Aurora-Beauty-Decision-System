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

Supported modern templates in the first pass:

- `routine_fit_summary_v1`
- `reco_main_v1_0`
- `reco_alternatives_v1_0`
- `dupe_suggest_parse`
- `dupe_compare_parse`
- `dupe_compare_main`

Unknown non-empty `prompt_template_id` values return `400 unsupported_prompt_template_id`.
