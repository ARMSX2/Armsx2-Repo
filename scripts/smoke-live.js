#!/usr/bin/env node

import { canonicalBaseUrl, canonicalSourceUrl } from "./constants.js";

const expectedVersion = "1.3";
const liveUrls = [
  canonicalSourceUrl,
  `${canonicalBaseUrl}/checksums.json`,
  `${canonicalBaseUrl}/ipas/ARMSX2-iOS-${expectedVersion}.ipa`,
  `${canonicalBaseUrl}/assets/icon.png`,
];

const headCheck = async (url) => {
  const response = await fetch(url, { method: "HEAD", redirect: "follow" });

  return {
    url,
    status: response.status,
    ok: response.ok,
    finalUrl: response.url,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
  };
};

const jsonDocument = async (url) => {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}.`);
  }

  return response.json();
};

const runSmokeCheck = async () => {
  const results = [];

  for (const liveUrl of liveUrls) {
    results.push(await headCheck(liveUrl));
  }

  const sourceJson = await jsonDocument(canonicalSourceUrl);
  const sourceVersion = sourceJson.apps?.[0]?.versions?.[0]?.version;
  const downloadURL = sourceJson.apps?.[0]?.versions?.[0]?.downloadURL;

  console.log(JSON.stringify({
    expectedVersion,
    sourceVersion,
    downloadURL,
    checks: results,
  }, null, 2));

  const failures = results
    .filter((result) => !result.ok)
    .map((result) => `${result.url} returned ${result.status}`);

  if (sourceJson.sourceURL !== canonicalSourceUrl) {
    failures.push(`Live sourceURL is ${sourceJson.sourceURL}; expected ${canonicalSourceUrl}.`);
  }

  if (sourceVersion !== expectedVersion) {
    failures.push(`Live version is ${sourceVersion}; expected ${expectedVersion}.`);
  }

  if (downloadURL !== `${canonicalBaseUrl}/ipas/ARMSX2-iOS-${expectedVersion}.ipa`) {
    failures.push(`Live downloadURL is ${downloadURL}; expected ${canonicalBaseUrl}/ipas/ARMSX2-iOS-${expectedVersion}.ipa.`);
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
