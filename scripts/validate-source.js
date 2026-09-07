#!/usr/bin/env node

import Ajv from "ajv";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { parseOptions, setOptionFlag, setOptionValue } from "./cli.js";
import {
  bundleIdentifier,
  canonicalBaseUrl,
  knownBundleIdentifiers,
  nightlyBundleIdentifier,
  nightlyDirectory,
  canonicalSourceUrl,
  repositoryRoot,
  sourceIdentifier,
} from "./constants.js";
import { ipaFileManifest } from "./ipa-metadata.js";
import { legacyReferenceErrors } from "./legacy-references.js";
import { nightlyVersion } from "./nightly-ipa.js";
import { optionalJsonDocument, repositoryPath } from "./source-utils.js";

const execFileAsync = promisify(execFile);
const schemaPath = resolve(repositoryRoot, "scripts/source-schema.json");
const generatorPath = resolve(repositoryRoot, "scripts/generate-source.js");

const defaults = {
  sourcePath: "apps.json",
  checksumPath: "checksums.json",
  ipaDirectory: "ipas",
  nightlyPath: "metadata/nightly.json",
  metadataPath: "metadata/store.json",
  nightlyDirectory: null,
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
    "--nightly": setOptionValue("nightlyPath"),
    "--metadata": setOptionValue("metadataPath"),
    "--nightly-dir": setOptionValue("nightlyDirectory"),
    "--skip-offline-fallback": setOptionFlag("offlineFallback", false),
    "--skip-legacy-purge": setOptionFlag("legacyPurge", false),
  },
  (message) => new ValidationArgumentError(message),
);

const jsonDocument = async (jsonPath) => {
  const jsonText = await readFile(jsonPath, "utf8");
  return JSON.parse(jsonText);
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

const validateAgainstSourceSchema = async (sourceJson) => {
  const schemaDocument = await jsonDocument(schemaPath);
  const schemaValidator = new Ajv({ allErrors: true, strict: true });
  const validateSource = schemaValidator.compile(schemaDocument);

  if (validateSource(sourceJson)) {
    return [];
  }

  return validateSource.errors.map((schemaError) => {
    const errorPath = schemaError.instancePath || "$";
    return `${errorPath} ${schemaError.message}`;
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

  if (!isCanonicalPublicUrl(sourceJson.iconURL)) {
    errors.push(`iconURL must use ${canonicalBaseUrl}.`);
  }

  // Feather rejects the whole document over a marketplaceID, so never emit one.
  const forbiddenSourceKeys = ["marketplaceID"];

  for (const forbiddenKey of forbiddenSourceKeys) {
    const matchingPaths = nestedKeyPaths(sourceJson, forbiddenKey);

    if (matchingPaths.length > 0) {
      errors.push(`apps.json must not contain ${forbiddenKey}: ${matchingPaths.join(", ")}`);
    }
  }

  const publishedIdentifiers = new Set();

  for (const [appIndex, sourceApp] of sourceJson.apps?.entries?.() ?? []) {
    if (!knownBundleIdentifiers.has(sourceApp.bundleIdentifier)) {
      errors.push(
        `apps[${appIndex}].bundleIdentifier must be one of ${[...knownBundleIdentifiers].join(", ")}.`,
      );
    }

    if (publishedIdentifiers.has(sourceApp.bundleIdentifier)) {
      errors.push(`apps[${appIndex}].bundleIdentifier ${sourceApp.bundleIdentifier} is listed twice.`);
    }

    publishedIdentifiers.add(sourceApp.bundleIdentifier);

    if (!isCanonicalPublicUrl(sourceApp.iconURL)) {
      errors.push(`apps[${appIndex}].iconURL must use ${canonicalBaseUrl}.`);
    }

    if (sourceApp.size !== sourceApp.versions?.[0]?.size) {
      errors.push(`apps[${appIndex}].size must match versions[0].size.`);
    }

    // We publish both keys. They must not disagree.
    if ((sourceApp.appPermissions?.privacy?.length ?? 0) !== (sourceApp.permissions?.length ?? 0)) {
      errors.push(`apps[${appIndex}].appPermissions.privacy must cover the same permissions as permissions.`);
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

  if (!publishedIdentifiers.has(bundleIdentifier)) {
    errors.push(`apps.json must publish ${bundleIdentifier}.`);
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

  const publishingApp = new Map(
    (sourceJson.apps ?? []).flatMap((sourceApp) =>
      (sourceApp.versions ?? []).map((sourceVersion) => [sourceVersion.downloadURL, sourceApp])),
  );

  for (const [fileIndex, checksumEntry] of checksumJson.files.entries()) {
    const checksumPath = `files[${fileIndex}]`;

    if (!knownBundleIdentifiers.has(checksumEntry.bundleIdentifier)) {
      errors.push(
        `${checksumPath}.bundleIdentifier must be one of ${[...knownBundleIdentifiers].join(", ")}.`,
      );
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

    const sourceApp = publishingApp.get(checksumEntry.downloadURL);

    if (!sourceApp) {
      errors.push(`${checksumPath}.downloadURL is absent from apps.json.`);
    } else if (sourceApp.bundleIdentifier !== checksumEntry.bundleIdentifier) {
      errors.push(
        `${checksumPath}.bundleIdentifier is ${checksumEntry.bundleIdentifier} but apps.json publishes that download under ${sourceApp.bundleIdentifier}.`,
      );
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

const validateLocalAssets = async (sourceJson) => {
  const errors = [];
  const assetUrls = [
    sourceJson.iconURL,
    ...(sourceJson.news ?? []).map((newsItem) => newsItem.imageURL),
    ...(sourceJson.apps ?? []).flatMap((sourceApp) => [
      sourceApp.iconURL,
      ...(sourceApp.screenshotURLs ?? []),
    ]),
  ].filter(Boolean);

  for (const assetUrl of assetUrls) {
    const assetPath = urlPathToRepositoryPath(assetUrl);

    if (!assetPath) {
      errors.push(`${assetUrl} does not map to a local asset path.`);
      continue;
    }

    await assertFileExists(assetPath, repositoryPath(assetPath), errors);
  }

  return errors;
};

const optionalFileStats = async (filePath) => {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
};

// Nightly binaries never land in the repo, so only the build being mirrored is
// on disk. --nightly-dir points at it; older rows have no file to check.
const localIpaPath = (checksumEntry, validationOptions) => {
  const fileName = basename(checksumEntry.fileName ?? "");

  if (checksumEntry.bundleIdentifier === nightlyBundleIdentifier) {
    return validationOptions.nightlyDirectory
      ? resolve(repositoryRoot, validationOptions.nightlyDirectory, fileName)
      : null;
  }

  return resolve(repositoryRoot, validationOptions.ipaDirectory, fileName);
};

const validateLocalIpas = async (sourceJson, checksumJson, validationOptions) => {
  const errors = [];
  const sourceVersionsByDownloadURL = new Map(
    matchingSourceVersions(sourceJson).map(({ version }) => [version.downloadURL, version]),
  );

  for (const [fileIndex, checksumEntry] of (checksumJson.files ?? []).entries()) {
    const checksumPath = `files[${fileIndex}]`;
    const sourceVersion = sourceVersionsByDownloadURL.get(checksumEntry.downloadURL);
    const ipaPath = localIpaPath(checksumEntry, validationOptions);

    if (!ipaPath) {
      continue;
    }

    const isNightly = checksumEntry.bundleIdentifier === nightlyBundleIdentifier;
    const fileStats = isNightly
      ? await optionalFileStats(ipaPath)
      : await assertFileExists(ipaPath, `${checksumPath}.fileName local IPA`, errors);

    if (!fileStats) {
      continue;
    }

    let manifest;
    try {
      manifest = await ipaFileManifest(ipaPath, {
        baseUrl: canonicalBaseUrl,
        bundleIdentifier: checksumEntry.bundleIdentifier,
      });
    } catch (metadataError) {
      const message = metadataError instanceof Error ? metadataError.message : String(metadataError);
      errors.push(`${checksumPath}.fileName could not be read as a valid IPA: ${message}`);
      continue;
    }

    if (fileStats.size !== checksumEntry.size) {
      errors.push(`${checksumPath}.size must match ${repositoryPath(ipaPath)} (${fileStats.size}).`);
    }

    if (manifest.sha256 !== checksumEntry.sha256) {
      errors.push(`${checksumPath}.sha256 must match ${repositoryPath(ipaPath)}.`);
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

    if (sourceVersion && sourceVersion.sha256 !== manifest.sha256) {
      errors.push(`${checksumPath}.sha256 must match apps.json for ${checksumEntry.downloadURL}.`);
    }
  }

  return errors;
};

// CI cannot re-hash a retained nightly, but it can insist every field of a row
// agrees with itself, which catches a hand-edited ledger.
export const ledgerRowSelfConsistency = (buildPath, build) => {
  const errors = [];

  if (!/^nightly-\d{8}$/u.test(build.tag ?? "")) {
    errors.push(`${buildPath}.tag ${build.tag} is not an upstream nightly tag.`);
    return errors;
  }

  if (!/^[0-9a-f]{7,40}$/u.test(build.commit ?? "")) {
    errors.push(`${buildPath}.commit ${build.commit} is not a commit hash.`);
    return errors;
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(build.publishedAt ?? "")) {
    errors.push(`${buildPath}.publishedAt ${build.publishedAt} is not a UTC timestamp.`);
    return errors;
  }

  const day = build.publishedAt.slice(0, 10).replaceAll("-", "");
  const expectedFileName = `ARMSX2-Nightly-${day}-${build.commit}.ipa`;

  if (build.fileName !== expectedFileName) {
    errors.push(`${buildPath}.fileName should be ${expectedFileName}.`);
  }

  if (build.date !== build.publishedAt.slice(0, 10)) {
    errors.push(`${buildPath}.date should be ${build.publishedAt.slice(0, 10)}.`);
  }

  const expectedVersion = nightlyVersion(build.upstreamVersion ?? "", build.publishedAt);

  if (build.version !== expectedVersion) {
    errors.push(`${buildPath}.version should be ${expectedVersion}.`);
  }

  return errors;
};

const nightlyVersionsFromSource = (sourceJson) =>
  (sourceJson.apps ?? [])
    .filter((sourceApp) => sourceApp.bundleIdentifier === nightlyBundleIdentifier)
    .flatMap((sourceApp) => sourceApp.versions ?? []);

const validateNightlyLedger = async (sourceJson, checksumJson, validationOptions) => {
  const errors = [];
  const ledger = await optionalJsonDocument(resolve(repositoryRoot, validationOptions.nightlyPath), {});
  const builds = ledger.builds ?? [];
  const retain = ledger.retain ?? 5;

  if (builds.length > retain) {
    errors.push(`metadata/nightly.json keeps ${builds.length} builds but retain is ${retain}.`);
  }

  const seenFileNames = new Set();
  const seenVersions = new Set();
  let previousTimestamp = null;

  for (const [buildIndex, build] of builds.entries()) {
    const buildPath = `nightly builds[${buildIndex}]`;

    if (seenFileNames.has(build.fileName)) {
      errors.push(`${buildPath}.fileName ${build.fileName} is listed twice.`);
    }

    if (seenVersions.has(build.version)) {
      errors.push(`${buildPath}.version ${build.version} is listed twice.`);
    }

    seenFileNames.add(build.fileName);
    seenVersions.add(build.version);
    errors.push(...ledgerRowSelfConsistency(buildPath, build));

    if (!/^[0-9a-f]{64}$/u.test(build.sha256 ?? "")) {
      errors.push(`${buildPath}.sha256 must be a lowercase SHA-256 hex digest.`);
    }

    if (!Number.isSafeInteger(build.size) || build.size <= 0) {
      errors.push(`${buildPath}.size must be a positive integer.`);
    }

    if (previousTimestamp !== null && !(build.publishedAt < previousTimestamp)) {
      errors.push(`${buildPath}.publishedAt must be older than the build before it.`);
    }

    previousTimestamp = build.publishedAt;
  }

  const publishedVersions = nightlyVersionsFromSource(sourceJson);

  if (publishedVersions.length !== builds.length) {
    errors.push(
      `apps.json publishes ${publishedVersions.length} nightly versions but the ledger holds ${builds.length}.`,
    );
    return errors;
  }

  const checksumsByDownloadURL = new Map(
    (checksumJson.files ?? []).map((checksumEntry) => [checksumEntry.downloadURL, checksumEntry]),
  );

  for (const [buildIndex, build] of builds.entries()) {
    const buildPath = `nightly builds[${buildIndex}]`;
    const published = publishedVersions[buildIndex];
    const expectedDownloadURL = `${canonicalBaseUrl}/${nightlyDirectory}/${build.fileName}`;

    if (published.downloadURL !== expectedDownloadURL) {
      errors.push(`${buildPath} is published as ${published.downloadURL}; expected ${expectedDownloadURL}.`);
      continue;
    }

    for (const field of ["version", "date", "size", "sha256"]) {
      if (published[field] !== build[field]) {
        errors.push(`${buildPath}.${field} does not match apps.json.`);
      }
    }

    const checksumEntry = checksumsByDownloadURL.get(expectedDownloadURL);

    if (!checksumEntry) {
      errors.push(`${buildPath} is absent from checksums.json.`);
      continue;
    }

    for (const field of ["version", "buildVersion", "date", "size", "sha256", "fileName"]) {
      if (checksumEntry[field] !== build[field]) {
        errors.push(`${buildPath}.${field} does not match checksums.json.`);
      }
    }
  }

  return errors;
};

// Nightly notes are stored in the ledger, so only stable exercises this path.
const fallbackOpening = (fallbackTemplate) => String(fallbackTemplate ?? "").split("{")[0].trim();

const validateOfflineFallback = async (validationOptions) => {
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
    const metadata = await jsonDocument(resolve(repositoryRoot, validationOptions.metadataPath));
    const expectedOpening = fallbackOpening(metadata.releaseNotes?.fallback);
    const stableApp = (offlineSource.apps ?? []).find((sourceApp) => sourceApp.bundleIdentifier === bundleIdentifier);
    const described = (stableApp?.versions ?? []).filter((sourceVersion) => sourceVersion.localizedDescription);
    const errors = [];

    if (!expectedOpening) {
      errors.push(`${validationOptions.metadataPath} has no releaseNotes.fallback to fall back to.`);
    }

    if (described.length === 0) {
      errors.push("offline fallback generation produced no stable version descriptions.");
    }

    for (const sourceVersion of described) {
      if (expectedOpening && !sourceVersion.localizedDescription.startsWith(expectedOpening)) {
        errors.push(`offline fallback generation produced an unpolished changelog for ${bundleIdentifier}.`);
      }
    }

    return [...new Set(errors)];
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const runValidation = async () => {
  const validationOptions = parseArguments(process.argv.slice(2));
  const sourceJson = await jsonDocument(resolve(repositoryRoot, validationOptions.sourcePath));
  const checksumJson = await jsonDocument(resolve(repositoryRoot, validationOptions.checksumPath));
  const errors = [
    ...await validateAgainstSourceSchema(sourceJson),
    ...validateStrictSourceShape(sourceJson),
    ...validateChecksumManifest(sourceJson, checksumJson),
    ...await validateNightlyLedger(sourceJson, checksumJson, validationOptions),
    ...await validateLocalAssets(sourceJson),
    ...await validateLocalIpas(sourceJson, checksumJson, validationOptions),
    ...(validationOptions.offlineFallback ? await validateOfflineFallback(validationOptions) : []),
    ...(validationOptions.legacyPurge ? await legacyReferenceErrors() : []),
  ];

  if (errors.length > 0) {
    throw new SourceValidationError(errors);
  }

  console.log("apps.json and checksums.json validate against source, asset, and IPA checks.");
};

// Imported by the tests. Guard the run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runValidation();
  } catch (validationError) {
    console.error(validationError instanceof Error ? validationError.message : validationError);
    process.exitCode = 1;
  }
}
