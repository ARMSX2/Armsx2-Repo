import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { bundleIdentifier, repositoryRoot, sourceIdentifier } from "./constants.js";
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

const findIpaFiles = async (inputDirectory) => {
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

export const mirrorPublicAsset = async (publicRelativePath) => {
  const sourcePath = resolve(repositoryRoot, publicRelativePath);
  const mirrorPath = resolve(repositoryRoot, "public", publicRelativePath);

  try {
    await stat(sourcePath);
  } catch (filesystemError) {
    if (filesystemError?.code === "ENOENT") {
      return;
    }

    throw filesystemError;
  }

  await mkdir(dirname(mirrorPath), { recursive: true });
  await copyFile(sourcePath, mirrorPath);
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
    minOSVersion: manifest.minOSVersion,
    maxOSVersion: manifest.maxOSVersion,
  });

const sourceApp = (ipaFileManifests, generatorOptions, metadataPayload, screenshotFiles) =>
  compactObject({
    name: "ARMSX2 iOS",
    bundleIdentifier,
    developerName: "ARMSX2",
    subtitle: metadataPayload.app.subtitle ?? "Modern PlayStation 2 emulation for iOS.",
    localizedDescription: metadataPayload.app.localizedDescription
      ?? "ARMSX2 brings PlayStation 2 emulation to iOS devices. Based on the open-source PCSX2 project, this ARM64-focused iOS build helps you revisit and preserve your own legally obtained PS2 game library on modern mobile hardware.",
    iconURL: publicAssetUrl(generatorOptions.baseUrl, iconFile),
    screenshotURLs: screenshotFiles.map((screenshotFile) => publicAssetUrl(generatorOptions.baseUrl, screenshotFile)),
    tintColor: "#2F6FAD",
    versions: ipaFileManifests.map(sourceVersion),
    permissions: ipaFileManifests[0]?.permissions?.length
      ? ipaFileManifests[0].permissions
      : undefined,
  });

const sourcePayload = (ipaFileManifests, generatorOptions, metadataPayload, screenshotFiles) => ({
  name: "ARMSX2 iOS",
  identifier: sourceIdentifier,
  sourceURL: publicAssetUrl(generatorOptions.baseUrl, "apps.json"),
  apps: [sourceApp(ipaFileManifests, generatorOptions, metadataPayload, screenshotFiles)],
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

const checksumPayload = (ipaFileManifests, generatorOptions) => ({
  sourceIdentifier,
  sourceURL: publicAssetUrl(generatorOptions.baseUrl, "apps.json"),
  generatedAt: ipaFileManifests[0]?.sourceTimestamp ?? null,
  files: ipaFileManifests.map(checksumFileEntry),
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
    );
  }

  return {
    source: jsonBuffer(sourcePayload(ipaFileManifests, generatorOptions, metadataPayload, screenshotFiles)),
    checksums: jsonBuffer(checksumPayload(ipaFileManifests, generatorOptions)),
    assetFiles: [iconFile, ...screenshotFiles],
    screenshotFiles,
    ipaCount: ipaFileManifests.length,
  };
};
