import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Writes dist/manifest.json with this build's version, derived from package.json since the store needs a
// strictly increasing version; the 0.0.0 sentinel becomes 0.0.0.1, since Chrome rejects an all-zero version. Also
// verifies each icon PNG is really its declared size, since they're committed, not rendered per build.

const here = import.meta.dirname;
const root = join(here, "..");
const { version: packageVersion } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "static", "manifest.json"), "utf8"));
const version = packageVersion === "0.0.0" ? "0.0.0.1" : packageVersion;

// The store's version grammar is 1-4 dot-separated integers, 0-65535, not semver (no prerelease suffix). A guard
// against a hand-run build, not a transform: a silent truncation would upload the wrong version.
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
