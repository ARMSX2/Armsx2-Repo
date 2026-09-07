#!/usr/bin/env node

import {
  bundleIdentifier,
  canonicalBaseUrl,
  canonicalSourceUrl,
  nightlyBundleIdentifier,
} from "./constants.js";

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

const fetchedJson = async (url) => {
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

const publishedChannel = (sourceJson, checksumJson, channelBundleIdentifier) => {
  const app = (sourceJson.apps ?? []).find((sourceApp) => sourceApp.bundleIdentifier === channelBundleIdentifier);
  const version = app?.versions?.[0];

  if (!app || !version) {
    return null;
  }

  return {
    app,
    version,
    entry: (checksumJson.files ?? []).find((file) => file.downloadURL === version.downloadURL) ?? null,
  };
};

const channelFailures = (label, channel, headChecks) => {
  const failures = [];
  const { app, version, entry } = channel;

  if (!version.version || !version.downloadURL) {
    failures.push(`${label} does not publish a version and downloadURL.`);
    return failures;
  }

  if (!isCanonicalPublicUrl(version.downloadURL)) {
    failures.push(`${label} downloadURL is ${version.downloadURL}; expected a ${canonicalBaseUrl} URL.`);
  }

  if (!entry) {
    failures.push(`${label} download ${version.downloadURL} is absent from the live checksums.`);
    return failures;
  }

  if (entry.bundleIdentifier !== app.bundleIdentifier) {
    failures.push(`${label} checksum entry is attributed to ${entry.bundleIdentifier}.`);
  }

  if (entry.version !== version.version) {
    failures.push(`${label} checksum version is ${entry.version}; the source publishes ${version.version}.`);
  }

  if (entry.fileName !== fileNameFromUrl(version.downloadURL)) {
    failures.push(`${label} checksum fileName is ${entry.fileName}; expected ${fileNameFromUrl(version.downloadURL)}.`);
  }

  if (entry.size !== version.size) {
    failures.push(`${label} checksum size is ${entry.size}; the source publishes ${version.size}.`);
  }

  if (!/^[0-9a-f]{64}$/u.test(entry.sha256 ?? "")) {
    failures.push(`${label} checksum sha256 is ${entry.sha256}; expected a lowercase SHA-256 hex digest.`);
  }

  if (version.sha256 !== entry.sha256) {
    failures.push(`${label} publishes sha256 ${version.sha256}; the checksums publish ${entry.sha256}.`);
  }

  const download = headChecks.find((result) => result.url === version.downloadURL);
  const servedSize = download?.ok && !download.contentEncoding && download.contentLength !== null
    ? Number(download.contentLength)
    : null;

  if (servedSize !== null && servedSize !== entry.size) {
    failures.push(`${version.downloadURL} is ${servedSize} bytes; the source publishes ${entry.size}.`);
  }

  return failures;
};

const runSmokeCheck = async () => {
  const [source, checksums] = await Promise.all([
    fetchedJson(canonicalSourceUrl),
    fetchedJson(canonicalChecksumsUrl),
  ]);

  const sourceJson = source.payload;
  const checksumJson = checksums.payload;
  const stable = publishedChannel(sourceJson, checksumJson, bundleIdentifier);

  if (!stable) {
    throw new Error(`${canonicalSourceUrl} does not publish ${bundleIdentifier}.`);
  }

  // Nightly is optional: the source is healthy on a day nothing was built.
  const nightly = publishedChannel(sourceJson, checksumJson, nightlyBundleIdentifier);
  const channels = [["stable", stable], ...(nightly ? [["nightly", nightly]] : [])];

  const liveUrls = [
    ...channels.map(([, channel]) => channel.version.downloadURL),
    stable.app.iconURL,
    ...(stable.app.screenshotURLs ?? []),
  ].filter(Boolean);

  const results = [source.check, checksums.check];

  for (const liveUrl of liveUrls) {
    results.push(await headCheck(liveUrl));
  }

  console.log(JSON.stringify({
    channels: Object.fromEntries(channels.map(([label, channel]) => [label, {
      version: channel.version.version,
      downloadURL: channel.version.downloadURL,
      size: channel.version.size,
      sha256: channel.version.sha256,
    }])),
    checks: results,
  }, null, 2));

  const failures = results
    .filter((result) => !result.ok)
    .map((result) => `${result.url} returned ${result.status}`);

  if (sourceJson.sourceURL !== canonicalSourceUrl) {
    failures.push(`Live sourceURL is ${sourceJson.sourceURL}; expected ${canonicalSourceUrl}.`);
  }

  if (checksumJson.sourceURL !== sourceJson.sourceURL) {
    failures.push(`Live checksums sourceURL is ${checksumJson.sourceURL}; expected ${sourceJson.sourceURL}.`);
  }

  for (const [label, channel] of channels) {
    failures.push(...channelFailures(label, channel, results));
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
