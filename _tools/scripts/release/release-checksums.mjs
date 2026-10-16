#!/usr/bin/env node
// SHA256SUMS OVER EVERYTHING THE RELEASE ATTACHES, AND THE RELEASE KEY'S SIGNATURE OVER IT. release-prepare.sh runs this
// once every artifact is staged; publish-github.sh then uploads both files with the rest of `_editor/desktop-app/dist-bin`.
//
//   node _tools/scripts/release/release-checksums.mjs <version>
//
// build-desktop.sh's own SHA256SUMS covered its directory alone, the installers. The binaries the install one-liners and
// the machine agent download (ic-*, intentic-machine-*, intentic-keyring-*, the Windows launcher) were in no checksum at
// all, so nothing could tell a substituted or truncated one from the real thing. This file is the release's: one line per
// asset across the directories publish-github.sh attaches, by the name the Release shows.
//
// SIGNED WITH THE UPDATER KEY, by the same signer that signs the installers (`tauri signer sign`), with the version bound
// into the trusted comment. Agents check SHA256SUMS.sig against the public half built into them
// (_devices/machine/src/release/release-verify.ts) and refuse a release from SIGNED_SUMS_FROM on that lacks it, so a release
// without the key set fails here in CI rather than stranding every agent's upgrade. The signature is checked straight
// after it is made, by the agents' own code, against tauri.conf.json's public key: a key that does not match, or a
// signer whose output the agents cannot read, stops the release before anything is published.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../constants/src/node.mjs";

/** What publish-github.sh attaches to the Release (and the attestation covers), one flat namespace of asset names. */
export const RELEASE_DIRS = ["_devices/machine/dist-bin", "_devices/keyring/dist-bin", "_devices/win-launcher/dist-bin", "_sandbox/ic/dist-bin", "_editor/desktop-app/dist-bin"];
export const SUMS = "SHA256SUMS";
export const SIGNATURE = "SHA256SUMS.sig";
const DESKTOP_APP = "_editor/desktop-app";
const SUMS_DIR = `${DESKTOP_APP}/dist-bin`;

/** Every file the Release will carry, by asset name, sorted. Throws on two files with one name: the Release would keep one. */
export const releaseAssets = (root, dirs = RELEASE_DIRS) => {
    const byName = new Map();
    for (const dir of dirs) {
        let names;
        try {
            names = readdirSync(join(root, dir));
        } catch (error) {
            if (error?.code === "ENOENT") {
                continue;
            }
            throw error;
        }
        for (const name of names) {
            const path = join(root, dir, name);
            if (name === SUMS || name === SIGNATURE || name.startsWith(".") || !statSync(path).isFile()) {
                continue;
            }
            if (byName.has(name)) {
                throw new Error(`${name} is in both ${byName.get(name)} and ${path}: the Release has one name for one asset`);
            }
            byName.set(name, path);
        }
    }
    return [...byName].map(([name, path]) => ({ name, path })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/** sha256sum's text format, `./` before each name as build-desktop.sh has always written it. */
export const sumsText = (assets, digestOf) => assets.map((asset) => `${digestOf(asset.path)}  ./${asset.name}\n`).join("");

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const sign = (root, file, version) => {
    rmSync(`${file}.sig`, { force: true });
    // The password variable is set even when empty: unset, the signer prints "Signing without password." and waits for
    // one on a prompt no job can answer (build-desktop.sh, the same trap). stdin is closed so a prompt fails instead.
    execFileSync("pnpm", ["exec", "tauri", "signer", "sign", "--app-version", version, file], {
        cwd: join(root, DESKTOP_APP),
        env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" },
        stdio: ["ignore", "ignore", "inherit"],
    });
};

// The agents' own check, imported as the TypeScript it is (Node strips the types; the module needs nothing but
// node:crypto), so what passes here is what passes on every machine.
const verify = async (root, file, version) => {
    const { verifySignedSums } = await import(pathToFileURL(join(root, "_devices/machine/src/release/release-signature.ts")).href);
    const config = JSON.parse(readFileSync(join(root, DESKTOP_APP, "src-tauri/tauri.conf.json"), "utf8"));
    verifySignedSums(readFileSync(file), readFileSync(`${file}.sig`, "utf8"), config.plugins.updater.pubkey, version);
};

const main = async () => {
    const version = process.argv[2];
    if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
        console.error("usage: release-checksums.mjs <version>");
        process.exit(2);
    }
    const root = repoRoot(import.meta.url);
    const assets = releaseAssets(root);
    const file = join(root, SUMS_DIR, SUMS);
    // Written beside and renamed, so a half-written file is never the one uploaded.
    writeFileSync(`${file}.tmp`, sumsText(assets, sha256));
    renameSync(`${file}.tmp`, file);
    console.log(`==> ${SUMS}: ${assets.length} release assets`);
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
        if (process.env.GITHUB_ACTIONS === "true") {
            console.error(`error: TAURI_SIGNING_PRIVATE_KEY is not set, so ${SUMS} cannot be signed; agents refuse a release without ${SIGNATURE}.`);
            process.exit(1);
        }
        rmSync(`${file}.sig`, { force: true });
        console.log(`==> TAURI_SIGNING_PRIVATE_KEY not set: ${SUMS} left unsigned (a local run; CI refuses this)`);
        return;
    }
    sign(root, file, version);
    await verify(root, file, version);
    console.log(`==> ${SIGNATURE}: signed for ${version}, and verified against tauri.conf.json's public key`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    await main();
}
