import assert from "node:assert/strict";
import test from "node:test";

import {
  ledgerNightlyFileNames,
  prunableNightlies,
  publishedNightlyFileNames,
  retainedNightlyFileNames,
} from "../prune-nightly.js";

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

test("a build the ledger names survives a live document that has not caught up", () => {
  const uploaded = "ARMSX2-Nightly-20260907-b69fbed079.ipa";
  const ledger = { builds: [{ fileName: uploaded }] };

  // What the first mirror actually saw: uploaded, committed, and the deploy
  // that would publish it had not run yet.
  const { remove, keep } = prunableNightlies([uploaded], retainedNightlyFileNames(sourceWith(), ledger));

  assert.deepEqual(remove, [], "the build just uploaded is never pruned");
  assert.deepEqual(keep, [uploaded]);
});

test("a build the live document still names survives the ledger dropping it", () => {
  const retired = "ARMSX2-Nightly-20260901-aaaaaaa.ipa";
  const kept = retainedNightlyFileNames(sourceWith(retired), { builds: [] });

  assert.deepEqual(prunableNightlies([retired], kept).remove, []);
});

test("a build neither the ledger nor the live document names is pruned", () => {
  const gone = "ARMSX2-Nightly-20260820-bbbbbbb.ipa";
  const kept = retainedNightlyFileNames(sourceWith(), { builds: [] });

  assert.deepEqual(prunableNightlies([gone], kept).remove, [gone]);
});

test("ledger names ignore rows without a file name", () => {
  assert.equal(ledgerNightlyFileNames({ builds: [{}, { fileName: "" }] }).size, 0);
  assert.equal(ledgerNightlyFileNames({}).size, 0);
});
