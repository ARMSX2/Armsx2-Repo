import { basename, extname, join, relative, resolve, sep } from "node:path";

import {
  bundleIdentifier,
  nightlyBundleIdentifier,
  nightlyDirectory,
  repositoryRoot,
  sourceIdentifier,
} from "./constants.js";
import { SourceGenerationError } from "./errors.js";
import {
  existingVersionDescriptions,
  fetchGithubReleases,
  storeChangelog,
} from "./github-releases.js";
import { compareIpaManifests, ipaFileManifest } from "./ipa-metadata.js";
import {
  jsonBuffer,
  optionalJsonDocument,
  publicAssetUrl,
  readDirectoryEntries,
} from "./source-utils.js";

export const findIpaFiles = async (inputDirectory) => {
  const directoryEntries = await readDirectoryEntries(inputDirectory);

  return directoryEntries
    .filter((directoryEntry) => directoryEntry.isFile())
    .filter((directoryEntry) => extname(directoryEntry.name).toLowerCase() === ".ipa")
    .map((directoryEntry) => join(inputDirectory, directoryEntry.name))
    .sort((leftPath, rightPath) => basename(leftPath).localeCompare(basename(rightPath)));
};

const storeMetadata = async (generatorOptions) => {
  const metadataPath = resolve(repositoryRoot, generatorOptions.metadataPath);
  const metadataPayload = await optionalJsonDocument(metadataPath);

  return {
    app: metadataPayload.app ?? {},
    screenshots: metadataPayload.screenshots ?? {},
    releaseNotes: metadataPayload.releaseNotes ?? {},
  };
};

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const iconFile = "assets/icon.png";

const screenshotDirectory = (generatorOptions, metadataPayload) =>
  generatorOptions.screenshotDirectory
    ?? metadataPayload.screenshots.directory
    ?? "assets/screenshots";

const findScreenshotFiles = async (generatorOptions, metadataPayload) => {
  const screenshotRoot = resolve(repositoryRoot, screenshotDirectory(generatorOptions, metadataPayload));
  const screenshotEntries = await readDirectoryEntries(screenshotRoot);

  return screenshotEntries
    .filter((directoryEntry) => directoryEntry.isFile())
    .filter((directoryEntry) => imageExtensions.has(extname(directoryEntry.name).toLowerCase()))
    .map((directoryEntry) => relative(repositoryRoot, join(screenshotRoot, directoryEntry.name)).split(sep).join("/"))
    .sort((leftPath, rightPath) => leftPath.localeCompare(rightPath, undefined, { numeric: true }));
};

export const nightlyLedger = async (generatorOptions) => {
  const ledgerPath = resolve(repositoryRoot, generatorOptions.nightlyPath);
  const ledger = await optionalJsonDocument(ledgerPath, {});

  return {
    retain: ledger.retain ?? 5,
    app: ledger.app ?? {},
    permissions: ledger.permissions ?? [],
    builds: ledger.builds ?? [],
  };
};

// The nightly IPAs are never kept in the repository, so their manifests come
// from the ledger rather than from a file on disk.
const nightlyManifest = (build, generatorOptions) => ({
  fileName: build.fileName,
  bundleIdentifier: nightlyBundleIdentifier,
  version: build.version,
  buildVersion: build.buildVersion,
  date: build.date,
  sourceTimestamp: build.publishedAt,
  downloadURL: publicAssetUrl(generatorOptions.baseUrl, `${nightlyDirectory}/${build.fileName}`),
  size: build.size,
  sha256: build.sha256,
  minOSVersion: build.minOSVersion ?? null,
  maxOSVersion: build.maxOSVersion ?? null,
  localizedDescription: build.localizedDescription,
});

const nightlyChannelBuild = (ledger, generatorOptions) => {
  if (ledger.builds.length === 0) {
    return null;
  }

  return {
    channel: {
      name: ledger.app.name ?? "ARMSX2 Nightly",
      bundleIdentifier: nightlyBundleIdentifier,
      subtitle: ledger.app.subtitle,
      localizedDescription: ledger.app.localizedDescription,
      tintColor: ledger.app.tintColor,
      permissions: ledger.permissions,
    },
    manifests: ledger.builds.map((build) => nightlyManifest(build, generatorOptions)),
  };
};

const compactObject = (record) =>
  Object.fromEntries(
    Object.entries(record).filter(([, recordValue]) => recordValue !== null && recordValue !== undefined),
  );

const sourceVersion = (manifest) =>
  compactObject({
    version: manifest.version,
    date: manifest.date,
    localizedDescription: manifest.localizedDescription,
    downloadURL: manifest.downloadURL,
    size: manifest.size,
    sha256: manifest.sha256,
    minOSVersion: manifest.minOSVersion,
    maxOSVersion: manifest.maxOSVersion,
  });

const stableChannelApp = (metadataPayload) => ({
  name: "ARMSX2 iOS",
  bundleIdentifier,
  subtitle: metadataPayload.app.subtitle ?? "Modern PlayStation 2 emulation for iOS.",
  localizedDescription: metadataPayload.app.localizedDescription
    ?? "ARMSX2 brings PlayStation 2 emulation to iOS devices. Based on the open-source PCSX2 project, this ARM64-focused iOS build helps you revisit and preserve your own legally obtained PS2 game library on modern mobile hardware.",
  tintColor: "#2F6FAD",
});

const sourceApp = (channel, ipaFileManifests, generatorOptions, screenshotFiles) =>
  compactObject({
    name: channel.name,
    bundleIdentifier: channel.bundleIdentifier,
    developerName: "ARMSX2",
    subtitle: channel.subtitle,
    localizedDescription: channel.localizedDescription,
    iconURL: publicAssetUrl(generatorOptions.baseUrl, iconFile),
    screenshotURLs: screenshotFiles.map((screenshotFile) => publicAssetUrl(generatorOptions.baseUrl, screenshotFile)),
    tintColor: channel.tintColor,
    versions: ipaFileManifests.map(sourceVersion),
    permissions: channel.permissions?.length ? channel.permissions : undefined,
  });

const sourcePayload = (channelBuilds, generatorOptions, screenshotFiles) => ({
  name: "ARMSX2 iOS",
  identifier: sourceIdentifier,
  sourceURL: publicAssetUrl(generatorOptions.baseUrl, "apps.json"),
  apps: channelBuilds.map(({ channel, manifests }) =>
    sourceApp(channel, manifests, generatorOptions, screenshotFiles)),
});

const checksumFileEntry = (manifest) => ({
  fileName: manifest.fileName,
  bundleIdentifier: manifest.bundleIdentifier,
  version: manifest.version,
  buildVersion: manifest.buildVersion,
  date: manifest.date,
  downloadURL: manifest.downloadURL,
  size: manifest.size,
  sha256: manifest.sha256,
});

const checksumPayload = (channelBuilds, generatorOptions) => ({
  sourceIdentifier,
  sourceURL: publicAssetUrl(generatorOptions.baseUrl, "apps.json"),
  generatedAt: channelBuilds[0]?.manifests[0]?.sourceTimestamp ?? null,
  files: channelBuilds.flatMap(({ manifests }) => manifests.map(checksumFileEntry)),
});

export const generatedBuffers = async (generatorOptions) => {
  const metadataPayload = await storeMetadata(generatorOptions);
  const inputDirectory = resolve(repositoryRoot, generatorOptions.inputDirectory);
  const ipaFilePaths = await findIpaFiles(inputDirectory);

  if (generatorOptions.requireIpa && ipaFilePaths.length === 0) {
    throw new SourceGenerationError(`${relative(repositoryRoot, inputDirectory)} contains no IPA files.`);
  }

  const ipaFileManifests = [];

  for (const ipaFilePath of ipaFilePaths) {
    ipaFileManifests.push(await ipaFileManifest(ipaFilePath, generatorOptions));
  }

  ipaFileManifests.sort(compareIpaManifests);

  const screenshotFiles = await findScreenshotFiles(generatorOptions, metadataPayload);
  const githubReleases = await fetchGithubReleases(generatorOptions, metadataPayload);
  const existingDescriptions = await existingVersionDescriptions(repositoryRoot, generatorOptions.sourcePath);

  for (const manifest of ipaFileManifests) {
    manifest.localizedDescription = storeChangelog(
      manifest,
      metadataPayload,
      githubReleases,
      existingDescriptions,
      generatorOptions,
    );
  }

  const ledger = await nightlyLedger(generatorOptions);
  const stableBuild = {
    channel: { ...stableChannelApp(metadataPayload), permissions: ipaFileManifests[0]?.permissions },
    manifests: ipaFileManifests,
  };
  const channelBuilds = [stableBuild, nightlyChannelBuild(ledger, generatorOptions)].filter(Boolean);

  return {
    source: jsonBuffer(sourcePayload(channelBuilds, generatorOptions, screenshotFiles)),
    checksums: jsonBuffer(checksumPayload(channelBuilds, generatorOptions)),
    screenshotFiles,
    ipaCount: channelBuilds.reduce((total, { manifests }) => total + manifests.length, 0),
  };
};
