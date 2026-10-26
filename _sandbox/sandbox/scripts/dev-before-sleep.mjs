#!/usr/bin/env node
// Asked by `ic sandbox sleep --idle` (sleep.rs) about a dev sandbox it is about to put to sleep, run where its checkout
// is: does the image still install every package the checkout's daemon needs? dev-heal-manifests.mjs fixes a stale
// manifest at start, but a dependency the image never installed (2026-10-18: `mediaplex`) needs an image build, and a
// sandbox nobody is using is the one moment that costs nobody a wait. So this starts `pnpm rebuild:sandbox` detached,
// writing the same log the Sandbox page's rebuild button does, and holds the sleep off until it is over.
//   node dev-before-sleep.mjs <slug> [--dry-run]
// Exit 0: let it sleep. Exit 75 with one line on stdout: keep it awake, for the reason printed. `--dry-run` answers the
// same and starts nothing.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
    DEV_REBUILD_EXIT_MARK,
    DEV_REBUILD_SWAP_MARK,
    devRebuildHoldPath,
    devRebuildLogPath,
    devRebuildPidPath,
} from "@intentic/sandbox-contract/schemas/devices";

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
// The two files beside it the page's own rebuild keeps (device-commands.ts, `dev-rebuild`): the build's process, so the
// page can cancel this one too, and the swap gate's hold, cleared rather than armed — nobody is using this sandbox, so
// its restart waits for nobody, and a hold a previous run left behind must not make the page say otherwise.
const pidFile = devRebuildPidPath(slug).replace(/^~/, homedir());
const holdFile = devRebuildHoldPath(slug).replace(/^~/, homedir());
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

// The session the pid file names, when it is still a rebuild: a session gone since (a slept machine never removes the
// file) may have handed its number to something else, which is never stopped in its place.
const liveRebuildSession = () => {
    const sid = Number(existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "");
    if (!Number.isInteger(sid) || sid <= 1 || sid === process.pid) {
        return undefined;
    }
    const args = spawnSync("ps", ["-o", "args=", "-p", String(sid)], { encoding: "utf8" }).stdout ?? "";
    return args.includes("rebuild:sandbox") ? sid : undefined;
};

// A build quiet past STALLED_MS whose session still runs is HUNG, not over (rog, 2026-10-26: four sat in `docker buildx
// build` for one to five days, each orphaned by the next one started over it, which took its pid file). It is stopped,
// whole session, as `dev-rebuild-cancel` would, whether or not another starts after it. Never once its swap has begun:
// the container is being replaced then, and nothing may stop that halfway.
const stopHungRebuild = () => {
    const sid = liveRebuildSession();
    if (sid === undefined) {
        return true;
    }
    if (existsSync(log) && readFileSync(log, "utf8").includes(`\n${DEV_REBUILD_SWAP_MARK}`)) {
        return false;
    }
    const signal = (name) => {
        try {
            process.kill(-sid, name);
        } catch {
            try {
                process.kill(sid, name);
                // allow(silent-catch): the session ended between the check and the signal, which is what was wanted.
            } catch {}
        }
    };
    signal("SIGTERM");
    const until = Date.now() + 10_000;
    while (liveRebuildSession() !== undefined && Date.now() < until) {
        spawnSync("sleep", ["1"]);
    }
    signal("SIGKILL");
    rmSync(pidFile, { force: true });
    return true;
};

// First, and whatever the image lacks: a hung build is a cost whether or not this sweep would start another.
if (!dryRun && !rebuildRunning() && !stopHungRebuild()) {
    keepAwake(`its image rebuild is restarting the sandbox onto the new image`);
}

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
rmSync(holdFile, { force: true });
const out = openSync(log, "w");
const pnpmHome = process.env.PNPM_HOME ?? `${homedir()}/.local/share/pnpm`;
// `detached` gives the shell a session of its own, so `$$` is the session `dev-rebuild-cancel` stops. No gate variable:
// ic swaps the moment the image is built, as this script always has.
const { INTENTIC_SWAP_GATE: _noGate, ...inherited } = process.env;
spawn(
    "sh",
    [
        "-c",
        `echo $$ > "$INTENTIC_REBUILD_PID"; pnpm rebuild:sandbox ${slug}; printf "\\n${DEV_REBUILD_EXIT_MARK} %s\\n" "$?"; rm -f "$INTENTIC_REBUILD_PID"`,
    ],
    {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...inherited, INTENTIC_REBUILD_PID: pidFile, PNPM_HOME: pnpmHome, PATH: `${pnpmHome}:${pnpmHome}/bin:${process.env.PATH ?? ""}` },
    },
).unref();
closeSync(out);
keepAwake(`its image lacks ${drift}, which the checkout's daemon needs; rebuilding it while nobody uses it`);
