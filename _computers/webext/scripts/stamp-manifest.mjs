import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* Write dist/manifest.json with THIS build's version in it.
 *
 * Every first-party package.json in this repo stays at 0.0.0 in git and is stamped transiently in CI
 * (_tools/scripts/set-versions.sh, packages.sh says why). An extension's version lives somewhere else — its
 * manifest — and a store cares about it more than npm does: the Chrome Web Store refuses an upload whose
 * version is not strictly greater than the one already published. So the manifest's version is DERIVED from
 * the package's rather than kept beside it, and the derivation happens here, at build time.
 *
 * `static/manifest.json` carries 0.0.0.1, the valid DEVELOPMENT sentinel: Chrome rejects an all-zero version,
 * so 0.0.0 could neither be loaded unpacked nor used for the first dashboard upload. A package still carries
 * the workspace's 0.0.0 sentinel; this script maps that one value to 0.0.0.1 and passes release versions
 * through unchanged.
 *
 * The icon check belongs here because the PNGs are committed rather than rendered during every build. A
 * manifest key saying "128" does not make a 128x147 bitmap square; fail before a malformed asset reaches the
 * packer or the store.
 *
 *   node _computers/webext/scripts/stamp-manifest.mjs
 */

const here = import.meta.dirname;
const root = join(here, "..");
const { version: packageVersion } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "static", "manifest.json"), "utf8"));
const version = packageVersion === "0.0.0" ? "0.0.0.1" : packageVersion;

/* The store's version grammar is one to four dot-separated integers, each 0–65535, and it is NOT semver: a
 * prerelease suffix ("1.2.3-rc.1") is refused outright. Releases here are plain x.y.z, so the check is a guard
 * against a hand-run build rather than a transform — a silent truncation would upload a version that is not
 * the one the release calls itself. */
const parts = typeof version === "string" ? version.split(".") : [];
const validVersion =
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.some((part) => part !== "0") &&
    parts.every((part) => /^(0|[1-9]\d{0,4})$/.test(part) && Number(part) <= 65_535);
if (!validVersion) {
    console.error(`"${String(version)}" is not a Chrome version (one to four integers from 0 to 65535, no leading zeroes or all-zero value).`);
    process.exit(1);
}

for (const [declared, path] of Object.entries(manifest.icons ?? {})) {
    const expected = Number(declared);
    const png = readFileSync(join(root, "static", path));
    const signature = png.subarray(0, 8).toString("hex");
    const width = png.length >= 24 && signature === "89504e470d0a1a0a" ? png.readUInt32BE(16) : undefined;
    const height = width === undefined ? undefined : png.readUInt32BE(20);
    if (width !== expected || height !== expected) {
        console.error(`${path} is ${width ?? "not a PNG"}x${height ?? "?"}, but manifest.icons declares ${declared}x${declared}.`);
        process.exit(1);
    }
}

writeFileSync(join(root, "dist", "manifest.json"), `${JSON.stringify({ ...manifest, version }, undefined, 4)}\n`);
console.log(`dist/manifest.json: version ${version}`);
