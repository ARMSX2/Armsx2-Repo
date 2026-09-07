#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseOptions, setOptionFlag, setOptionValue } from "./cli.js";
import { defaultBaseUrl, repositoryRoot } from "./constants.js";
import { UpstreamSyncError } from "./errors.js";
import { downloadAssetToFile, githubReleases, writeGithubOutput } from "./github-assets.js";
import { isNightlyRelease } from "./nightly-releases.js";
import { ipaFileManifest } from "./ipa-metadata.js";
import { findIpaFiles } from "./source-builder.js";
import { optionalJsonDocument } from "./source-utils.js";

const execFileAsync = promisify(execFile);
const generatorPath = resolve(repositoryRoot, "scripts/generate-source.js");
const validatorPath = resolve(repositoryRoot, "scripts/validate-source.js");

const defaults = {
  metadataPath: "metadata/store.json",
  checksumsPath: "checksums.json",
  outputDirectory: "ipas",
  baseUrl: process.env.ARMSX2_PUBLIC_BASE_URL || defaultBaseUrl,
  upstreamReleaseRepo: process.env.ARMSX2_UPSTREAM_RELEASE_REPO || null,
  includePrereleases: process.env.INCLUDE_PRERELEASES === "true",
};

const parseArguments = (cliArguments) => parseOptions(
  cliArguments,
  defaults,
  {
    "--metadata": setOptionValue("metadataPath"),
    "--checksums": setOptionValue("checksumsPath"),
    "--output-dir": setOptionValue("outputDirectory"),
    "--base-url": setOptionValue("baseUrl"),
    "--upstream-release-repo": setOptionValue("upstreamReleaseRepo"),
    "--include-prereleases": setOptionFlag("includePrereleases"),
  },
  (message) => new UpstreamSyncError(message),
);

const releaseRepository = async (syncOptions) => {
  const metadataPath = resolve(repositoryRoot, syncOptions.metadataPath);
  const metadataPayload = await optionalJsonDocument(metadataPath);
  const repositoryName = syncOptions.upstreamReleaseRepo
    ?? metadataPayload.releaseNotes?.upstreamRepository;

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryName ?? "")) {
    throw new UpstreamSyncError(`Invalid upstream release repository: ${repositoryName}`);
  }

  return repositoryName;
};

const releaseTimestamp = (githubRelease) =>
  String(githubRelease.published_at ?? githubRelease.created_at ?? "");

const versionFromIosRelease = (githubRelease) => {
  const releaseText = `${githubRelease.tag_name ?? ""} ${githubRelease.name ?? ""}`;
  return releaseText.match(/\biosv?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/iu)?.[1]
    ?? releaseText.match(/\barmsx2-ios\D+(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/iu)?.[1]
    ?? null;
};

const versionFromIosAsset = (releaseAsset) =>
  releaseAsset.name?.match(/^ARMSX2-iOS-v?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)\.ipa$/iu)?.[1]
  ?? null;

const candidateScore = (candidate) => {
  let score = 0;

  if (candidate.releaseVersion) {
    score += 100;
  }

  if (candidate.assetVersion) {
    score += 50;
  }

  if (candidate.releaseVersion && candidate.releaseVersion === candidate.assetVersion) {
    score += 25;
  }

  if (/^ARMSX2-iOS-v?\d/iu.test(candidate.releaseAsset.name ?? "")) {
    score += 10;
  }

  return score;
};

// Nightly has its own pipeline. Skipping the tags here means neither channel
// can pick up the other's builds, whatever include_prereleases says.
const releaseCandidates = (releases, syncOptions) =>
  releases
    .filter((githubRelease) => !githubRelease.draft)
    .filter((githubRelease) => !isNightlyRelease(githubRelease))
    .filter((githubRelease) => syncOptions.includePrereleases || !githubRelease.prerelease)
    .flatMap((githubRelease) => {
      const releaseVersion = versionFromIosRelease(githubRelease);

      return (githubRelease.assets ?? [])
        .filter((releaseAsset) => releaseAsset.name?.toLowerCase().endsWith(".ipa"))
        .map((releaseAsset) => ({
          githubRelease,
          releaseAsset,
          releaseVersion,
          assetVersion: versionFromIosAsset(releaseAsset),
        }));
    })
    .filter((candidate) => candidate.releaseVersion || candidate.assetVersion)
    .map((candidate) => ({ ...candidate, score: candidateScore(candidate) }))
    .sort((leftCandidate, rightCandidate) => {
      const scoreDelta = rightCandidate.score - leftCandidate.score;

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return releaseTimestamp(rightCandidate.githubRelease).localeCompare(releaseTimestamp(leftCandidate.githubRelease));
    });

const selectedReleaseCandidate = (candidates) => {
  const [bestCandidate, nextCandidate] = candidates;

  if (!bestCandidate) {
    return null;
  }

  if (nextCandidate && nextCandidate.score === bestCandidate.score
    && releaseTimestamp(nextCandidate.githubRelease) === releaseTimestamp(bestCandidate.githubRelease)) {
    throw new UpstreamSyncError(
      `Multiple equally good iOS IPA assets were found: ${bestCandidate.releaseAsset.name}, ${nextCandidate.releaseAsset.name}.`,
    );
  }

  return bestCandidate;
};

const publishedFileExists = async (syncOptions, fileName) => {
  try {
    await stat(join(resolve(repositoryRoot, syncOptions.outputDirectory), basename(fileName)));
    return true;
  } catch {
    return false;
  }
};

// The hash matching is not enough on its own. If the file has gone, the sync
// short-circuits and apps.json ends up pointing at nothing.
const checksumExists = async (syncOptions, ipaSha256) => {
  const checksumPath = resolve(repositoryRoot, syncOptions.checksumsPath);
  const checksumPayload = await optionalJsonDocument(checksumPath, { files: [] });
  const matchingEntry = (checksumPayload.files ?? []).find((fileEntry) => fileEntry.sha256 === ipaSha256);

  return Boolean(matchingEntry) && await publishedFileExists(syncOptions, matchingEntry.fileName);
};

const safeAssetName = (assetName) =>
  basename(assetName).replace(/[^\w.-]/gu, "-");

const writeGithubSummary = async (summaryLines) => {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  await writeFile(process.env.GITHUB_STEP_SUMMARY, `${summaryLines.join("\n")}\n`, { flag: "a" });
};

const syncSummaryLines = ({
  changed,
  repositoryName,
  githubRelease,
  releaseAsset,
  manifest,
  ipaSha256,
}) => [
  "## Source update summary",
  "",
  `- Upstream repository: ${repositoryName}`,
  `- Selected release: ${githubRelease.tag_name ?? githubRelease.name ?? "unknown"}`,
  `- Selected asset: ${releaseAsset.name}`,
  `- Detected app version: ${manifest.version}`,
  `- Bundle identifier: ${manifest.bundleIdentifier}`,
  `- File size: ${manifest.size}`,
  `- SHA-256: ${ipaSha256}`,
  `- IPA changed: ${changed ? "yes" : "no"}`,
  "",
];

const runNodeScript = async (scriptPath, scriptArguments, extraEnvironment = {}) => {
  await execFileAsync(process.execPath, [scriptPath, ...scriptArguments], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...extraEnvironment,
    },
    maxBuffer: 1024 * 1024 * 8,
  });
};

const validateCandidate = async (temporaryDirectory, candidateIpaDirectory, syncOptions) => {
  const candidateSourcePath = join(temporaryDirectory, "apps.json");
  const candidateChecksumsPath = join(temporaryDirectory, "checksums.json");

  await runNodeScript(generatorPath, [
    "--input-dir",
    candidateIpaDirectory,
    "--output",
    candidateSourcePath,
    "--checksums",
    candidateChecksumsPath,
    "--base-url",
    syncOptions.baseUrl,
    "--require-ipa",
  ]);

  await runNodeScript(validatorPath, [
    "--source",
    candidateSourcePath,
    "--checksums",
    candidateChecksumsPath,
    "--ipa-dir",
    candidateIpaDirectory,
    "--skip-offline-fallback",
    "--skip-legacy-purge",
  ]);
};

// Copy first, prune second. Clearing the directory up front left ipas/ empty
// when the copy then failed, and the next generate published no versions.
const replacePublishedIpas = async (candidateIpaPath, syncOptions) => {
  const outputDirectory = resolve(repositoryRoot, syncOptions.outputDirectory);
  const outputIpaPath = join(outputDirectory, basename(candidateIpaPath));

  await mkdir(outputDirectory, { recursive: true });
  await copyFile(candidateIpaPath, outputIpaPath);

  const publishedName = basename(outputIpaPath).toLowerCase();

  for (const staleIpaPath of await findIpaFiles(outputDirectory)) {
    if (basename(staleIpaPath).toLowerCase() !== publishedName) {
      await rm(staleIpaPath, { force: true });
    }
  }

  return outputIpaPath;
};

const syncLatestIpa = async () => {
  const syncOptions = parseArguments(process.argv.slice(2));
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "armsx2-upstream-"));

  try {
    const repositoryName = await releaseRepository(syncOptions);
    const releases = await githubReleases(repositoryName);
    const releaseCandidate = selectedReleaseCandidate(releaseCandidates(releases, syncOptions));

    if (!releaseCandidate) {
      throw new UpstreamSyncError(`No IPA release asset found in ${repositoryName}.`);
    }

    const { githubRelease, releaseAsset } = releaseCandidate;
    const assetName = safeAssetName(releaseAsset.name);
    const candidateIpaPath = join(temporaryDirectory, "ipas", assetName);
    const versionLabel = githubRelease.tag_name ?? githubRelease.name ?? assetName;
    const ipaSha256 = await downloadAssetToFile(releaseAsset, candidateIpaPath);
    const candidateManifest = await ipaFileManifest(candidateIpaPath, syncOptions);

    if (await checksumExists(syncOptions, ipaSha256)) {
      await writeGithubOutput({
        changed: "false",
        asset_name: assetName,
        version: versionLabel,
        sha256: ipaSha256,
      });
      await writeGithubSummary(syncSummaryLines({
        changed: false,
        repositoryName,
        githubRelease,
        releaseAsset,
        manifest: candidateManifest,
        ipaSha256,
      }));
      console.log([
        `No update: ${assetName} is already published.`,
        `Selected release: ${versionLabel}`,
        `Detected app version: ${candidateManifest.version}`,
        `Bundle identifier: ${candidateManifest.bundleIdentifier}`,
        `File size: ${candidateManifest.size}`,
        `SHA-256: ${ipaSha256}`,
      ].join("\n"));
      return;
    }

    await validateCandidate(temporaryDirectory, dirname(candidateIpaPath), syncOptions);
    const publishedIpaPath = await replacePublishedIpas(candidateIpaPath, syncOptions);

    await writeGithubOutput({
      changed: "true",
      asset_name: assetName,
      version: versionLabel,
      sha256: ipaSha256,
    });
    await writeGithubSummary(syncSummaryLines({
      changed: true,
      repositoryName,
      githubRelease,
      releaseAsset,
      manifest: candidateManifest,
      ipaSha256,
    }));

    console.log([
      `Published ${publishedIpaPath} from ${repositoryName}.`,
      `Selected release: ${versionLabel}`,
      `Selected asset: ${releaseAsset.name}`,
      `Detected app version: ${candidateManifest.version}`,
      `Bundle identifier: ${candidateManifest.bundleIdentifier}`,
      `File size: ${candidateManifest.size}`,
      `SHA-256: ${ipaSha256}`,
    ].join("\n"));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

try {
  await syncLatestIpa();
} catch (syncError) {
  console.error(syncError instanceof Error ? syncError.message : syncError);
  process.exitCode = 1;
}
