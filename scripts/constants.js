import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sourceIdentifier = "com.j1coding.armsx2.ios";
export const bundleIdentifier = "com.armsx2.ios";
export const canonicalBaseUrl = "https://ios.armsx2.net";
export const canonicalSourceUrl = `${canonicalBaseUrl}/apps.json`;
export const defaultBaseUrl = canonicalBaseUrl;
