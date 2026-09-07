import { UpstreamSyncError } from "./errors.js";

export const nightlyTagPattern = /^nightly-\d{8}$/u;
export const nightlyAssetPattern = /^ARMSX2-nightly-(\d{8})-([0-9a-f]{7,40})-iOS-arm64\.ipa$/iu;

export const isNightlyRelease = (release) =>
  Boolean(release?.prerelease) && !release.draft && nightlyTagPattern.test(release.tag_name ?? "");

// A single nightly tag can carry several iOS builds from different commits the
// same day, so the newest build is found by asset time, not by release.
export const nightlyCandidates = (releases) =>
  (releases ?? [])
    .filter(isNightlyRelease)
    .flatMap((release) => (release.assets ?? [])
      .filter((asset) => nightlyAssetPattern.test(asset.name))
      .map((asset) => ({
        asset,
        tag: release.tag_name,
        htmlUrl: release.html_url ?? null,
        body: release.body ?? "",
        commit: asset.name.match(nightlyAssetPattern)[2].toLowerCase(),
        publishedAt: asset.created_at,
      })))
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));

export const newestNightlyCandidate = (releases) => {
  const [newest, runnerUp] = nightlyCandidates(releases);

  if (!newest) {
    return null;
  }

  if (runnerUp && runnerUp.publishedAt === newest.publishedAt) {
    throw new UpstreamSyncError(
      `Two nightly assets share a publish time: ${newest.asset.name}, ${runnerUp.asset.name}.`,
    );
  }

  return newest;
};

// The nightly release body opens with a per-platform download guide that is
// useless in a store listing. Only the changelog section is worth publishing.
export const whatsNewFromReleaseBody = (releaseBody) => {
  const lines = String(releaseBody).replace(/\r\n?/gu, "\n").split("\n");
  const start = lines.findIndex((line) => /^#{1,6}[ \t]+What['\u2019]?s new[ \t]*$/iu.test(line));

  if (start === -1) {
    return null;
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}[ \t]+\S/u.test(line));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();

  return section || null;
};
