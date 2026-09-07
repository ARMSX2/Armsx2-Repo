import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { UpstreamSyncError } from "./errors.js";

export const githubHeaders = (accept = "application/vnd.github+json") => {
  const headers = {
    Accept: accept,
    "User-Agent": "J1coding-ARMSX2-Source-Updater/2.1",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
};

export const githubReleases = async (repositoryName) => {
  const releaseResponse = await fetch(`https://api.github.com/repos/${repositoryName}/releases?per_page=100`, {
    headers: githubHeaders(),
  });

  if (!releaseResponse.ok) {
    throw new UpstreamSyncError(`GitHub release lookup failed: ${releaseResponse.status}`);
  }

  const releasePayload = await releaseResponse.json();

  if (!Array.isArray(releasePayload)) {
    throw new UpstreamSyncError("GitHub release lookup returned an unexpected payload.");
  }

  return releasePayload;
};

// Hashes while it streams, so the file is never read a second time.
export const downloadAssetToFile = async (releaseAsset, outputPath) => {
  const assetResponse = await fetch(releaseAsset.url, {
    headers: githubHeaders("application/octet-stream"),
  });

  if (!assetResponse.ok) {
    throw new UpstreamSyncError(`IPA download failed: ${assetResponse.status}`);
  }

  if (!assetResponse.body) {
    throw new UpstreamSyncError("IPA download returned an empty response body.");
  }

  const hash = createHash("sha256");
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await pipeline(
    Readable.fromWeb(assetResponse.body),
    hashingStream,
    createWriteStream(outputPath),
  );

  return hash.digest("hex");
};

export const writeGithubOutput = async (payload) => {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const { appendFile } = await import("node:fs/promises");
  const outputLines = Object.entries(payload)
    .map(([outputKey, outputValue]) => `${outputKey}=${String(outputValue).replaceAll("\n", " ")}`)
    .join("\n");

  await appendFile(process.env.GITHUB_OUTPUT, `${outputLines}\n`, "utf8");
};
