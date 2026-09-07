import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { nightlyVersion, patchedInfoPlist, repackNightlyIpa } from "../nightly-ipa.js";
import { newestNightlyCandidate, nightlyCandidates, whatsNewFromReleaseBody } from "../nightly-releases.js";
import { ledgerRowSelfConsistency } from "../validate-source.js";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const plist = require("plist");

const iosAsset = (day, commit, createdAt) => ({
  name: `ARMSX2-nightly-${day}-${commit}-iOS-arm64.ipa`,
  created_at: createdAt,
});

const nightlyRelease = (day, assets, body = "") => ({
  tag_name: `nightly-${day}`,
  prerelease: true,
  draft: false,
  body,
  assets,
});

const samplePlist = {
  CFBundleIdentifier: "com.armsx2.ios",
  CFBundleDisplayName: "ARMSX2 iOS",
  CFBundleShortVersionString: "2.5.3",
  CFBundleVersion: "253",
  MinimumOSVersion: "17.0",
  UIDeviceFamily: [1, 2],
  UIRequiresFullScreen: true,
};

const buildTestIpa = (path, infoPlist) => {
  const archive = new AdmZip();
  archive.addFile("Payload/Test.app/Info.plist", Buffer.from(plist.build(infoPlist), "utf8"));
  archive.addFile("Payload/Test.app/Test", Buffer.from("executable bytes"));
  archive.addFile("Payload/Test.app/icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  archive.writeZip(path);
  return path;
};

test("nightlyVersion is fixed width and sorts by date then time", () => {
  assert.equal(nightlyVersion("2.5.3", "2026-09-07T14:43:45Z"), "2.5.3-nightly.20260907.1443");
  assert.equal(nightlyVersion("2.5.3", "2026-09-06T02:12:35Z"), "2.5.3-nightly.20260906.0212");

  const ordered = [
    nightlyVersion("2.5.3", "2026-09-06T02:12:35Z"),
    nightlyVersion("2.5.3", "2026-09-06T15:36:59Z"),
    nightlyVersion("2.5.3", "2026-09-07T14:43:45Z"),
  ];

  assert.deepEqual([...ordered].sort(), ordered, "plain text order matches chronological order");
});

test("nightlyVersion rejects an unusable publish time", () => {
  assert.throws(() => nightlyVersion("2.5.3", "not a date"), /not a usable publish time/u);
});

test("patchedInfoPlist changes the identity and nothing else", () => {
  const patched = patchedInfoPlist(samplePlist, "2.5.3-nightly.20260907.1443");

  assert.equal(patched.CFBundleIdentifier, "com.armsx2.ios.nightly");
  assert.equal(patched.CFBundleDisplayName, "ARMSX2 Nightly");
  assert.equal(patched.CFBundleShortVersionString, "2.5.3-nightly.20260907.1443");

  assert.equal(patched.CFBundleVersion, samplePlist.CFBundleVersion);
  assert.equal(patched.MinimumOSVersion, samplePlist.MinimumOSVersion);
  assert.deepEqual(patched.UIDeviceFamily, samplePlist.UIDeviceFamily);
  assert.deepEqual(Object.keys(patched).sort(), Object.keys(samplePlist).sort());
});

test("patchedInfoPlist is idempotent and refuses a foreign bundle", () => {
  const once = patchedInfoPlist(samplePlist, "2.5.3-nightly.20260907.1443");
  assert.deepEqual(patchedInfoPlist(once, "2.5.3-nightly.20260907.1443"), once);

  assert.throws(
    () => patchedInfoPlist({ ...samplePlist, CFBundleIdentifier: "com.example.other" }, "1.0"),
    /refusing to publish it as a nightly/u,
  );
});

test("repackNightlyIpa rewrites the identity and leaves every other entry alone", async (t) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "armsx2-nightly-test-"));
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));

  const sourcePath = buildTestIpa(join(workingDirectory, "source.ipa"), samplePlist);
  const targetPath = join(workingDirectory, "nightly.ipa");
  const version = "2.5.3-nightly.20260907.1443";

  await repackNightlyIpa(sourcePath, targetPath, version);

  const before = new AdmZip(sourcePath).getEntries();
  const after = new AdmZip(targetPath).getEntries();

  assert.equal(after.length, before.length);

  for (const entry of before) {
    const repacked = after.find((candidate) => candidate.entryName === entry.entryName);
    assert.ok(repacked, `${entry.entryName} survived the repack`);

    if (!entry.entryName.endsWith("Info.plist")) {
      assert.deepEqual(repacked.getData(), entry.getData(), `${entry.entryName} is byte-identical`);
    }
  }

  const infoPlist = plist.parse(
    new AdmZip(targetPath).getEntry("Payload/Test.app/Info.plist").getData().toString("utf8"),
  );

  assert.equal(infoPlist.CFBundleIdentifier, "com.armsx2.ios.nightly");
  assert.equal(infoPlist.CFBundleShortVersionString, version);
  assert.equal(infoPlist.CFBundleVersion, "253");
});

test("nightlyCandidates orders by asset time across releases", () => {
  const releases = [
    nightlyRelease("20260906", [
      iosAsset("20260906", "25e8f37281", "2026-09-06T02:12:35Z"),
      iosAsset("20260906", "a100539924", "2026-09-06T15:36:59Z"),
    ]),
    nightlyRelease("20260907", [iosAsset("20260907", "b69fbed079", "2026-09-07T14:43:45Z")]),
  ];

  const ordered = nightlyCandidates(releases).map((candidate) => candidate.commit);

  assert.deepEqual(ordered, ["b69fbed079", "a100539924", "25e8f37281"]);
});

test("nightlyCandidates ignores anything that is not an iOS nightly", () => {
  const releases = [
    nightlyRelease("20260907", [
      { name: "ARMSX2-nightly-20260907-b69fbed079-Android-arm64.apk", created_at: "2026-09-07T14:43:45Z" },
      { name: "ARMSX2-nightly-20260907-b69fbed079-macOS-arm64.tar.xz", created_at: "2026-09-07T14:43:45Z" },
    ]),
    { tag_name: "iOSv2.5.2", prerelease: false, draft: false, assets: [{ name: "ARMSX2-iOS-2.5.2.ipa", created_at: "2026-08-06T15:49:46Z" }] },
    { tag_name: "nightly-20260905", prerelease: true, draft: true, assets: [iosAsset("20260905", "6e884f11f4", "2026-09-05T12:21:20Z")] },
  ];

  assert.deepEqual(nightlyCandidates(releases), []);
  assert.equal(newestNightlyCandidate(releases), null);
});

test("newestNightlyCandidate refuses a tie it cannot break", () => {
  const releases = [nightlyRelease("20260907", [
    iosAsset("20260907", "aaaaaaaaaa", "2026-09-07T14:43:45Z"),
    iosAsset("20260907", "bbbbbbbbbb", "2026-09-07T14:43:45Z"),
  ])];

  assert.throws(() => newestNightlyCandidate(releases), /share a publish time/u);
});

test("whatsNewFromReleaseBody keeps the changelog and drops the download guide", () => {
  const body = [
    "Automated nightly build for community testing (unsigned).",
    "",
    "- macOS arm64: macOS-arm64.tar.xz",
    "- Android: Android-arm64.apk, sideload it",
    "",
    "## What's new",
    "- GameDB: fix Jak X softlocking after a profile save",
    "- iOS: the boot window was presenting a texture nothing ever wrote",
    "",
    "## Known issues",
    "- something else",
  ].join("\n");

  assert.equal(whatsNewFromReleaseBody(body), [
    "- GameDB: fix Jak X softlocking after a profile save",
    "- iOS: the boot window was presenting a texture nothing ever wrote",
  ].join("\n"));
});

test("whatsNewFromReleaseBody returns nothing when there is no section", () => {
  assert.equal(whatsNewFromReleaseBody("Automated nightly build.\n\n- macOS arm64: file"), null);
  assert.equal(whatsNewFromReleaseBody("## What's new\n\n## Next"), null);
});

const goodRow = {
  fileName: "ARMSX2-Nightly-20260907-b69fbed079.ipa",
  version: "2.5.3-nightly.20260907.1443",
  upstreamVersion: "2.5.3",
  tag: "nightly-20260907",
  commit: "b69fbed079",
  date: "2026-09-07",
  publishedAt: "2026-09-07T14:43:45Z",
};

test("a ledger row that agrees with itself passes", () => {
  assert.deepEqual(ledgerRowSelfConsistency("row", goodRow), []);
});

test("a ledger row cannot claim a version its own fields do not produce", () => {
  const errors = ledgerRowSelfConsistency("row", { ...goodRow, version: "9.9.9-nightly.20260907.1443" });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /version should be 2\.5\.3-nightly\.20260907\.1443/u);
});

test("a ledger row cannot rename its own file", () => {
  const errors = ledgerRowSelfConsistency("row", { ...goodRow, fileName: "anything-else.ipa" });

  assert.match(errors[0], /fileName should be ARMSX2-Nightly-20260907-b69fbed079\.ipa/u);
});

test("a ledger row cannot carry a made-up tag, commit or timestamp", () => {
  assert.match(ledgerRowSelfConsistency("row", { ...goodRow, tag: "iOSv2.5.2" })[0], /not an upstream nightly tag/u);
  assert.match(ledgerRowSelfConsistency("row", { ...goodRow, commit: "../../x" })[0], /not a commit hash/u);
  assert.match(ledgerRowSelfConsistency("row", { ...goodRow, publishedAt: "yesterday" })[0], /not a UTC timestamp/u);
});

test("a ledger row's date must follow its publish time", () => {
  assert.match(ledgerRowSelfConsistency("row", { ...goodRow, date: "2020-01-01" })[0], /date should be 2026-09-07/u);
});

test("whatsNewFromReleaseBody needs a real heading, and stops at the next one", () => {
  assert.equal(whatsNewFromReleaseBody("##What's new\n- a\n\n##Downloads\n- macOS"), null);
  assert.equal(whatsNewFromReleaseBody("## What's new\n- a\n\n## Downloads\n- macOS"), "- a");
  assert.equal(whatsNewFromReleaseBody("## What\u2019s new\n- a"), "- a");
});
