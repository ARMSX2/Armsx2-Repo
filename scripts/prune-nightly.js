#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseOptions, setOptionValue } from "./cli.js";
import {
  canonicalSourceUrl,
  nightlyBundleIdentifier,
  nightlyDirectory,
  repositoryRoot,
} from "./constants.js";
import { UpstreamSyncError } from "./errors.js";
import { optionalJsonDocument } from "./source-utils.js";

// Deliberately narrow: exactly what publishedFileName produces, and the
// hidden temp name rsync leaves behind when a transfer is interrupted.
const publishedName = /^ARMSX2-Nightly-\d{8}-[0-9a-f]{7,40}\.ipa$/u;
const abandonedUpload = /^\.ARMSX2-Nightly-\d{8}-[0-9a-f]{7,40}\.ipa\.[A-Za-z0-9]{6}$/u;

const defaults = {
  sourceUrl: canonicalSourceUrl,
  nightlyPath: "metadata/nightly.json",
};

const parseArguments = (cliArguments) => parseOptions(
  cliArguments,
  defaults,
  {
    "--source-url": setOptionValue("sourceUrl"),
    "--nightly": setOptionValue("nightlyPath"),
  },
  (message) => new UpstreamSyncError(message),
);

export const publishedNightlyFileNames = (sourceJson) => new Set(
  (sourceJson.apps ?? [])
    .filter((sourceApp) => sourceApp.bundleIdentifier === nightlyBundleIdentifier)
    .flatMap((sourceApp) => sourceApp.versions ?? [])
    .map((sourceVersion) => sourceVersion.downloadURL)
    .map((downloadURL) => {
      try {
        return decodeURIComponent(new URL(downloadURL).pathname.split("/").pop() ?? "");
      } catch {
        return "";
      }
    })
    .filter(Boolean),
);

export const ledgerNightlyFileNames = (ledger) => new Set(
  (ledger.builds ?? []).map((build) => build.fileName).filter(Boolean),
);

export const retainedNightlyFileNames = (sourceJson, ledger) => new Set([
  ...publishedNightlyFileNames(sourceJson),
  ...ledgerNightlyFileNames(ledger),
]);

// Anything unrecognised is left alone: we only delete our own files.
export const prunableNightlies = (remoteNames, publishedNames) => {
  const remove = [];
  const keep = [];
  const unknown = [];

  for (const remoteName of remoteNames) {
    if (abandonedUpload.test(remoteName)) {
      remove.push(remoteName);
    } else if (!publishedName.test(remoteName)) {
      unknown.push(remoteName);
    } else if (publishedNames.has(remoteName)) {
      keep.push(remoteName);
    } else {
      remove.push(remoteName);
    }
  }

  return { remove, keep, unknown };
};

const readStdin = async () => {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

// A build is safe to delete only when neither the ledger nor the live document
// names it. Both halves matter, and in opposite directions. The ledger covers a
// build that was just uploaded, because publishing it is a separate deploy that
// has not run yet — without this the prune deletes the upload it just made. The
// live document covers a build the ledger has already dropped, which someone may
// still be downloading until the new document is actually served.
const liveSource = async (sourceUrl) => {
  const response = await fetch(sourceUrl, { headers: { Accept: "application/json" } });

  if (!response.ok) {
    throw new UpstreamSyncError(`${sourceUrl} returned ${response.status}; refusing to prune.`);
  }

  return response.json();
};

const runPrune = async () => {
  const pruneOptions = parseArguments(process.argv.slice(2));
  const remoteNames = (await readStdin()).split("\n").map((line) => line.trim()).filter(Boolean);
  const ledger = await optionalJsonDocument(resolve(repositoryRoot, pruneOptions.nightlyPath));
  const kept = retainedNightlyFileNames(await liveSource(pruneOptions.sourceUrl), ledger);
  const { remove, keep, unknown } = prunableNightlies(remoteNames, kept);

  for (const name of unknown) {
    console.error(`Leaving ${nightlyDirectory}/${name} alone: not a name this tool publishes.`);
  }

  console.error(`Keeping ${keep.length}, removing ${remove.length}, ignoring ${unknown.length}.`);
  console.log(remove.join("\n"));
};

// The tests import this file, so only prune when it is the entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runPrune();
  } catch (pruneError) {
    console.error(pruneError instanceof Error ? pruneError.message : String(pruneError));
    process.exitCode = 1;
  }
}
