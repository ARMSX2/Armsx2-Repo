#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { parseOptions, setOptionFlag, setOptionValue } from "./cli.js";
import { defaultBaseUrl, repositoryRoot } from "./constants.js";
import { SourceGenerationError } from "./errors.js";
import { generatedBuffers, mirrorPublicAsset } from "./source-builder.js";

const defaults = {
  inputDirectory: "ipas",
  sourcePath: "apps.json",
  checksumPath: "checksums.json",
  metadataPath: "metadata/store.json",
  screenshotDirectory: null,
  upstreamReleaseRepo: process.env.ARMSX2_UPSTREAM_RELEASE_REPO || null,
  baseUrl: process.env.ARMSX2_PUBLIC_BASE_URL || defaultBaseUrl,
  check: false,
  requireIpa: false,
  offline: process.env.ARMSX2_OFFLINE === "1",
};

const parseArguments = (cliArguments) => parseOptions(
  cliArguments,
  defaults,
  {
    "--input-dir": setOptionValue("inputDirectory"),
    "--output": setOptionValue("sourcePath"),
    "--checksums": setOptionValue("checksumPath"),
    "--base-url": setOptionValue("baseUrl"),
    "--metadata": setOptionValue("metadataPath"),
    "--screenshots": setOptionValue("screenshotDirectory"),
    "--upstream-release-repo": setOptionValue("upstreamReleaseRepo"),
    "--check": setOptionFlag("check"),
    "--require-ipa": setOptionFlag("requireIpa"),
    "--offline": setOptionFlag("offline"),
  },
  (message) => new SourceGenerationError(message),
);

const writeGeneratedFile = async (outputPath, generatedBuffer) => {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generatedBuffer);
};

const checkedFileMatches = async (outputPath, generatedBuffer) => {
  try {
    const checkedInBuffer = await readFile(outputPath);
    return checkedInBuffer.equals(generatedBuffer);
  } catch (filesystemError) {
    if (filesystemError?.code === "ENOENT") {
      return false;
    }

    throw filesystemError;
  }
};

const defaultOutputPaths = (generatorOptions) =>
  generatorOptions.sourcePath === defaults.sourcePath
    && generatorOptions.checksumPath === defaults.checksumPath;

const outputTargets = (generatorOptions) => {
  const sourceOutputPath = resolve(repositoryRoot, generatorOptions.sourcePath);
  const checksumOutputPath = resolve(repositoryRoot, generatorOptions.checksumPath);
  const targets = [
    { label: "source", path: sourceOutputPath },
    { label: "checksums", path: checksumOutputPath },
  ];

  if (!defaultOutputPaths(generatorOptions)) {
    return targets;
  }

  return [
    ...targets,
    { label: "source", path: resolve(repositoryRoot, "public/apps.json") },
    { label: "checksums", path: resolve(repositoryRoot, "public/checksums.json") },
  ];
};

const assertGeneratedFilesCurrent = async (targets, generated) => {
  const targetStatuses = await Promise.all(
    targets.map(async (outputTarget) => ({
      ...outputTarget,
      current: await checkedFileMatches(outputTarget.path, generated[outputTarget.label]),
    })),
  );

  if (targetStatuses.every((targetStatus) => targetStatus.current)) {
    console.log(`Source files are current for ${generated.ipaCount} IPA file${generated.ipaCount === 1 ? "" : "s"}.`);
    return;
  }

  throw new SourceGenerationError("Generated source files are stale. Run npm run generate:source.");
};

const writeGeneratedTargets = async (targets, generated) => {
  for (const outputTarget of targets) {
    await writeGeneratedFile(outputTarget.path, generated[outputTarget.label]);
    console.log(`Generated ${relative(repositoryRoot, outputTarget.path).split(sep).join("/")}.`);
  }
};

const runGenerator = async () => {
  const generatorOptions = parseArguments(process.argv.slice(2));
  const generated = await generatedBuffers(generatorOptions);
  const targets = outputTargets(generatorOptions);

  if (generatorOptions.check) {
    await assertGeneratedFilesCurrent(targets, generated);
    return;
  }

  await writeGeneratedTargets(targets, generated);

  if (defaultOutputPaths(generatorOptions)) {
    for (const assetFile of generated.assetFiles) {
      await mirrorPublicAsset(assetFile);
    }
  }

  console.log(`Indexed ${generated.ipaCount} IPA file${generated.ipaCount === 1 ? "" : "s"}.`);
};

try {
  await runGenerator();
} catch (generationError) {
  console.error(generationError instanceof Error ? generationError.message : generationError);
  process.exitCode = 1;
}
