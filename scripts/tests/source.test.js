import assert from "node:assert/strict";
import test from "node:test";

import { markdownToStoreText, storeTextBudget } from "../github-releases.js";
import { publicAssetUrl } from "../source-utils.js";

// Sized from the budget, so moving the budget does not quietly stop these
// from testing the boundary they are about.
const filler = (word, fraction) =>
  `${word} `.repeat(Math.ceil((storeTextBudget * fraction) / (word.length + 1))).trim();

const longParagraph = (label) => `${label} ${filler("word", 0.6)}`.trim();

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
  assert.ok(storeText.length <= storeTextBudget + 100);
});

test("markdownToStoreText does not end on a heading whose section was cut", () => {
  const storeText = markdownToStoreText([
    longParagraph("body"),
    "Sprite hacks",
    longParagraph("detail"),
  ].join("\n\n"));

  assert.ok(!storeText.includes("Sprite hacks"), "an orphaned heading is dropped with its section");
});

test("markdownToStoreText still says something when the first paragraph is oversized", () => {
  const storeText = markdownToStoreText(`Sentence one is here. ${filler("word", 1.2)}`);

  assert.ok(storeText.length > storeTextBudget / 2, "a long opening paragraph is trimmed, not thrown away");
  assert.ok(storeText.endsWith("\n\n…"));
  assert.ok(!storeText.includes("  "), "the cut lands on a word boundary");
});

test("markdownToStoreText does not mistake a short bullet for a heading", () => {
  const storeText = markdownToStoreText([
    filler("word", 0.9),
    "- Fix audio crackle",
    "- Faster VU1",
    filler("tail", 0.5),
  ].join("\n\n"));

  assert.ok(storeText.endsWith("\n\n…"), "the oversized tail was cut");
  assert.ok(storeText.includes("- Fix audio crackle"));
  assert.ok(storeText.includes("- Faster VU1"));
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
