import { readdir, readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import { repositoryRoot } from "./constants.js";

export const repositoryPath = (entryPath) => relative(repositoryRoot, entryPath).split(sep).join("/");

export const normalizedPublicBaseUrl = (baseUrl) => {
  const publicBaseUrl = new URL(baseUrl);
  publicBaseUrl.pathname = publicBaseUrl.pathname.endsWith("/")
    ? publicBaseUrl.pathname
    : `${publicBaseUrl.pathname}/`;
  return publicBaseUrl.href;
};

export const publicAssetUrl = (baseUrl, publicRelativePath) => {
  const encodedPathSegments = publicRelativePath
    .split(/[\\/]/u)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

  return new URL(encodedPathSegments, normalizedPublicBaseUrl(baseUrl)).href;
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
