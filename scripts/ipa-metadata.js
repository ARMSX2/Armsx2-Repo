import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { bundleIdentifier } from "./constants.js";
import { SourceGenerationError } from "./errors.js";
import { publicAssetUrl } from "./source-utils.js";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const binaryPlistParser = require("bplist-parser");
const xmlPlistParser = require("plist");

const sha256ForFile = async (ipaFilePath) => {
  const hash = createHash("sha256");

  await pipeline(
    createReadStream(ipaFilePath),
    new Writable({
      write(chunk, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );

  return hash.digest("hex");
};

export const mainInfoPlistEntry = (ipaArchive, ipaFilePath) => {
  const matchingEntries = ipaArchive
    .getEntries()
    .filter((archiveEntry) =>
      /^Payload\/[^/]+\.app\/Info\.plist$/u.test(archiveEntry.entryName.replaceAll("\\", "/")),
    );

  if (matchingEntries.length === 1) {
    return matchingEntries[0];
  }

  if (matchingEntries.length > 1) {
    throw new SourceGenerationError(`${basename(ipaFilePath)} contains multiple app Info.plist files.`);
  }

  throw new SourceGenerationError(`${basename(ipaFilePath)} is missing Payload/*.app/Info.plist.`);
};

const parseBinaryInfoPlist = (infoPlistBuffer) => {
  const parsedPlists = binaryPlistParser.parseBuffer(infoPlistBuffer);
  const parsedInfoPlist = parsedPlists?.[0];

  if (!parsedInfoPlist || typeof parsedInfoPlist !== "object" || Array.isArray(parsedInfoPlist)) {
    throw new SourceGenerationError("Binary Info.plist did not decode to an object.");
  }

  return parsedInfoPlist;
};

const parseXmlInfoPlist = (infoPlistBuffer) => {
  const infoPlistXml = infoPlistBuffer.toString("utf8").replace(/^\uFEFF/u, "");
  const parsedInfoPlist = xmlPlistParser.parse(infoPlistXml);

  if (!parsedInfoPlist || typeof parsedInfoPlist !== "object" || Array.isArray(parsedInfoPlist)) {
    throw new SourceGenerationError("XML Info.plist did not decode to an object.");
  }

  return parsedInfoPlist;
};

export const parseInfoPlist = (infoPlistBuffer) => {
  if (infoPlistBuffer.subarray(0, 6).toString("ascii") === "bplist") {
    return parseBinaryInfoPlist(infoPlistBuffer);
  }

  return parseXmlInfoPlist(infoPlistBuffer);
};

const infoPlistString = (infoPlist, plistKey) => {
  const plistValue = infoPlist[plistKey];

  if (plistValue === undefined || plistValue === null) {
    return null;
  }

  return String(plistValue).trim() || null;
};

const requiredInfoPlistString = (infoPlist, plistKey, ipaFileName) => {
  const plistValue = infoPlistString(infoPlist, plistKey);

  if (plistValue) {
    return plistValue;
  }

  throw new SourceGenerationError(`${ipaFileName} is missing ${plistKey}.`);
};

const sourceDate = (isoTimestamp) => isoTimestamp.slice(0, 10);

const sourceTimestampFromStats = (fileStats) => {
  const timestampMilliseconds = fileStats.birthtimeMs > 0
    ? fileStats.birthtimeMs
    : fileStats.mtimeMs;

  return new Date(timestampMilliseconds).toISOString();
};

const timestampFromDosTime = (dosTimeValue) => {
  if (!Number.isSafeInteger(dosTimeValue)) {
    return null;
  }

  const dosTime = dosTimeValue & 0xffff;
  const dosDate = dosTimeValue >>> 16;
  const year = 1980 + ((dosDate >>> 9) & 0x7f);
  const month = (dosDate >>> 5) & 0xf;
  const day = dosDate & 0x1f;
  const hour = (dosTime >>> 11) & 0x1f;
  const minute = (dosTime >>> 5) & 0x3f;
  const second = (dosTime & 0x1f) * 2;

  if (month < 1 || day < 1) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
};

const archiveEntryTimestamp = (archiveEntry) => {
  const dosTimestamp = timestampFromDosTime(archiveEntry.header?.timeval);

  if (dosTimestamp) {
    return dosTimestamp;
  }

  const entryTime = archiveEntry.header?.time;
  if (!(entryTime instanceof Date)) {
    return null;
  }

  const entryTimestamp = entryTime.getTime();

  if (!Number.isFinite(entryTimestamp)) {
    return null;
  }

  return entryTime.toISOString();
};

const latestArchiveTimestamp = (ipaArchive) => {
  const entryTimestamps = ipaArchive
    .getEntries()
    .map(archiveEntryTimestamp)
    .filter(Boolean)
    .sort();

  return entryTimestamps.at(-1) ?? null;
};

const extractIpaMetadata = (ipaFilePath) => {
  const ipaArchive = new AdmZip(ipaFilePath);
  const infoPlistEntry = mainInfoPlistEntry(ipaArchive, ipaFilePath);

  return {
    infoPlist: parseInfoPlist(infoPlistEntry.getData()),
    packageTimestamp: latestArchiveTimestamp(ipaArchive),
  };
};

const privacyPermission = (infoPlist, plistKey, permissionType) => {
  const usageDescription = infoPlistString(infoPlist, plistKey);

  if (!usageDescription) {
    return null;
  }

  return { type: permissionType, usageDescription };
};

// Plist key, the type we publish, and the name sideloaders label it with.
const permissionMappings = [
  ["NSPhotoLibraryUsageDescription", "photos", "PhotoLibrary"],
  ["NSPhotoLibraryAddUsageDescription", "photos", "PhotoLibrary"],
  ["NSCameraUsageDescription", "camera", "Camera"],
  ["NSLocationWhenInUseUsageDescription", "location", "Location"],
  ["NSLocationAlwaysAndWhenInUseUsageDescription", "location", "Location"],
  ["NSContactsUsageDescription", "contacts", "Contacts"],
  ["NSRemindersUsageDescription", "reminders", "Reminders"],
  ["NSAppleMusicUsageDescription", "music", "AppleMusic"],
  ["NSMediaLibraryUsageDescription", "music", "AppleMusic"],
  ["NSMicrophoneUsageDescription", "microphone", "Microphone"],
  ["NSSpeechRecognitionUsageDescription", "speech-recognition", "SpeechRecognition"],
  ["NSBluetoothAlwaysUsageDescription", "bluetooth", "Bluetooth"],
  ["NSBluetoothPeripheralUsageDescription", "bluetooth", "Bluetooth"],
  ["NSLocalNetworkUsageDescription", "network", "LocalNetwork"],
  ["NSCalendarsUsageDescription", "calendars", "Calendars"],
  ["NSFaceIDUsageDescription", "faceid", "FaceID"],
  ["NSSiriUsageDescription", "siri", "Siri"],
  ["NSMotionUsageDescription", "motion", "Motion"],
];

const privacyPermissionNames = new Map(
  permissionMappings.map(([, permissionType, permissionName]) => [permissionType, permissionName]),
);

const appPermissions = (infoPlist) => {
  const permissionRecords = new Map();

  for (const [plistKey, permissionType] of permissionMappings) {
    if (permissionRecords.has(permissionType)) {
      continue;
    }

    const permissionRecord = privacyPermission(infoPlist, plistKey, permissionType);

    if (permissionRecord) {
      permissionRecords.set(permissionType, permissionRecord);
    }
  }

  return [...permissionRecords.values()];
};

// appPermissions is the key clients render. The older permissions array is
// published alongside it, the way the format's own reference source does.
export const sourceAppPermissions = (permissions) => {
  const privacy = permissions
    .map(({ type, usageDescription }) => ({ name: privacyPermissionNames.get(type), usageDescription }))
    .filter((entry) => entry.name);

  return privacy.length ? { privacy } : undefined;
};

const semanticVersionParts = (versionLabel) => {
  const semanticMatch = String(versionLabel).match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/u);

  if (!semanticMatch) {
    return null;
  }

  const [, majorVersion, minorVersion = "0", patchVersion = "0", prereleaseLabel = ""] = semanticMatch;

  return {
    core: [majorVersion, minorVersion, patchVersion].map((versionSegment) => Number.parseInt(versionSegment, 10)),
    prereleaseLabel,
  };
};

const compareSemanticVersions = (leftVersion, rightVersion) => {
  const leftParts = semanticVersionParts(leftVersion);
  const rightParts = semanticVersionParts(rightVersion);

  if (!leftParts || !rightParts) {
    return String(leftVersion).localeCompare(String(rightVersion), undefined, { numeric: true });
  }

  for (const versionIndex of [0, 1, 2]) {
    const versionDelta = leftParts.core[versionIndex] - rightParts.core[versionIndex];

    if (versionDelta !== 0) {
      return versionDelta;
    }
  }

  if (leftParts.prereleaseLabel && !rightParts.prereleaseLabel) {
    return -1;
  }

  if (!leftParts.prereleaseLabel && rightParts.prereleaseLabel) {
    return 1;
  }

  return leftParts.prereleaseLabel.localeCompare(rightParts.prereleaseLabel, undefined, { numeric: true });
};

const compareBuildVersions = (leftBuildVersion, rightBuildVersion) =>
  String(leftBuildVersion).localeCompare(String(rightBuildVersion), undefined, { numeric: true });

export const compareIpaManifests = (leftManifest, rightManifest) => {
  const semanticDelta = compareSemanticVersions(rightManifest.version, leftManifest.version);

  if (semanticDelta !== 0) {
    return semanticDelta;
  }

  const buildDelta = compareBuildVersions(rightManifest.buildVersion, leftManifest.buildVersion);

  if (buildDelta !== 0) {
    return buildDelta;
  }

  return rightManifest.sourceTimestamp.localeCompare(leftManifest.sourceTimestamp);
};

export const ipaFileManifest = async (ipaFilePath, generatorOptions) => {
  const ipaFileName = basename(ipaFilePath);
  const fileStats = await stat(ipaFilePath);
  const { infoPlist, packageTimestamp } = extractIpaMetadata(ipaFilePath);
  const manifestTimestamp = packageTimestamp ?? sourceTimestampFromStats(fileStats);
  const ipaBundleIdentifier = requiredInfoPlistString(infoPlist, "CFBundleIdentifier", ipaFileName);
  const expectedBundleIdentifier = generatorOptions.bundleIdentifier ?? bundleIdentifier;

  if (ipaBundleIdentifier !== expectedBundleIdentifier) {
    throw new SourceGenerationError(
      `${ipaFileName} reports ${ipaBundleIdentifier}; expected ${expectedBundleIdentifier}.`,
    );
  }

  const version = requiredInfoPlistString(infoPlist, "CFBundleShortVersionString", ipaFileName);
  const buildVersion = requiredInfoPlistString(infoPlist, "CFBundleVersion", ipaFileName);
  const downloadURL = publicAssetUrl(generatorOptions.baseUrl, `ipas/${ipaFileName}`);

  return {
    fileName: ipaFileName,
    bundleIdentifier: ipaBundleIdentifier,
    version,
    buildVersion,
    date: sourceDate(manifestTimestamp),
    sourceTimestamp: manifestTimestamp,
    downloadURL,
    size: fileStats.size,
    sha256: await sha256ForFile(ipaFilePath),
    minOSVersion: infoPlistString(infoPlist, "MinimumOSVersion")
      || infoPlistString(infoPlist, "LSMinimumSystemVersion"),
    maxOSVersion: infoPlistString(infoPlist, "MaximumOSVersion"),
    permissions: appPermissions(infoPlist),
  };
};
