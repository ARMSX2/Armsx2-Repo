import { resolve } from "node:path";

import { SourceGenerationError } from "./errors.js";
import { optionalJsonDocument } from "./source-utils.js";

const releaseRepository = (generatorOptions, metadataPayload) =>
  generatorOptions.upstreamReleaseRepo
    ?? metadataPayload.releaseNotes.upstreamRepository
    ?? null;

const validReleaseRepository = (repositoryName) =>
  typeof repositoryName === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryName);

const githubHeaders = () => {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "J1coding-ARMSX2-Source-Generator/2.1",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
};

export const fetchGithubReleases = async (generatorOptions, metadataPayload) => {
  const repositoryName = releaseRepository(generatorOptions, metadataPayload);

  if (generatorOptions.offline || !repositoryName) {
    return [];
  }

  if (!validReleaseRepository(repositoryName)) {
    throw new SourceGenerationError(`Invalid upstream release repository: ${repositoryName}`);
  }

  try {
    const releaseResponse = await fetch(`https://api.github.com/repos/${repositoryName}/releases?per_page=100`, {
      headers: githubHeaders(),
    });

    if (!releaseResponse.ok) {
      console.warn(
        `GitHub release lookup for ${repositoryName} failed: ${releaseResponse.status} ${releaseResponse.statusText}`,
      );
      return [];
    }

    const releasePayload = await releaseResponse.json();
    return Array.isArray(releasePayload) ? releasePayload : [];
  } catch (fetchError) {
    const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
    console.warn(`GitHub release lookup for ${repositoryName} failed: ${message}`);
    return [];
  }
};

const escapedRegExp = (patternText) => patternText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Some Android releases attach an old iOS build, so the tag is what settles it.
export const iosReleaseVersion = (tagName) => String(tagName ?? "").match(/^iOS[v-]?(\d.*)$/iu)?.[1] ?? null;

const releaseMatchesManifest = (githubRelease, manifest) => {
  const releaseFields = [
    githubRelease.tag_name,
    githubRelease.name,
  ].filter(Boolean).map(String);

  const versionPattern = new RegExp(`(^|[^0-9])v?${escapedRegExp(manifest.version)}(?=$|[^0-9.])`, "iu");
  return releaseFields.some((releaseField) => versionPattern.test(releaseField));
};

const matchingGithubRelease = (githubReleases, manifest) =>
  githubReleases
    .filter((githubRelease) => iosReleaseVersion(githubRelease.tag_name))
    .find((githubRelease) => releaseMatchesManifest(githubRelease, manifest)) ?? null;

// Sideloaders expand the notes, so this only has to stop a runaway release
// body. A full iOS changelog runs to about 7k.
export const storeTextBudget = 8000;

export const looksLikeHeading = (paragraph) =>
  !paragraph.includes("\n")
  && !paragraph.startsWith("- ")
  && paragraph.length < 60
  && !/[.!?:]$/u.test(paragraph);

// A single paragraph can be longer than the whole budget. Cutting it at a
// sentence, or failing that a word, still beats publishing nothing.
const trimmedToBudget = (paragraph) => {
  const clipped = paragraph.slice(0, storeTextBudget);
  const sentenceEnd = clipped.search(/[^.!?]*$/u);

  if (sentenceEnd > storeTextBudget / 2) {
    return clipped.slice(0, sentenceEnd).trimEnd();
  }

  return clipped.slice(0, clipped.lastIndexOf(" ")).trimEnd();
};

// Whole paragraphs only, so a cut never lands mid-sentence, and never on a
// heading whose section did not fit.
const withinBudget = (paragraphs) => {
  const kept = [];
  let usedCharacters = 0;

  for (const paragraph of paragraphs) {
    const paragraphCost = paragraph.length + 2;

    if (usedCharacters + paragraphCost > storeTextBudget) {
      while (kept.length > 0 && looksLikeHeading(kept.at(-1))) {
        kept.pop();
      }

      return { kept, truncated: true };
    }

    kept.push(paragraph);
    usedCharacters += paragraphCost;
  }

  return { kept, truncated: false };
};

export const markdownToStoreText = (markdownText) => {
  const cleanedText = String(markdownText)
    .replace(/\r\n?/gu, "\n")
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/gu, "$2")
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/^[ \t]*[-*+][ \t]+/gmu, "- ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  const candidateParagraphs = cleanedText
    .split("\n\n")
    .map((paragraph) => paragraph.split("\n").map((line) => line.trimEnd())
      .filter((line) => !/^full changelog:?/iu.test(line))
      .join("\n")
      .trim())
    .filter(Boolean);

  const { kept, truncated } = withinBudget(candidateParagraphs);

  if (kept.length === 0) {
    return candidateParagraphs.length === 0 ? "" : `${trimmedToBudget(candidateParagraphs[0])}\n\n\u2026`;
  }

  return truncated ? `${kept.join("\n\n")}\n\n\u2026` : kept.join("\n\n");
};

const fallbackChangelog = (manifest, metadataPayload) => {
  const fallbackTemplate = metadataPayload.releaseNotes.fallback
    ?? "Updated to ARMSX2 iOS {version}.\n\nIncludes the latest published iOS build, verified download metadata, and local-network permission disclosure for supported online features.";

  return fallbackTemplate.replaceAll("{version}", manifest.version);
};

// A description opening with the release URL is current. Older "Updated to..."
// ones still feed the offline fallback, but get rewritten so the link appears.
const linkedChangelog = (description) =>
  typeof description === "string" && description.startsWith("https://github.com/");

const generatedChangelog = (description) =>
  linkedChangelog(description)
  || (typeof description === "string" && description.startsWith("Updated to ARMSX2 iOS"));

export const existingVersionDescriptions = async (repositoryRoot, sourcePath) => {
  const existingSourcePath = resolve(repositoryRoot, sourcePath);
  const existingSourcePayload = await optionalJsonDocument(existingSourcePath);
  const versionDescriptions = new Map();

  for (const sourceApp of existingSourcePayload.apps ?? []) {
    for (const sourceVersion of sourceApp.versions ?? []) {
      const description = sourceVersion.localizedDescription;

      if (!generatedChangelog(description)) {
        continue;
      }

      versionDescriptions.set(
        `${sourceVersion.version}|${sourceVersion.downloadURL}|${sourceVersion.sha256 ?? ""}`,
        description,
      );
      versionDescriptions.set(sourceVersion.version, description);
    }
  }

  return versionDescriptions;
};

export const storeChangelog = (manifest, metadataPayload, githubReleases, existingDescriptions, generatorOptions = {}) => {
  const publishedDescription = existingDescriptions.get(
    `${manifest.version}|${manifest.downloadURL}|${manifest.sha256}`,
  );

  if (linkedChangelog(publishedDescription) && !generatorOptions.refreshChangelogs) {
    return publishedDescription;
  }

  const githubRelease = matchingGithubRelease(githubReleases, manifest);
  const releaseBody = markdownToStoreText(githubRelease?.body ?? "");

  if (releaseBody) {
    return githubRelease.html_url ? `${githubRelease.html_url}\n\n${releaseBody}` : releaseBody;
  }

  return publishedDescription
    ?? existingDescriptions.get(manifest.version)
    ?? fallbackChangelog(manifest, metadataPayload);
};
