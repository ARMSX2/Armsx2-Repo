#!/usr/bin/env node

import Ajv from "ajv";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { parseOptions, setOptionFlag, setOptionValue } from "./cli.js";
import {
  bundleIdentifier,
  canonicalBaseUrl,
  canonicalSourceUrl,
  repositoryRoot,
  sourceIdentifier,
} from "./constants.js";
import { ipaFileManifest } from "./ipa-metadata.js";

const execFileAsync = promisify(execFile);
const schemaUrl = "https://raw.githubusercontent.com/SideStore/sidestore-source-types/main/schema.json";
const generatorPath = resolve(repositoryRoot, "scripts/generate-source.js");

const defaults = {
  sourcePath: "apps.json",
  checksumPath: "checksums.json",
  ipaDirectory: "ipas",
  offlineFallback: true,
  legacyPurge: true,
};

class SourceValidationError extends Error {
  constructor(messages) {
    super(messages.join("\n"));
    this.name = "SourceValidationError";
  }
}

class ValidationArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationArgumentError";
  }
}

const parseArguments = (cliArguments) => parseOptions(
  cliArguments,
  defaults,
  {
    "--source": setOptionValue("sourcePath"),
    "--checksums": setOptionValue("checksumPath"),
    "--ipa-dir": setOptionValue("ipaDirectory"),
    "--skip-offline-fallback": setOptionFlag("offlineFallback", false),
    "--skip-legacy-purge": setOptionFlag("legacyPurge", false),
  },
  (message) => new ValidationArgumentError(message),
);

const jsonDocument = async (jsonPath) => {
  const jsonText = await readFile(jsonPath, "utf8");
  return JSON.parse(jsonText);
};

const fileBuffer = async (filePath) => readFile(filePath);

const relativePath = (entryPath) => relative(repositoryRoot, entryPath).split(sep).join("/");

const filesMatch = async (leftPath, rightPath) => {
  try {
    const [leftBuffer, rightBuffer] = await Promise.all([
      fileBuffer(leftPath),
      fileBuffer(rightPath),
    ]);

    return leftBuffer.equals(rightBuffer);
  } catch (filesystemError) {
    if (filesystemError?.code === "ENOENT") {
      return false;
    }

    throw filesystemError;
  }
};

const assertFileExists = async (filePath, label, errors) => {
  try {
    const fileStats = await stat(filePath);

    if (!fileStats.isFile()) {
      errors.push(`${label} must be a file.`);
      return null;
    }

    return fileStats;
  } catch (filesystemError) {
    if (filesystemError?.code === "ENOENT") {
      errors.push(`${label} is missing.`);
      return null;
    }

    throw filesystemError;
  }
};

const canonicalOrigin = new URL(canonicalBaseUrl).origin;
const legacyHost = "j1coding.github.io";
const legacyPathPrefix = "/Armsx2-Repo";

const parsedUrl = (urlValue) => {
  try {
    return new URL(urlValue);
  } catch {
    return null;
  }
};

const isCanonicalPublicUrl = (urlValue) => {
  const url = parsedUrl(urlValue);
  return Boolean(url && url.origin === canonicalOrigin);
};

const containsLegacySourceUrl = (payload) => {
  const payloadText = JSON.stringify(payload);
  return payloadText.includes(legacyHost) && payloadText.includes(legacyPathPrefix);
};

const urlPathToRepositoryPath = (urlValue) => {
  const url = parsedUrl(urlValue);

  if (!url || url.origin !== canonicalOrigin) {
    return null;
  }

  const pathSegments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((pathSegment) => decodeURIComponent(pathSegment));

  if (pathSegments.some((pathSegment) => pathSegment === "." || pathSegment === "..")) {
    return null;
  }

  return resolve(repositoryRoot, ...pathSegments);
};

const sideStoreSchema = async () => {
  const schemaResponse = await fetch(schemaUrl, {
    headers: {
      Accept: "application/schema+json, application/json",
      "User-Agent": "J1coding-ARMSX2-Source-Validator/2.0",
    },
  });

  if (!schemaResponse.ok) {
    throw new SourceValidationError([`SideStore schema fetch failed: ${schemaResponse.status}`]);
  }

  return schemaResponse.json();
};

const validateAgainstSideStoreSchema = async (sourceJson) => {
  const schemaDocument = await sideStoreSchema();
  const schemaValidator = new Ajv({ allErrors: true, strict: true });
  const validateSource = schemaValidator.compile(schemaDocument);

  if (validateSource(sourceJson)) {
    return [];
  }

  return validateSource.errors.map((schemaError) => {
    const schemaPath = schemaError.instancePath || "$";
    return `${schemaPath} ${schemaError.message}`;
  });
};

const nestedKeyPaths = (unknownPayload, forbiddenKey, currentPath = "$") => {
  if (Array.isArray(unknownPayload)) {
    return unknownPayload.flatMap((nestedPayload, nestedIndex) =>
      nestedKeyPaths(nestedPayload, forbiddenKey, `${currentPath}[${nestedIndex}]`),
    );
  }

  if (!unknownPayload || typeof unknownPayload !== "object") {
    return [];
  }

  return Object.entries(unknownPayload).flatMap(([payloadKey, nestedPayload]) => {
    const matchedPath = payloadKey === forbiddenKey ? [`${currentPath}.${payloadKey}`] : [];
    return [...matchedPath, ...nestedKeyPaths(nestedPayload, forbiddenKey, `${currentPath}.${payloadKey}`)];
  });
};

const validateStrictSourceShape = (sourceJson) => {
  const errors = [];

  if (sourceJson.identifier !== sourceIdentifier) {
    errors.push(`apps.json identifier must be ${sourceIdentifier}.`);
  }

  if (sourceJson.sourceURL !== canonicalSourceUrl) {
    errors.push(`apps.json sourceURL must be ${canonicalSourceUrl}.`);
  }

  if (containsLegacySourceUrl(sourceJson)) {
    errors.push("apps.json must not contain the old GitHub Pages source URL.");
  }

  const forbiddenSourceKeys = ["buildVersion", "sha256", "appPermissions", "marketplaceID"];

  for (const forbiddenKey of forbiddenSourceKeys) {
    const matchingPaths = nestedKeyPaths(sourceJson, forbiddenKey);

    if (matchingPaths.length > 0) {
      errors.push(`apps.json must not contain ${forbiddenKey}: ${matchingPaths.join(", ")}`);
    }
  }

  for (const [appIndex, sourceApp] of sourceJson.apps?.entries?.() ?? []) {
    if (sourceApp.bundleIdentifier !== bundleIdentifier) {
      errors.push(`apps[${appIndex}].bundleIdentifier must be ${bundleIdentifier}.`);
    }

    if (!isCanonicalPublicUrl(sourceApp.iconURL)) {
      errors.push(`apps[${appIndex}].iconURL must use ${canonicalBaseUrl}.`);
    }

    if (!Array.isArray(sourceApp.screenshotURLs) || sourceApp.screenshotURLs.length === 0) {
      errors.push(`apps[${appIndex}].screenshotURLs must contain at least one screenshot URL.`);
    } else {
      for (const [screenshotIndex, screenshotURL] of sourceApp.screenshotURLs.entries()) {
        const parsedScreenshotURL = parsedUrl(screenshotURL);

        if (!parsedScreenshotURL) {
          errors.push(`apps[${appIndex}].screenshotURLs[${screenshotIndex}] must be an absolute URL.`);
          continue;
        }

        if (parsedScreenshotURL.protocol !== "https:") {
          errors.push(`apps[${appIndex}].screenshotURLs[${screenshotIndex}] must use HTTPS.`);
        }

        if (parsedScreenshotURL.origin !== canonicalOrigin) {
          errors.push(`apps[${appIndex}].screenshotURLs[${screenshotIndex}] must use ${canonicalBaseUrl}.`);
        }
      }
    }

    for (const [versionIndex, sourceVersion] of sourceApp.versions?.entries?.() ?? []) {
      if (!isCanonicalPublicUrl(sourceVersion.downloadURL)) {
        errors.push(`apps[${appIndex}].versions[${versionIndex}].downloadURL must use ${canonicalBaseUrl}.`);
      }
    }
  }

  return errors;
};

const validateChecksumManifest = (sourceJson, checksumJson) => {
  const errors = [];

  if (checksumJson.sourceIdentifier !== sourceIdentifier) {
    errors.push(`checksums.json sourceIdentifier must be ${sourceIdentifier}.`);
  }

  if (checksumJson.sourceURL !== sourceJson.sourceURL) {
    errors.push("checksums.json sourceURL must match apps.json sourceURL.");
  }

  if (checksumJson.sourceURL !== canonicalSourceUrl) {
    errors.push(`checksums.json sourceURL must be ${canonicalSourceUrl}.`);
  }

  if (containsLegacySourceUrl(checksumJson)) {
    errors.push("checksums.json must not contain the old GitHub Pages source URL.");
  }

  if (!Array.isArray(checksumJson.files)) {
    errors.push("checksums.json files must be an array.");
    return errors;
  }

  const sourceDownloadURLs = new Set(
    (sourceJson.apps ?? []).flatMap((sourceApp) =>
      (sourceApp.versions ?? []).map((sourceVersion) => sourceVersion.downloadURL),
    ),
  );

  for (const [fileIndex, checksumEntry] of checksumJson.files.entries()) {
    const checksumPath = `files[${fileIndex}]`;

    if (checksumEntry.bundleIdentifier !== bundleIdentifier) {
      errors.push(`${checksumPath}.bundleIdentifier must be ${bundleIdentifier}.`);
    }

    if (!/^[0-9a-f]{64}$/u.test(checksumEntry.sha256 ?? "")) {
      errors.push(`${checksumPath}.sha256 must be a lowercase SHA-256 hex digest.`);
    }

    if (!Number.isSafeInteger(checksumEntry.size) || checksumEntry.size <= 0) {
      errors.push(`${checksumPath}.size must be a positive integer.`);
    }

    if (typeof checksumEntry.buildVersion !== "string" || checksumEntry.buildVersion.length === 0) {
      errors.push(`${checksumPath}.buildVersion must be a non-empty string.`);
    }

    if (!sourceDownloadURLs.has(checksumEntry.downloadURL)) {
      errors.push(`${checksumPath}.downloadURL is absent from public/apps.json.`);
    }

    if (!isCanonicalPublicUrl(checksumEntry.downloadURL)) {
      errors.push(`${checksumPath}.downloadURL must use ${canonicalBaseUrl}.`);
    }
  }

  return errors;
};

const matchingSourceVersions = (sourceJson) =>
  (sourceJson.apps ?? []).flatMap((sourceApp) =>
    (sourceApp.versions ?? []).map((sourceVersion) => ({
      app: sourceApp,
      version: sourceVersion,
    })),
  );

const validateGeneratedMirrors = async (validationOptions) => {
  const errors = [];

  if (validationOptions.sourcePath === defaults.sourcePath) {
    const rootSourcePath = resolve(repositoryRoot, validationOptions.sourcePath);
    const publicSourcePath = resolve(repositoryRoot, "public/apps.json");

    if (!await filesMatch(rootSourcePath, publicSourcePath)) {
      errors.push("public/apps.json must match apps.json.");
    }
  }

  if (validationOptions.checksumPath === defaults.checksumPath) {
    const rootChecksumsPath = resolve(repositoryRoot, validationOptions.checksumPath);
    const publicChecksumsPath = resolve(repositoryRoot, "public/checksums.json");

    if (!await filesMatch(rootChecksumsPath, publicChecksumsPath)) {
      errors.push("public/checksums.json must match checksums.json.");
    }
  }

  return errors;
};

const validateLocalAssets = async (sourceJson) => {
  const errors = [];
  const assetUrls = (sourceJson.apps ?? []).flatMap((sourceApp) => [
    sourceApp.iconURL,
    ...(sourceApp.screenshotURLs ?? []),
  ]).filter(Boolean);

  for (const assetUrl of assetUrls) {
    const assetPath = urlPathToRepositoryPath(assetUrl);

    if (!assetPath) {
      errors.push(`${assetUrl} does not map to a local asset path.`);
      continue;
    }

    const assetLabel = relativePath(assetPath);
    await assertFileExists(assetPath, assetLabel, errors);

    const publicAssetPath = resolve(repositoryRoot, "public", assetLabel);
    await assertFileExists(publicAssetPath, `public/${assetLabel}`, errors);
  }

  return errors;
};

const validateLocalIpas = async (sourceJson, checksumJson, validationOptions) => {
  const errors = [];
  const ipaDirectory = resolve(repositoryRoot, validationOptions.ipaDirectory);
  const sourceVersionsByDownloadURL = new Map(
    matchingSourceVersions(sourceJson).map(({ version }) => [version.downloadURL, version]),
  );

  for (const [fileIndex, checksumEntry] of (checksumJson.files ?? []).entries()) {
    const checksumPath = `files[${fileIndex}]`;
    const sourceVersion = sourceVersionsByDownloadURL.get(checksumEntry.downloadURL);
    const ipaPath = resolve(ipaDirectory, basename(checksumEntry.fileName ?? ""));
    const fileStats = await assertFileExists(ipaPath, `${checksumPath}.fileName local IPA`, errors);

    if (!fileStats) {
      continue;
    }

    let manifest;
    try {
      manifest = await ipaFileManifest(ipaPath, { baseUrl: canonicalBaseUrl });
    } catch (metadataError) {
      const message = metadataError instanceof Error ? metadataError.message : String(metadataError);
      errors.push(`${checksumPath}.fileName could not be read as a valid IPA: ${message}`);
      continue;
    }

    if (fileStats.size !== checksumEntry.size) {
      errors.push(`${checksumPath}.size must match ${relativePath(ipaPath)} (${fileStats.size}).`);
    }

    if (manifest.sha256 !== checksumEntry.sha256) {
      errors.push(`${checksumPath}.sha256 must match ${relativePath(ipaPath)}.`);
    }

    if (manifest.version !== checksumEntry.version) {
      errors.push(`${checksumPath}.version must match the local IPA version ${manifest.version}.`);
    }

    if (manifest.buildVersion !== checksumEntry.buildVersion) {
      errors.push(`${checksumPath}.buildVersion must match the local IPA build ${manifest.buildVersion}.`);
    }

    if (sourceVersion && sourceVersion.version !== manifest.version) {
      errors.push(`${checksumPath}.version must match apps.json version ${sourceVersion.version}.`);
    }

    if (sourceVersion && sourceVersion.size !== fileStats.size) {
      errors.push(`${checksumPath}.size must match apps.json size ${sourceVersion.size}.`);
    }
  }

  return errors;
};

const textExtensions = new Set([
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const skippedDirectories = new Set([".git", "node_modules", "dist", ".vite"]);
const excludedLegacyScanFiles = new Set(["scripts/validate-source.js"]);
const legacyScanRoots = [
  ".github",
  "README.md",
  "index.html",
  "metadata",
  "scripts",
  "package.json",
  "apps.json",
  "checksums.json",
  "public/apps.json",
  "public/checksums.json",
];

const relativeRepositoryPath = relativePath;

const isTextFile = (entryPath, entryStats) =>
  entryStats.size <= 1024 * 1024
    && (textExtensions.has(extname(entryPath).toLowerCase()) || relativeRepositoryPath(entryPath) === ".gitignore");

const discoverTextFiles = async (entryPath) => {
  const entryRelativePath = relativeRepositoryPath(entryPath);

  if (excludedLegacyScanFiles.has(entryRelativePath)) {
    return [];
  }

  const entryStats = await stat(entryPath);

  if (entryStats.isFile()) {
    return isTextFile(entryPath, entryStats) ? [entryPath] : [];
  }

  if (!entryStats.isDirectory()) {
    return [];
  }

  const directoryEntries = await readdir(entryPath, { withFileTypes: true });
  const discoveredFiles = [];

  for (const directoryEntry of directoryEntries) {
    if (directoryEntry.isDirectory() && skippedDirectories.has(directoryEntry.name)) {
      continue;
    }

    discoveredFiles.push(...await discoverTextFiles(join(entryPath, directoryEntry.name)));
  }

  return discoveredFiles;
};

const repositoryTextFiles = async () => {
  const discoveredFiles = [];

  for (const scanRoot of legacyScanRoots) {
    const scanPath = resolve(repositoryRoot, scanRoot);

    try {
      discoveredFiles.push(...await discoverTextFiles(scanPath));
    } catch (filesystemError) {
      if (filesystemError?.code !== "ENOENT") {
        throw filesystemError;
      }
    }
  }

  return [...new Set(discoveredFiles)];
};

const legacyNeedles = [
  "AltStore",
  "Android",
  ".apk",
  "APK",
  "PC build",
  "Cydia",
  "Sileo",
  "source.json",
  "releases.json",
];

const validateLegacyPurge = async () => {
  const errors = [];
  const textFiles = await repositoryTextFiles();

  for (const textFilePath of textFiles) {
    const repositoryRelativePath = relativeRepositoryPath(textFilePath);
    const fileText = await readFile(textFilePath, "utf8");

    for (const legacyNeedle of legacyNeedles) {
      if (fileText.includes(legacyNeedle)) {
        errors.push(`${repositoryRelativePath} contains legacy reference: ${legacyNeedle}`);
      }
    }
  }

  return errors;
};

const validateOfflineFallback = async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "armsx2-offline-source-"));

  try {
    const offlineSourcePath = join(temporaryDirectory, "apps.json");
    const offlineChecksumsPath = join(temporaryDirectory, "checksums.json");

    await execFileAsync(process.execPath, [
      generatorPath,
      "--offline",
      "--output",
      offlineSourcePath,
      "--checksums",
      offlineChecksumsPath,
    ], { cwd: repositoryRoot });

    const offlineSource = await jsonDocument(offlineSourcePath);
    const descriptions = (offlineSource.apps ?? [])
      .flatMap((sourceApp) => sourceApp.versions ?? [])
      .map((sourceVersion) => sourceVersion.localizedDescription)
      .filter(Boolean);

    if (descriptions.length === 0) {
      return ["offline fallback generation produced no version descriptions."];
    }

    if (descriptions.some((description) => !description.startsWith("Updated to ARMSX2 iOS"))) {
      return ["offline fallback generation produced an unpolished changelog."];
    }

    return [];
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const runValidation = async () => {
  const validationOptions = parseArguments(process.argv.slice(2));
  const sourceJson = await jsonDocument(resolve(repositoryRoot, validationOptions.sourcePath));
  const checksumJson = await jsonDocument(resolve(repositoryRoot, validationOptions.checksumPath));
  const errors = [
    ...await validateAgainstSideStoreSchema(sourceJson),
    ...validateStrictSourceShape(sourceJson),
    ...validateChecksumManifest(sourceJson, checksumJson),
    ...await validateGeneratedMirrors(validationOptions),
    ...await validateLocalAssets(sourceJson),
    ...await validateLocalIpas(sourceJson, checksumJson, validationOptions),
    ...(validationOptions.offlineFallback ? await validateOfflineFallback() : []),
    ...(validationOptions.legacyPurge ? await validateLegacyPurge() : []),
  ];

  if (errors.length > 0) {
    throw new SourceValidationError(errors);
  }

  console.log("apps.json and checksums.json validate against source, asset, and IPA checks.");
};

try {
  await runValidation();
} catch (validationError) {
  console.error(validationError instanceof Error ? validationError.message : validationError);
  process.exitCode = 1;
}
