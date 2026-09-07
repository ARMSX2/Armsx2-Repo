import { bundleIdentifier, nightlyBundleIdentifier } from "./constants.js";
import { iosReleaseVersion, looksLikeHeading, markdownToStoreText } from "./github-releases.js";
import { compactObject } from "./source-utils.js";

const retainedNews = 6;
const captionBudget = 240;

const withoutLinkLines = (releaseText) =>
  String(releaseText ?? "")
    .split("\n")
    .filter((line) => !/^https?:\/\/\S+$/u.test(line.trim()))
    .join("\n");

const looksLikeLabel = (paragraph) =>
  looksLikeHeading(paragraph)
  || (!paragraph.includes("\n") && paragraph.length < 60 && paragraph.endsWith(":"));

const caption = (releaseText, fallbackCaption) => {
  const paragraphs = markdownToStoreText(withoutLinkLines(releaseText)).split("\n\n").filter(Boolean);
  const paragraph = paragraphs.find((candidate) => !looksLikeLabel(candidate))?.replace(/\s*\n\s*/gu, " ");

  if (!paragraph) {
    return fallbackCaption;
  }

  if (paragraph.length <= captionBudget) {
    return paragraph;
  }

  const clipped = paragraph.slice(0, captionBudget);
  const lastSpace = clipped.lastIndexOf(" ");

  // An unbroken token near the start would otherwise clip the card to a word.
  return `${(lastSpace > captionBudget / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
};

const stableNewsItem = (githubRelease, version, tintColor, imageURL) => compactObject({
  title: `ARMSX2 iOS ${version}`,
  identifier: `ios-${version}`,
  caption: caption(githubRelease.body, `Release notes for ARMSX2 iOS ${version}.`),
  date: githubRelease.published_at,
  url: githubRelease.html_url,
  appID: bundleIdentifier,
  imageURL,
  tintColor,
  notify: false,
});

const nightlyNewsItem = (ledger, metadataPayload, imageURL) => {
  const [build] = ledger.builds;
  const repository = metadataPayload.releaseNotes?.upstreamRepository;

  if (!build?.publishedAt || !build.date || !repository) {
    return null;
  }

  return compactObject({
    title: `ARMSX2 Nightly ${build.date}`,
    identifier: "ios-nightly-latest",
    caption: caption(build.localizedDescription, "The latest automated build."),
    date: build.publishedAt,
    url: `https://github.com/${repository}/releases/tag/${build.tag}`,
    appID: nightlyBundleIdentifier,
    imageURL,
    tintColor: ledger.app.tintColor,
    notify: false,
  });
};

export const sourceNews = (githubReleases, ledger, metadataPayload, existingNews = [], icons = {}) => {
  // No releases means GitHub was unreachable, not that there is no history.
  if (githubReleases.length === 0) {
    return existingNews;
  }

  const stable = githubReleases
    .filter((githubRelease) => !githubRelease.prerelease && !githubRelease.draft)
    .filter((githubRelease) => githubRelease.html_url && githubRelease.published_at)
    .map((githubRelease) => ({ githubRelease, version: iosReleaseVersion(githubRelease.tag_name) }))
    .filter(({ version }) => version)
    .map(({ githubRelease, version }) => stableNewsItem(githubRelease, version, metadataPayload.app.tintColor, icons.stable));

  const nightly = nightlyNewsItem(ledger, metadataPayload, icons.nightly);
  const seen = new Set();
  const newest = [...(nightly ? [nightly] : []), ...stable]
    .filter((item) => !seen.has(item.identifier) && seen.add(item.identifier))
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, retainedNews);

  // Newest card last: the carousel is drawn back to front.
  return newest.reverse();
};
