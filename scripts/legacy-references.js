import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { repositoryRoot } from "./constants.js";
import { repositoryPath } from "./source-utils.js";

// Left over from the GitHub Pages setup. A stray one in a README or a workflow
// still sends people somewhere that no longer exists.
const needles = [
  "AltStore",
  "PC build",
  "Cydia",
  "Sileo",
  "source.json",
  "releases.json",
];

// Spelling the needles out means this file would always match itself.
const excludedFiles = new Set(["scripts/legacy-references.js"]);

const scanRoots = [
  ".github",
  "README.md",
  "index.html",
  "metadata",
  "scripts",
  "package.json",
  "apps.json",
  "checksums.json",
];

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

const skippedDirectories = new Set([".git", "node_modules"]);

const isTextFile = (entryPath, entryStats) =>
  entryStats.size <= 1024 * 1024
    && (textExtensions.has(extname(entryPath).toLowerCase()) || repositoryPath(entryPath) === ".gitignore");

const textFilesUnder = async (entryPath) => {
  if (excludedFiles.has(repositoryPath(entryPath))) {
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
  const found = [];

  for (const directoryEntry of directoryEntries) {
    if (directoryEntry.isDirectory() && skippedDirectories.has(directoryEntry.name)) {
      continue;
    }

    found.push(...await textFilesUnder(join(entryPath, directoryEntry.name)));
  }

  return found;
};

const scannedFiles = async () => {
  const found = [];

  for (const scanRoot of scanRoots) {
    try {
      found.push(...await textFilesUnder(resolve(repositoryRoot, scanRoot)));
    } catch (filesystemError) {
      if (filesystemError?.code !== "ENOENT") {
        throw filesystemError;
      }
    }
  }

  return [...new Set(found)];
};

export const legacyReferenceErrors = async () => {
  const errors = [];

  for (const filePath of await scannedFiles()) {
    const fileText = await readFile(filePath, "utf8");

    for (const needle of needles) {
      if (fileText.includes(needle)) {
        errors.push(`${repositoryPath(filePath)} contains legacy reference: ${needle}`);
      }
    }
  }

  return errors;
};
