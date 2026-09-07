import assert from "node:assert/strict";
import test from "node:test";

import { markdownToStoreText } from "../github-releases.js";
import { publicAssetUrl } from "../source-utils.js";

const longParagraph = (label) => `${label} ${"word ".repeat(200)}`.trim();

test("markdownToStoreText strips markdown the store cannot render", () => {
  const storeText = markdownToStoreText([
    "## What's new",
    "",
    "**Bold heading**",
    "",
    "Fixed a crash in `GSDeviceMTL` and [the boot path](https://example.invalid/x).",
    "",
    "* first",
    "* second",
  ].join("\n"));

  assert.equal(storeText, [
    "What's new",
    "",
    "Bold heading",
    "",
    "Fixed a crash in GSDeviceMTL and the boot path.",
    "",
    "- first",
    "- second",
  ].join("\n"));
});

test("markdownToStoreText drops the trailing compare link", () => {
  const storeText = markdownToStoreText("Notes\n\nFull changelog: https://example.invalid/compare");

  assert.equal(storeText, "Notes");
});

test("markdownToStoreText keeps whole paragraphs and marks a cut", () => {
  const storeText = markdownToStoreText([
    longParagraph("first"),
    longParagraph("second"),
    longParagraph("third"),
  ].join("\n\n"));

  assert.ok(storeText.endsWith("\n\n…"), "a truncated description ends with an ellipsis");
  assert.ok(storeText.includes(longParagraph("first")), "kept paragraphs are kept whole");
  assert.ok(!storeText.includes("third"), "paragraphs past the budget are dropped");
  assert.ok(storeText.length <= 2100);
});

test("markdownToStoreText does not end on a heading whose section was cut", () => {
  const storeText = markdownToStoreText([
    longParagraph("body"),
    "Sprite hacks",
    longParagraph("detail"),
  ].join("\n\n"));

  assert.ok(!storeText.includes("Sprite hacks"), "an orphaned heading is dropped with its section");
});

test("markdownToStoreText leaves a short description alone", () => {
  const storeText = markdownToStoreText("One line.\n\nTwo lines.");

  assert.equal(storeText, "One line.\n\nTwo lines.");
  assert.ok(!storeText.includes("…"));
});

test("publicAssetUrl keeps the base path and encodes each segment", () => {
  assert.equal(
    publicAssetUrl("https://ios.armsx2.net", "ipas/ARMSX2-iOS-2.5.2.ipa"),
    "https://ios.armsx2.net/ipas/ARMSX2-iOS-2.5.2.ipa",
  );
  assert.equal(
    publicAssetUrl("https://example.invalid/nested", "assets/one two.png"),
    "https://example.invalid/nested/assets/one%20two.png",
  );
});
