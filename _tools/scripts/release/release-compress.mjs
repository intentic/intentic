#!/usr/bin/env node
// A .gz COPY BESIDE EVERY BINARY A DEVICE DOWNLOADS. release-prepare.sh runs this once the binaries are staged and before
// release-checksums.mjs, so SHA256SUMS lists the copies with the rest:
//
//   node _tools/scripts/release/release-compress.mjs
//
// GitHub serves a release asset as the bytes it holds, with no content coding, so every install and every upgrade moved
// the whole binary: 92 MB for the Linux agent. Measured on v1.340.0's intentic-machine-linux-amd64, gzip -9 leaves 45%
// of it (xz 34%, zstd 37%), and gzip is the one coding every downloader already reads without a new dependency: the
// agent (Bun's zlib), ic and the desktop app (flate2), the shell one-liners (gzip is on every Linux and macOS) and the
// PowerShell ones (.NET's GZipStream, in Windows PowerShell 5.1 too). Each of them asks for `<asset>.gz` first and falls
// back to `<asset>` on a 404, which is what every release from before this answers, and checks the unpacked binary
// against SHA256SUMS' line for `<asset>`, so the copy adds bytes to download and nothing to trust.
import { createReadStream, createWriteStream, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { constants, createGzip } from "node:zlib";
import { repoRoot } from "../../constants/src/node.mjs";

/** The directories of binaries a device downloads; the desktop installers are compressed formats already. */
export const BINARY_DIRS = ["_devices/machine/dist-bin", "_devices/keyring/dist-bin", "_devices/win-launcher/dist-bin", "_sandbox/ic/dist-bin"];

/** The binaries in `dirs` that get a copy: every regular file but a copy, the sums, their signature or a dotfile. */
export const binariesIn = (root, dirs = BINARY_DIRS) =>
    dirs.flatMap((dir) => {
        let names;
        try {
            names = readdirSync(join(root, dir));
        } catch (error) {
            if (error?.code === "ENOENT") {
                return [];
            }
            throw error;
        }
        return names
            .filter((name) => !name.startsWith(".") && !name.endsWith(".gz") && !name.startsWith("SHA256SUMS"))
            .map((name) => join(root, dir, name))
            .filter((path) => statSync(path).isFile());
    });

/** `<path>.gz` at gzip's highest level, written beside and renamed so a half-written copy is never the one uploaded. */
export const writeCopy = async (path) => {
    await pipeline(createReadStream(path), createGzip({ level: constants.Z_BEST_COMPRESSION }), createWriteStream(`${path}.gz.tmp`));
    renameSync(`${path}.gz.tmp`, `${path}.gz`);
};

const main = async () => {
    const binaries = binariesIn(repoRoot(import.meta.url));
    await Promise.all(binaries.map(writeCopy));
    const raw = binaries.reduce((sum, path) => sum + statSync(path).size, 0);
    const packed = binaries.reduce((sum, path) => sum + statSync(`${path}.gz`).size, 0);
    console.log(`==> .gz copies of ${binaries.length} binaries: ${Math.round(raw / 1e6)} MB -> ${Math.round(packed / 1e6)} MB`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    await main();
}
