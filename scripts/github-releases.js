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

const releaseMatchesManifest = (githubRelease, manifest) => {
  const releaseFields = [
    githubRelease.tag_name,
    githubRelease.name,
  ].filter(Boolean).map(String);

  const versionPattern = new RegExp(`(^|[^0-9])v?${escapedRegExp(manifest.version)}(?=$|[^0-9.])`, "iu");
  return releaseFields.some((releaseField) => versionPattern.test(releaseField));
};

const matchingGithubRelease = (githubReleases, manifest) =>
  githubReleases.find((githubRelease) => releaseMatchesManifest(githubRelease, manifest)) ?? null;

const markdownToStoreText = (markdownText) => {
  const cleanedText = String(markdownText)
    .replace(/\r\n?/gu, "\n")
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "- ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  return cleanedText
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !/^full changelog:?/iu.test(line))
    .slice(0, 10)
    .join("\n")
    .slice(0, 1200)
    .trim();
};

const fallbackChangelog = (manifest, metadataPayload) => {
  const fallbackTemplate = metadataPayload.releaseNotes.fallback
    ?? "Updated to ARMSX2 iOS {version}.\n\nIncludes the latest published iOS build, verified download metadata, and local-network permission disclosure for supported online features.";

  return fallbackTemplate.replaceAll("{version}", manifest.version);
};

export const existingVersionDescriptions = async (repositoryRoot, sourcePath) => {
  const existingSourcePath = resolve(repositoryRoot, sourcePath);
  const existingSourcePayload = await optionalJsonDocument(existingSourcePath);
  const versionDescriptions = new Map();

  for (const sourceApp of existingSourcePayload.apps ?? []) {
    for (const sourceVersion of sourceApp.versions ?? []) {
      const description = sourceVersion.localizedDescription;

      if (typeof description !== "string" || !description.startsWith("Updated to ARMSX2 iOS")) {
        continue;
      }

      versionDescriptions.set(`${sourceVersion.version}|${sourceVersion.downloadURL}`, description);
      versionDescriptions.set(sourceVersion.version, description);
    }
  }

  return versionDescriptions;
};

export const storeChangelog = (manifest, metadataPayload, githubReleases, existingDescriptions) => {
  const githubRelease = matchingGithubRelease(githubReleases, manifest);
  const releaseBody = markdownToStoreText(githubRelease?.body ?? "");

  if (releaseBody) {
    return `Updated to ARMSX2 iOS ${manifest.version}.\n\n${releaseBody}`;
  }

  return existingDescriptions.get(`${manifest.version}|${manifest.downloadURL}`)
    ?? existingDescriptions.get(manifest.version)
    ?? fallbackChangelog(manifest, metadataPayload);
};
