import assert from "node:assert/strict";
import test from "node:test";

import { storeChangelog } from "../github-releases.js";
import { sourceAppPermissions } from "../ipa-metadata.js";
import { sourceNews } from "../source-news.js";

const release = (tagName, body, overrides = {}) => ({
  tag_name: tagName,
  body,
  prerelease: false,
  html_url: `https://github.com/ARMSX2/ARMSX2/releases/tag/${tagName}`,
  published_at: "2026-08-06T15:49:46Z",
  assets: [{ name: "ARMSX2-iOS-2.5.2.ipa" }],
  ...overrides,
});

const manifest = {
  version: "2.5.2",
  downloadURL: "https://ios.armsx2.net/ipas/ARMSX2-iOS-2.5.2.ipa",
  sha256: "0".repeat(64),
};

const emptyLedger = { app: {}, builds: [] };
const metadata = { app: {}, releaseNotes: { upstreamRepository: "ARMSX2/ARMSX2" } };

test("the news feed skips Android releases even when they carry an iOS build", () => {
  const news = sourceNews([release("2.6.2", "Android notes."), release("iOSv2.5.2", "Real notes.")], emptyLedger, metadata);

  assert.deepEqual(news.map((item) => item.identifier), ["ios-2.5.2"]);
});

test("the news feed accepts both iOS tag spellings", () => {
  const news = sourceNews([release("iOSv2.5.2", "a"), release("iOS-2.4.1", "b")], emptyLedger, metadata);

  assert.deepEqual(news.map((item) => item.title).sort(), ["ARMSX2 iOS 2.4.1", "ARMSX2 iOS 2.5.2"]);
});

test("a news caption skips section labels", () => {
  const [item] = sourceNews([release("iOSv2.5.2", "Fixes:\n\nThe boot window no longer stalls.")], emptyLedger, metadata);

  assert.equal(item.caption, "The boot window no longer stalls.");
});

test("the newest card is published last so the carousel opens on it", () => {
  const older = release("iOSv2.5.1", "a", { published_at: "2026-07-31T00:00:00Z" });
  const newer = release("iOSv2.5.2", "b", { published_at: "2026-08-06T00:00:00Z" });
  const news = sourceNews([older, newer], emptyLedger, metadata);

  assert.equal(news.at(-1).identifier, "ios-2.5.2");
});

test("news cards carry the app icon rather than a bare colour", () => {
  const icons = { stable: "https://ios.armsx2.net/assets/icon.png", nightly: "https://ios.armsx2.net/assets/icon-nightly.png" };
  const ledger = {
    app: { tintColor: "#954CD5" },
    builds: [{ date: "2026-09-07", publishedAt: "2026-09-07T14:43:42Z", tag: "nightly-20260907", localizedDescription: "Fixed the boot window." }],
  };

  const news = sourceNews([release("iOSv2.5.2", "Notes.")], ledger, metadata, [], icons);

  assert.equal(news.find((item) => item.appID === "com.armsx2.ios").imageURL, icons.stable);
  assert.equal(news.find((item) => item.appID === "com.armsx2.ios.nightly").imageURL, icons.nightly);
});

test("the nightly card points at its own release tag", () => {
  const ledger = {
    app: { tintColor: "#954CD5" },
    builds: [{
      date: "2026-09-07",
      publishedAt: "2026-09-07T14:43:42Z",
      tag: "nightly-20260907",
      localizedDescription: "https://example.invalid/x\nFixed the boot window.",
    }],
  };

  const nightly = sourceNews([release("iOSv2.5.2", "a")], ledger, metadata).at(-1);

  assert.equal(nightly.url, "https://github.com/ARMSX2/ARMSX2/releases/tag/nightly-20260907");
  assert.equal(nightly.caption, "Fixed the boot window.");
});

test("a stale nightly does not hold the featured slot", () => {
  const ledger = {
    app: {},
    builds: [{ date: "2026-06-01", publishedAt: "2026-06-01T00:00:00Z", tag: "nightly-20260601", localizedDescription: "Old." }],
  };
  const stable = release("iOSv2.5.2", "New.", { published_at: "2026-08-06T00:00:00Z" });

  assert.equal(sourceNews([stable], ledger, metadata).at(-1).identifier, "ios-2.5.2");
});

test("an unreachable GitHub keeps the news already published", () => {
  const published = [{ title: "ARMSX2 iOS 2.5.2", identifier: "ios-2.5.2", caption: "c", date: "2026-08-06T00:00:00Z" }];

  assert.deepEqual(sourceNews([], emptyLedger, metadata, published), published);
});

test("a changelog match ignores the macOS release of the same version", () => {
  const macOs = release("MacOSv2.5.2", "Mac notes.", { html_url: "https://github.com/ARMSX2/ARMSX2/releases/tag/MacOSv2.5.2" });
  const changelog = storeChangelog(manifest, metadata, [macOs, release("iOSv2.5.2", "iOS notes.")], new Map());

  assert.equal(changelog, "https://github.com/ARMSX2/ARMSX2/releases/tag/iOSv2.5.2\n\niOS notes.");
});

test("a release with no notes does not replace what is already published", () => {
  const published = "https://github.com/ARMSX2/ARMSX2/releases/tag/iOSv2.5.2\nReal notes.";
  const existing = new Map([[`${manifest.version}|${manifest.downloadURL}|${manifest.sha256}`, published]]);
  const changelog = storeChangelog(manifest, metadata, [release("iOSv2.5.2", "")], existing, { refreshChangelogs: true });

  assert.equal(changelog, published);
});

test("permissions are republished under the names sideloaders read", () => {
  const appPermissions = sourceAppPermissions([
    { type: "network", usageDescription: "Local network for online play." },
    { type: "motion", usageDescription: "Gyroscope camera." },
  ]);

  assert.deepEqual(appPermissions.privacy.map((entry) => entry.name), ["LocalNetwork", "Motion"]);
});

test("an unmapped permission is left out rather than published nameless", () => {
  const appPermissions = sourceAppPermissions([
    { type: "telepathy", usageDescription: "No." },
    { type: "motion", usageDescription: "Gyroscope camera." },
  ]);

  assert.deepEqual(appPermissions.privacy.map((entry) => entry.name), ["Motion"]);
  assert.equal(sourceAppPermissions([{ type: "telepathy", usageDescription: "No." }]), undefined);
});

test("the changelog opens with the release link, then the notes", () => {
  const changelog = storeChangelog(manifest, metadata, [release("iOSv2.5.2", "Frame rate cap\n\nIt caps frames.")], new Map());

  assert.equal(changelog.split("\n")[0], "https://github.com/ARMSX2/ARMSX2/releases/tag/iOSv2.5.2");
  assert.equal(changelog.split("\n")[1], "");
  assert.equal(changelog.split("\n")[2], "Frame rate cap");
});

test("notes already carrying the link are left alone", () => {
  const published = "https://github.com/ARMSX2/ARMSX2/releases/tag/iOSv2.5.2\nUnchanged.";
  const existing = new Map([[`${manifest.version}|${manifest.downloadURL}|${manifest.sha256}`, published]]);

  assert.equal(storeChangelog(manifest, metadata, [release("iOSv2.5.2", "Rewritten.")], existing), published);
});

test("notes from before the link are rewritten to carry it", () => {
  const existing = new Map([[`${manifest.version}|${manifest.downloadURL}|${manifest.sha256}`, "Updated to ARMSX2 iOS 2.5.2.\n\nOld."]]);
  const changelog = storeChangelog(manifest, metadata, [release("iOSv2.5.2", "New notes.")], existing);

  assert.equal(changelog, "https://github.com/ARMSX2/ARMSX2/releases/tag/iOSv2.5.2\n\nNew notes.");
});
