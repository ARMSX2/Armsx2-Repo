#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseOptions, setOptionValue } from "./cli.js";
import { defaultBaseUrl, nightlyBundleIdentifier, repositoryRoot } from "./constants.js";
import { UpstreamSyncError } from "./errors.js";
import { downloadAssetToFile, githubReleases, writeGithubOutput } from "./github-assets.js";
import { markdownToStoreText } from "./github-releases.js";
import { ipaFileManifest } from "./ipa-metadata.js";
import { newestNightlyCandidate, whatsNewFromReleaseBody } from "./nightly-releases.js";
import { nightlyVersion, repackNightlyIpa } from "./nightly-ipa.js";
import { jsonBuffer, optionalJsonDocument } from "./source-utils.js";

const execFileAsync = promisify(execFile);
const generatorPath = resolve(repositoryRoot, "scripts/generate-source.js");
const validatorPath = resolve(repositoryRoot, "scripts/validate-source.js");

const defaults = {
  nightlyPath: "metadata/nightly.json",
  metadataPath: "metadata/store.json",
  stagingDirectory: ".nightly",
  baseUrl: process.env.ARMSX2_PUBLIC_BASE_URL || defaultBaseUrl,
  upstreamReleaseRepo: process.env.ARMSX2_UPSTREAM_RELEASE_REPO || null,
};

const parseArguments = (cliArguments) => parseOptions(
  cliArguments,
  defaults,
  {
    "--nightly": setOptionValue("nightlyPath"),
    "--metadata": setOptionValue("metadataPath"),
    "--staging-dir": setOptionValue("stagingDirectory"),
    "--base-url": setOptionValue("baseUrl"),
    "--upstream-release-repo": setOptionValue("upstreamReleaseRepo"),
  },
  (message) => new UpstreamSyncError(message),
);

const releaseRepository = async (mirrorOptions) => {
  const metadataPayload = await optionalJsonDocument(resolve(repositoryRoot, mirrorOptions.metadataPath));
  const repositoryName = mirrorOptions.upstreamReleaseRepo ?? metadataPayload.releaseNotes?.upstreamRepository;

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryName ?? "")) {
    throw new UpstreamSyncError(`${repositoryName} is not a usable owner/repository name.`);
  }

  return repositoryName;
};

// Ours differs from the upstream asset byte for byte, because we rewrite the
// bundle identity. A distinct name keeps the two from being confused.
const publishedFileName = (candidate) => {
  const [, day] = candidate.asset.name.match(/-(\d{8})-/u);
  return `ARMSX2-Nightly-${day}-${candidate.commit}.ipa`;
};

const buildChangelog = (candidate) => {
  const [day, time] = candidate.publishedAt.split("T");
  const heading = `Nightly build ${day} ${time.slice(0, 5)} UTC (${candidate.commit}).`;
  const whatsNew = markdownToStoreText(whatsNewFromReleaseBody(candidate.body) ?? "");

  return whatsNew ? `${heading}\n\n${whatsNew}` : heading;
};

const ledgerBuild = (candidate, manifest, version, fileName) => ({
  fileName,
  version,
  buildVersion: manifest.buildVersion,
  upstreamVersion: manifest.upstreamVersion,
  tag: candidate.tag,
  commit: candidate.commit,
  date: candidate.publishedAt.slice(0, 10),
  publishedAt: candidate.publishedAt,
  size: manifest.size,
  sha256: manifest.sha256,
  minOSVersion: manifest.minOSVersion,
  localizedDescription: buildChangelog(candidate),
});

const regenerateAndValidate = async (mirrorOptions) => {
  await execFileAsync(process.execPath, [generatorPath], { cwd: repositoryRoot });
  await execFileAsync(process.execPath, [
    validatorPath,
    "--nightly-dir",
    mirrorOptions.stagingDirectory,
  ], { cwd: repositoryRoot });
};

const mirrorLatestNightly = async () => {
  const mirrorOptions = parseArguments(process.argv.slice(2));
  const ledgerPath = resolve(repositoryRoot, mirrorOptions.nightlyPath);
  const ledger = await optionalJsonDocument(ledgerPath, {});
  const builds = ledger.builds ?? [];

  const candidate = newestNightlyCandidate(await githubReleases(await releaseRepository(mirrorOptions)));

  if (!candidate) {
    console.log("No nightly iOS build is published upstream.");
    await writeGithubOutput({ changed: "false" });
    return;
  }

  const fileName = publishedFileName(candidate);

  if (builds.some((build) => build.fileName === fileName)) {
    console.log(`${fileName} is already published.`);
    await writeGithubOutput({ changed: "false" });
    return;
  }

  const stagingDirectory = resolve(repositoryRoot, mirrorOptions.stagingDirectory);
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });

  const upstreamPath = join(stagingDirectory, "upstream.ipa");
  await downloadAssetToFile(candidate.asset, upstreamPath);

  const upstream = await ipaFileManifest(upstreamPath, { baseUrl: mirrorOptions.baseUrl });
  const version = nightlyVersion(upstream.version, candidate.publishedAt);
  const publishedPath = join(stagingDirectory, fileName);

  await repackNightlyIpa(upstreamPath, publishedPath, version);
  await rm(upstreamPath, { force: true });

  const published = await ipaFileManifest(publishedPath, {
    baseUrl: mirrorOptions.baseUrl,
    bundleIdentifier: nightlyBundleIdentifier,
  });

  if (published.version !== version) {
    throw new UpstreamSyncError(`${fileName} reports ${published.version}; expected ${version}.`);
  }

  const retain = ledger.retain ?? 5;
  const kept = [ledgerBuild(candidate, { ...published, upstreamVersion: upstream.version }, version, fileName), ...builds]
    .slice(0, retain);
  const dropped = builds
    .filter((build) => !kept.some((keptBuild) => keptBuild.fileName === build.fileName))
    .map((build) => build.fileName);

  await writeFile(ledgerPath, jsonBuffer({
    ...ledger,
    retain,
    permissions: published.permissions,
    builds: kept,
  }));

  await regenerateAndValidate(mirrorOptions);

  console.log(`Mirrored ${fileName} (${version}).`);

  if (dropped.length > 0) {
    console.log(`Dropped ${dropped.join(", ")}.`);
  }

  await writeGithubOutput({
    changed: "true",
    file_name: fileName,
    version,
    sha256: published.sha256,
  });
};

try {
  await mirrorLatestNightly();
} catch (mirrorError) {
  console.error(mirrorError instanceof Error ? mirrorError.message : String(mirrorError));
  process.exitCode = 1;
}
