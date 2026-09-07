import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { repositoryRoot } from "./constants.js";

export const repositoryPath = (entryPath) => relative(repositoryRoot, entryPath).split(sep).join("/");

export const normalizedPublicBaseUrl = (baseUrl) => {
  const publicBaseUrl = new URL(baseUrl);
  publicBaseUrl.pathname = publicBaseUrl.pathname.endsWith("/")
    ? publicBaseUrl.pathname
    : `${publicBaseUrl.pathname}/`;
  return publicBaseUrl.href;
};

export const publicAssetUrl = (baseUrl, publicRelativePath, fingerprint) => {
  const encodedPathSegments = publicRelativePath
    .split(/[\\/]/u)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

  const assetUrl = new URL(encodedPathSegments, normalizedPublicBaseUrl(baseUrl));

  if (fingerprint) {
    assetUrl.search = `v=${fingerprint}`;
  }

  return assetUrl.href;
};

// Images keep their filename across releases, and the edge caches them for years.
// A fingerprint in the query makes a changed file a different URL.
export const assetFingerprints = async (relativePaths) => {
  const entries = await Promise.all([...new Set(relativePaths)].map(async (assetPath) => [
    assetPath,
    createHash("sha256").update(await readFile(resolve(repositoryRoot, assetPath))).digest("hex").slice(0, 8),
  ]));

  return new Map(entries);
};

export const compactObject = (record) =>
  Object.fromEntries(
    Object.entries(record).filter(([, recordValue]) => recordValue !== null && recordValue !== undefined),
  );

export const jsonBuffer = (jsonPayload) =>
  Buffer.from(`${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");

export const optionalJsonDocument = async (jsonPath, fallbackPayload = {}) => {
  try {
    return JSON.parse(await readFile(jsonPath, "utf8"));
  } catch (filesystemError) {
    if (filesystemError?.code === "ENOENT") {
      return fallbackPayload;
    }

    throw filesystemError;
  }
};

export const readDirectoryEntries = async (inputDirectory) => {
  try {
    return await readdir(inputDirectory, { withFileTypes: true });
  } catch (filesystemError) {
    if (filesystemError?.code === "ENOENT") {
      return [];
    }

    throw filesystemError;
  }
};
