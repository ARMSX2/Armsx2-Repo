# ARMSX2 iOS

Custom source repository for the ARMSX2 iOS port. Add it to your sideloading app to install and update ARMSX2 on iOS.

[![Install with LiveContainer](https://img.shields.io/badge/Install-LiveContainer-5A1AE5?style=for-the-badge)](livecontainer://source?url=https%3A%2F%2Fios.armsx2.net%2Fapps.json)
[![Add to SideStore](https://img.shields.io/badge/Add-SideStore-9670E9?style=for-the-badge)](sidestore://source?url=https%3A%2F%2Fios.armsx2.net%2Fapps.json)
[![Add to Feather](https://img.shields.io/badge/Add-Feather-1A50E5?style=for-the-badge)](feather://source/https%3A%2F%2Fios.armsx2.net%2Fapps.json)

## Requirements

- A JIT-capable setup is required.
- You must provide your own PS2 BIOS and legally dumped ISO files.

## Manual Source URL

```text
https://ios.armsx2.net/apps.json
```

## Channels

The source lists two apps.

- **ARMSX2 iOS** is the stable release. Use this one.
- **ARMSX2 Nightly** is an automated build of the latest code, published most days. It is not tested and can crash, run slower, or break games that used to work.

They use different bundle identifiers, so they install side by side as separate apps with separate save states, memory cards and settings. Installing a nightly cannot disturb a stable install, and the two do not share data.

## How the source is built

`apps.json` and `checksums.json` are generated, never edited by hand. `npm run check:source` fails if they drift from what the tooling would produce.

| Command | What it does |
| --- | --- |
| `npm run generate:source` | Rebuild `apps.json` and `checksums.json` |
| `npm run check:source` | Fail if the generated files are stale |
| `npm run validate:source` | Schema, asset, IPA and ledger checks |
| `npm run sync:upstream` | Publish the newest upstream stable iOS release |
| `npm run mirror:nightly` | Mirror the newest upstream nightly iOS build |
| `npm run smoke:live` | Check the published site against what it claims |
| `npm test` | Unit tests |

Release notes for a version are written once and then left alone, so an edit to an upstream release body cannot make an unrelated push fail `check:source`. Run `npm run generate:source -- --refresh-changelogs` to deliberately re-pull them.

Stable builds are committed to `ipas/` and their versions come from the IPA's own `CFBundleShortVersionString`. Nightly builds are mirrored straight to the server and recorded in `metadata/nightly.json`; the binaries are never committed, and the newest five are kept.
