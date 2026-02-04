import assert from "node:assert/strict";
import test from "node:test";

import { buildActiveMatchTokens, matchesAnyToken } from "../lib/aurora/active-matches.ts";

test("ACTIVE-001: Niacinamide tokens include EN + CN", () => {
  const tokens = buildActiveMatchTokens(["Niacinamide"]);
  assert.ok(tokens.includes("niacinamide"));
  assert.ok(tokens.includes("烟酰胺"));
});

test("ACTIVE-002: matchesAnyToken matches brand+name", () => {
  const tokens = buildActiveMatchTokens(["Niacinamide"]);
  assert.equal(matchesAnyToken("The Ordinary Niacinamide 10% + Zinc 1%", tokens), true);
});

