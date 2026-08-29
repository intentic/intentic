import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* Write dist/manifest.json with THIS build's version in it.
 *
 * Every first-party package.json in this repo stays at 0.0.0 in git and is stamped transiently in CI
 * (_tools/scripts/set-versions.sh, packages.sh says why). An extension's version lives somewhere else — its
 * manifest — and a store cares about it more than npm does: the Chrome Web Store refuses an upload whose
 * version is not strictly greater than the one already published. So the manifest's version is DERIVED from
 * the package's rather than kept beside it, and the derivation happens here, at build time.
 *
 * That is also why `static/manifest.json` reads 0.0.0 in git and nobody edits it at release time: a version in
 * two files is a version that disagrees with itself on the release where somebody bumped one of them.
 *
 * A LOADED-UNPACKED BUILD therefore says 0.0.0, which is correct: it is not a release, and a developer
 * reloading it wants to know that. Chrome accepts it without complaint.
 *
 *   node _computers/webext/scripts/stamp-manifest.mjs
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "static", "manifest.json"), "utf8"));

/* The store's version grammar is one to four dot-separated integers, each 0–65535, and it is NOT semver: a
 * prerelease suffix ("1.2.3-rc.1") is refused outright. Releases here are plain x.y.z, so the check is a guard
 * against a hand-run build rather than a transform — a silent truncation would upload a version that is not
 * the one the release calls itself. */
if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(version)) {
    console.error(`"${version}" is not a version the Chrome Web Store accepts (up to four dot-separated integers, no suffix).`);
    process.exit(1);
}

writeFileSync(join(root, "dist", "manifest.json"), `${JSON.stringify({ ...manifest, version }, undefined, 4)}\n`);
console.log(`dist/manifest.json: version ${version}`);
