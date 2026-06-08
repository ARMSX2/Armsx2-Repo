import { useEffect, useState } from "react";
import { absoluteUrl, firstParagraph, formatBytes, formattedBlocks } from "./format";

const DESCRIPTION_FALLBACK = "Modern PlayStation 2 emulation for iOS.";
const HERO_FALLBACK = "Add ARMSX2 iOS to LiveContainer, SideStore, or Feather to install the latest build.";

const buildSourceView = (sourcePayload, sourceRequestUrl) => {
  const [sourceApp] = sourcePayload.apps || [];
  const [currentVersion] = sourceApp?.versions || [];

  if (!sourceApp || !currentVersion) {
    throw new Error("apps.json does not contain an app version.");
  }

  return {
    canonicalSourceUrl: absoluteUrl(sourcePayload.sourceURL || sourceRequestUrl),
    sourceName: sourcePayload.name || sourceApp.name,
    appName: sourceApp.name,
    subtitle: sourceApp.subtitle || DESCRIPTION_FALLBACK,
    iconURL: absoluteUrl(sourceApp.iconURL || "assets/icon.png"),
    heroDescription: firstParagraph(sourceApp.localizedDescription) || HERO_FALLBACK,
    version: currentVersion.version || "Unavailable",
    date: currentVersion.date || "Unavailable",
    minOSVersion: currentVersion.minOSVersion || "Device dependent",
    minOSRequirementText: currentVersion.minOSVersion
      ? `Requires iOS ${currentVersion.minOSVersion} or later.`
      : "Minimum iOS version depends on the current build.",
    whatsNewVersionLabel: currentVersion.version
      ? `Version ${currentVersion.version}`
      : "Latest version",
    releaseNotes: currentVersion.localizedDescription || "",
    screenshotURLs: Array.isArray(sourceApp.screenshotURLs)
      ? sourceApp.screenshotURLs.map(absoluteUrl)
      : [],
    descriptionBlocks: formattedBlocks(sourceApp.localizedDescription),
    versionManifest: currentVersion,
  };
};

const buildIntegrity = (checksumPayload, versionManifest) => {
  const checksumEntry = checksumPayload.files?.find((checksumFile) => {
    if (!versionManifest) {
      return false;
    }
    return checksumFile.downloadURL === versionManifest.downloadURL
      || checksumFile.version === versionManifest.version;
  });

  if (!checksumEntry) {
    return { unavailable: true };
  }

  const items = [
    `SHA-256 ${checksumEntry.sha256?.slice(0, 16) || "unavailable"}...`,
    formatBytes(checksumEntry.size),
    checksumEntry.buildVersion ? `Build ${checksumEntry.buildVersion}` : "",
    checksumPayload.generatedAt ? `Generated ${checksumPayload.generatedAt.slice(0, 10)}` : "",
  ].filter(Boolean);

  return { items };
};

export const useSource = () => {
  const [state, setState] = useState({
    loading: true,
    error: null,
    source: null,
    integrity: null,
    canonicalSourceUrl: typeof document !== "undefined"
      ? new URL("apps.json", document.baseURI).href
      : "",
  });

  useEffect(() => {
    let cancelled = false;
    const sourceRequestUrl = new URL("apps.json", document.baseURI).href;
    const checksumsRequestUrl = new URL("checksums.json", document.baseURI).href;

    const run = async () => {
      let source;
      try {
        const sourceResponse = await fetch(sourceRequestUrl, {
          headers: { Accept: "application/json" },
        });
        if (!sourceResponse.ok) {
          throw new Error(`Source request failed: ${sourceResponse.status}`);
        }
        source = buildSourceView(await sourceResponse.json(), sourceRequestUrl);
      } catch (sourceError) {
        if (cancelled) return;
        const message = sourceError instanceof Error ? sourceError.message : String(sourceError);
        console.error("Failed to load apps.json:", sourceError);
        setState((prev) => ({
          ...prev,
          loading: false,
          error: message,
          source: null,
        }));
        return;
      }

      if (cancelled) return;

      document.title = source.appName;
      const descriptionMeta = document.querySelector("meta[name='description']");
      if (descriptionMeta) {
        descriptionMeta.content = source.subtitle || DESCRIPTION_FALLBACK;
      }

      setState((prev) => ({
        ...prev,
        loading: false,
        error: null,
        source,
        canonicalSourceUrl: source.canonicalSourceUrl,
      }));

      try {
        const checksumResponse = await fetch(checksumsRequestUrl, {
          headers: { Accept: "application/json" },
        });
        if (!checksumResponse.ok) {
          throw new Error(`Checksum request failed: ${checksumResponse.status}`);
        }
        const integrity = buildIntegrity(await checksumResponse.json(), source.versionManifest);
        if (cancelled) return;
        setState((prev) => ({ ...prev, integrity }));
      } catch (checksumError) {
        if (cancelled) return;
        console.error("Failed to load checksums.json:", checksumError);
        setState((prev) => ({ ...prev, integrity: { unavailable: true } }));
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
};
