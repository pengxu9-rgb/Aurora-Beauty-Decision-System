import assert from "node:assert/strict";
import test from "node:test";

import { inferKbCanonicalKeyFromSnippet } from "../lib/kb-canonical.ts";

test("KB-001: infer usage for warning/caution-like fields", () => {
  const base = { metadata: {} } as const;
  assert.equal(inferKbCanonicalKeyFromSnippet({ ...base, field: "warnings" }), "usage");
  assert.equal(inferKbCanonicalKeyFromSnippet({ ...base, field: "Warning" }), "usage");
  assert.equal(inferKbCanonicalKeyFromSnippet({ ...base, field: "Caution" }), "usage");
  assert.equal(inferKbCanonicalKeyFromSnippet({ ...base, field: "注意事项" }), "usage");
  assert.equal(inferKbCanonicalKeyFromSnippet({ ...base, field: "警示" }), "usage");
  assert.equal(inferKbCanonicalKeyFromSnippet({ ...base, field: "警告" }), "usage");
});

