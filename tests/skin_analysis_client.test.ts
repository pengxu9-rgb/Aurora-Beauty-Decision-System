import assert from "node:assert/strict";
import test from "node:test";

import {
  PHOTO_UPLOAD_TIMEOUT_MS,
  SKIN_ANALYSIS_TIMEOUT_MS,
  isAbortLikeError,
  photoUploadTemporaryIssueMessage,
  skinAnalysisTemporaryIssueMessage,
} from "../lib/skinAnalysisClient.ts";

test("skin analysis client exposes separate upload and analysis budgets", () => {
  assert.equal(PHOTO_UPLOAD_TIMEOUT_MS, 45000);
  assert.equal(SKIN_ANALYSIS_TIMEOUT_MS, 55000);
  assert.ok(SKIN_ANALYSIS_TIMEOUT_MS > PHOTO_UPLOAD_TIMEOUT_MS);
});

test("skin analysis client returns friendly localized messages", () => {
  assert.equal(photoUploadTemporaryIssueMessage("EN"), "Photo upload encountered a temporary issue — please retry");
  assert.equal(photoUploadTemporaryIssueMessage("CN"), "照片上传暂时遇到问题，请重试");
  assert.equal(skinAnalysisTemporaryIssueMessage("EN"), "Skin analysis encountered a temporary issue — please retry");
  assert.equal(skinAnalysisTemporaryIssueMessage("CN"), "皮肤分析暂时遇到问题，请重试");
});

test("skin analysis client detects abort-like errors", () => {
  assert.equal(isAbortLikeError({ name: "AbortError" }), true);
  assert.equal(isAbortLikeError(new Error("boom")), false);
});
