#!/usr/bin/env node

import { canonicalBaseUrl, canonicalSourceUrl } from "./constants.js";

const canonicalChecksumsUrl = `${canonicalBaseUrl}/checksums.json`;
const canonicalOrigin = new URL(canonicalBaseUrl).origin;

const checkResult = (url, response) => ({
  url,
  status: response.status,
  ok: response.ok,
  finalUrl: response.url,
  contentType: response.headers.get("content-type"),
  contentLength: response.headers.get("content-length"),
  contentEncoding: response.headers.get("content-encoding"),
});

const headCheck = async (url) =>
  checkResult(url, await fetch(url, { method: "HEAD", redirect: "follow" }));

const jsonDocument = async (url) => {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}.`);
  }

  return {
    check: checkResult(url, response),
    payload: await response.json(),
  };
};

const isCanonicalPublicUrl = (urlValue) => {
  try {
    return new URL(urlValue).origin === canonicalOrigin;
  } catch {
    return false;
  }
};

const fileNameFromUrl = (urlValue) => {
  try {
    return decodeURIComponent(new URL(urlValue).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
};

const runSmokeCheck = async () => {
  const [source, checksums] = await Promise.all([
    jsonDocument(canonicalSourceUrl),
    jsonDocument(canonicalChecksumsUrl),
  ]);

  const sourceJson = source.payload;
  const checksumJson = checksums.payload;
  const publishedApp = sourceJson.apps?.[0];
  const publishedVersion = publishedApp?.versions?.[0];
  const checksumEntry = checksumJson.files?.[0];
  const sourceVersion = publishedVersion?.version;
  const downloadURL = publishedVersion?.downloadURL;

  if (!sourceVersion || !downloadURL) {
    throw new Error(`${canonicalSourceUrl} does not publish apps[0].versions[0].version and .downloadURL.`);
  }

  if (!checksumEntry?.version || !checksumEntry?.downloadURL) {
    throw new Error(`${canonicalChecksumsUrl} does not publish files[0].version and .downloadURL.`);
  }

  const liveUrls = [
    downloadURL,
    publishedApp.iconURL,
    ...(publishedApp.screenshotURLs ?? []),
  ].filter(Boolean);

  const results = [source.check, checksums.check];

  for (const liveUrl of liveUrls) {
    results.push(await headCheck(liveUrl));
  }

  console.log(JSON.stringify({
    sourceVersion,
    checksumVersion: checksumEntry.version,
    downloadURL,
    size: checksumEntry.size,
    sha256: checksumEntry.sha256,
    checks: results,
  }, null, 2));

  const failures = results
    .filter((result) => !result.ok)
    .map((result) => `${result.url} returned ${result.status}`);

  if (sourceJson.sourceURL !== canonicalSourceUrl) {
    failures.push(`Live sourceURL is ${sourceJson.sourceURL}; expected ${canonicalSourceUrl}.`);
  }

  if (checksumJson.sourceURL !== sourceJson.sourceURL) {
    failures.push(`Live checksums.json sourceURL is ${checksumJson.sourceURL}; expected ${sourceJson.sourceURL}.`);
  }

  if (!isCanonicalPublicUrl(downloadURL)) {
    failures.push(`Live downloadURL is ${downloadURL}; expected a ${canonicalBaseUrl} URL.`);
  }

  if (checksumEntry.version !== sourceVersion) {
    failures.push(`Live checksums.json version is ${checksumEntry.version}; apps.json publishes ${sourceVersion}.`);
  }

  if (checksumEntry.downloadURL !== downloadURL) {
    failures.push(`Live checksums.json downloadURL is ${checksumEntry.downloadURL}; apps.json publishes ${downloadURL}.`);
  }

  if (checksumEntry.fileName !== fileNameFromUrl(downloadURL)) {
    failures.push(`Live checksums.json fileName is ${checksumEntry.fileName}; expected ${fileNameFromUrl(downloadURL)}.`);
  }

  if (checksumEntry.size !== publishedVersion.size) {
    failures.push(`Live checksums.json size is ${checksumEntry.size}; apps.json publishes ${publishedVersion.size}.`);
  }

  if (!/^[0-9a-f]{64}$/u.test(checksumEntry.sha256 ?? "")) {
    failures.push(`Live checksums.json sha256 is ${checksumEntry.sha256}; expected a lowercase SHA-256 hex digest.`);
  }

  const ipaCheck = results.find((result) => result.url === downloadURL);
  const publishedIpaSize = ipaCheck?.ok && !ipaCheck.contentEncoding && ipaCheck.contentLength !== null
    ? Number(ipaCheck.contentLength)
    : null;

  if (publishedIpaSize !== null && publishedIpaSize !== checksumEntry.size) {
    failures.push(`${downloadURL} is ${publishedIpaSize} bytes; checksums.json publishes ${checksumEntry.size}.`);
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
};

try {
  await runSmokeCheck();
} catch (smokeError) {
  console.error(smokeError instanceof Error ? smokeError.message : smokeError);
  process.exitCode = 1;
}
