import { createRequire } from "node:module";

import { nightlyBundleIdentifier } from "./constants.js";
import { SourceGenerationError } from "./errors.js";
import { mainInfoPlistEntry, parseInfoPlist } from "./ipa-metadata.js";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const plist = require("plist");

const nightlyDisplayName = "ARMSX2 Nightly";

const twoDigits = (value) => String(value).padStart(2, "0");

// 2.5.3-nightly.20260906.1536 — fixed width so it sorts by date then time
// whether the reader compares semantically or as plain text.
export const nightlyVersion = (upstreamVersion, publishedAt) => {
  const published = new Date(publishedAt);

  if (Number.isNaN(published.getTime())) {
    throw new SourceGenerationError(`${publishedAt} is not a usable publish time.`);
  }

  const day = [
    published.getUTCFullYear(),
    twoDigits(published.getUTCMonth() + 1),
    twoDigits(published.getUTCDate()),
  ].join("");
  const minute = `${twoDigits(published.getUTCHours())}${twoDigits(published.getUTCMinutes())}`;

  return `${upstreamVersion}-nightly.${day}.${minute}`;
};

export const patchedInfoPlist = (infoPlist, version) => {
  const currentIdentifier = infoPlist.CFBundleIdentifier;

  if (currentIdentifier !== "com.armsx2.ios" && currentIdentifier !== nightlyBundleIdentifier) {
    throw new SourceGenerationError(
      `${currentIdentifier} is not an ARMSX2 iOS bundle; refusing to publish it as a nightly.`,
    );
  }

  return {
    ...infoPlist,
    CFBundleIdentifier: nightlyBundleIdentifier,
    CFBundleDisplayName: nightlyDisplayName,
    CFBundleShortVersionString: version,
  };
};

const infoPlistEntry = (archive, ipaFilePath) => {
  const entry = mainInfoPlistEntry(archive, ipaFilePath);
  return { entry, infoPlist: parseInfoPlist(entry.getData()) };
};

const assertRepacked = (targetPath, originalPlist, version) => {
  const archive = new AdmZip(targetPath);
  const { infoPlist } = infoPlistEntry(archive, targetPath);

  const changed = ["CFBundleIdentifier", "CFBundleDisplayName", "CFBundleShortVersionString"];
  const unchanged = Object.keys(originalPlist).filter((key) => !changed.includes(key));

  if (infoPlist.CFBundleIdentifier !== nightlyBundleIdentifier
    || infoPlist.CFBundleDisplayName !== nightlyDisplayName
    || infoPlist.CFBundleShortVersionString !== version) {
    throw new SourceGenerationError(`${targetPath} did not come back with the patched identity.`);
  }

  for (const key of unchanged) {
    if (JSON.stringify(infoPlist[key]) !== JSON.stringify(originalPlist[key])) {
      throw new SourceGenerationError(`${targetPath} lost or altered ${key} during the repack.`);
    }
  }

  return archive.getEntries().length;
};

// The upstream nightly ships the stable bundle identifier, so installing one
// would replace the user's stable app. Rewrite the identity so the two are
// separate apps. The IPAs are unsigned, so there is no signature to break, and
// adm-zip copies every entry we do not touch verbatim.
export const repackNightlyIpa = async (sourcePath, targetPath, version) => {
  const archive = new AdmZip(sourcePath);
  const { entry, infoPlist } = infoPlistEntry(archive, sourcePath);
  const entryCount = archive.getEntries().length;

  entry.setData(Buffer.from(plist.build(patchedInfoPlist(infoPlist, version)), "utf8"));
  archive.writeZip(targetPath);

  const repackedEntryCount = assertRepacked(targetPath, infoPlist, version);

  if (repackedEntryCount !== entryCount) {
    throw new SourceGenerationError(
      `${targetPath} has ${repackedEntryCount} entries; the source had ${entryCount}.`,
    );
  }

  return targetPath;
};
