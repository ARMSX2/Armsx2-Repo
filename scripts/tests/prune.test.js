import assert from "node:assert/strict";
import test from "node:test";

import { prunableNightlies, publishedNightlyFileNames } from "../prune-nightly.js";

const sourceWith = (...fileNames) => ({
  apps: [
    {
      bundleIdentifier: "com.armsx2.ios",
      versions: [{ downloadURL: "https://ios.armsx2.net/ipas/ARMSX2-iOS-2.5.2.ipa" }],
    },
    {
      bundleIdentifier: "com.armsx2.ios.nightly",
      versions: fileNames.map((fileName) => ({
        downloadURL: `https://ios.armsx2.net/ipas/nightly/${fileName}`,
      })),
    },
  ],
});

test("published names come only from the nightly app", () => {
  const names = publishedNightlyFileNames(sourceWith("ARMSX2-Nightly-20260907-b69fbed079.ipa"));

  assert.deepEqual([...names], ["ARMSX2-Nightly-20260907-b69fbed079.ipa"]);
});

test("published names are empty when no nightly is listed", () => {
  assert.equal(publishedNightlyFileNames({ apps: [] }).size, 0);
  assert.equal(publishedNightlyFileNames({}).size, 0);
});

test("only unreferenced builds of ours are removed", () => {
  const published = publishedNightlyFileNames(sourceWith(
    "ARMSX2-Nightly-20260907-b69fbed079.ipa",
    "ARMSX2-Nightly-20260906-a100539924.ipa",
  ));

  const { remove, keep, unknown } = prunableNightlies([
    "ARMSX2-Nightly-20260907-b69fbed079.ipa",
    "ARMSX2-Nightly-20260906-a100539924.ipa",
    "ARMSX2-Nightly-20260901-6e1e8f0a18.ipa",
  ], published);

  assert.deepEqual(remove, ["ARMSX2-Nightly-20260901-6e1e8f0a18.ipa"]);
  assert.equal(keep.length, 2);
  assert.deepEqual(unknown, []);
});

test("an abandoned upload is removed even though it is not published", () => {
  const { remove } = prunableNightlies(
    [".ARMSX2-Nightly-20260907-b69fbed079.ipa.Ab3xY9"],
    publishedNightlyFileNames(sourceWith()),
  );

  assert.deepEqual(remove, [".ARMSX2-Nightly-20260907-b69fbed079.ipa.Ab3xY9"]);
});

test("nothing outside our own naming is ever removed", () => {
  const hostile = [
    "ARMSX2-Nightly-x/../../ARMSX2-iOS-2.5.2.ipa",
    "ARMSX2-Nightly-x/../*.ipa",
    "ARMSX2-Nightly-20260907-b69fbed079.ipa; rm -rf /",
    "ARMSX2-Nightly-*.ipa",
    "*",
    "..",
    "../apps.json",
    "ARMSX2-iOS-2.5.2.ipa",
    "index.html",
    "ARMSX2-Nightly-2026090-b69fbed079.ipa",
    "ARMSX2-Nightly-20260907-B69FBED079.ipa",
  ];

  const { remove, unknown } = prunableNightlies(hostile, publishedNightlyFileNames(sourceWith()));

  assert.deepEqual(remove, [], "no unrecognised name reaches the delete list");
  assert.equal(unknown.length, hostile.length);
});

test("a build the live source still names is never removed", () => {
  const published = publishedNightlyFileNames(sourceWith("ARMSX2-Nightly-20260907-b69fbed079.ipa"));
  const { remove, keep } = prunableNightlies(["ARMSX2-Nightly-20260907-b69fbed079.ipa"], published);

  assert.deepEqual(remove, []);
  assert.equal(keep.length, 1);
});
