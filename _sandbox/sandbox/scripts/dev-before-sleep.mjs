#!/usr/bin/env node
// Asked by `ic sandbox sleep --idle` (sleep.rs) about a dev sandbox it is about to put to sleep, run where its checkout
// is: does the image still install every package the checkout's daemon needs? dev-heal-manifests.mjs fixes a stale
// manifest at start, but a dependency the image never installed (2026-10-18: `mediaplex`) needs an image build, and a
// sandbox nobody is using is the one moment that costs nobody a wait. So this starts `pnpm rebuild:sandbox` detached,
// writing the same log the Sandbox page's rebuild button does, and holds the sleep off until it is over.
//   node dev-before-sleep.mjs <slug> [--dry-run]
// Exit 0: let it sleep. Exit 75 with one line on stdout: keep it awake, for the reason printed. `--dry-run` answers the
// same and starts nothing.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { DEV_REBUILD_EXIT_MARK, devRebuildLogPath } from "@intentic/sandbox-contract/schemas/devices";

import { REPO_ROOT } from "./dev-baked-packages.mjs";
import { describeMissing, missingFromImage, readCheckoutLock, readImageLock } from "./dev-image-drift.mjs";

const KEEP_AWAKE = 75;
// A build that has not written for this long is not running: one whose machine slept never writes its exit mark.
const STALLED_MS = 20 * 60_000;

const slug = process.argv[2] ?? "";
const dryRun = process.argv.includes("--dry-run");
// ic's own slug, and it lands in a command line below.
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error("usage: dev-before-sleep.mjs <slug> [--dry-run]");
    process.exit(2);
}

const keepAwake = (why) => {
    console.log(why);
    process.exit(KEEP_AWAKE);
};

const log = devRebuildLogPath(slug).replace(/^~/, homedir());
// Which drift the last rebuild started here was for: one that ended and left the same drift behind failed, and is not
// started again every sweep. A person's rebuild, or a new drift, is what tries again.
const attempted = `${log.replace(/\.log$/, "")}.before-sleep`;

// A rebuild under way, this script's or the page's: no exit mark yet, and still writing.
const rebuildRunning = () => {
    if (!existsSync(log)) {
        return false;
    }
    if (Date.now() - statSync(log).mtimeMs > STALLED_MS) {
        return false;
    }
    return !readFileSync(log, "utf8").slice(-4096).includes(DEV_REBUILD_EXIT_MARK);
};

const imageLock = readImageLock(`intentic-sandbox-${slug}`);
if (imageLock === undefined) {
    // An image too old to carry its deploy's lockfile cannot be compared; it sleeps as it always did.
    process.exit(0);
}
const missing = missingFromImage(readCheckoutLock(), imageLock);
if (missing.length === 0) {
    if (!dryRun) {
        rmSync(attempted, { force: true });
    }
    process.exit(0);
}
const drift = missing.map(describeMissing).join(", ");

if (rebuildRunning()) {
    keepAwake(`its image is being rebuilt from the checkout (it lacks ${drift})`);
}
if (existsSync(attempted) && readFileSync(attempted, "utf8") === drift) {
    console.error(`intentic: ${slug}'s image still lacks ${drift} after a rebuild for it; see ${log}`);
    process.exit(0);
}

if (dryRun) {
    keepAwake(`its image lacks ${drift}, which the checkout's daemon needs; it would be rebuilt before it sleeps`);
}
mkdirSync(dirname(log), { recursive: true });
writeFileSync(attempted, drift);
// The device command's line (device-commands.ts, `dev-rebuild`), so the page reads this build like its own: a session
// of its own to outlive whoever asked, pnpm found where a login shell keeps it, and the exit mark appended at the end.
const out = openSync(log, "w");
const pnpmHome = process.env.PNPM_HOME ?? `${homedir()}/.local/share/pnpm`;
spawn("sh", ["-c", `pnpm rebuild:sandbox ${slug}; printf "\\n${DEV_REBUILD_EXIT_MARK} %s\\n" "$?"`], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, PNPM_HOME: pnpmHome, PATH: `${pnpmHome}:${pnpmHome}/bin:${process.env.PATH ?? ""}` },
}).unref();
closeSync(out);
keepAwake(`its image lacks ${drift}, which the checkout's daemon needs; rebuilding it while nobody uses it`);
