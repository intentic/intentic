import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { binDir } from "./sync/config.js";
import { exe } from "./sync/mutagen.js";
import { MACHINE_VERSION } from "./version.js";

/* WHICH BUILD IS INSTALLED ON THIS MACHINE — the file at `agentPath`, as opposed to the loop that is running
 * (resident.ts's readResidentBuild), which is a different fact and drifts from this one.
 *
 * They drift because replacing the binary does not touch the process: a swap under a live loop leaves it running
 * the code it started with, indefinitely, and everything that reads a version by ASKING (this module,
 * `intentic-machine version`, the report a freshly spawned CLI builds) reads the new file while the machine goes
 * on serving the old one. That is exactly how a device sat several releases behind with a current binary on
 * disk: its Devices row printed the running build as though it were the agent's version, and `upgrade`
 * answered "already current" because the only version it compared was the file's.
 *
 * So the two are reported side by side now (sync/report.ts), and the answer here has to be about the FILE rather
 * than about this process — which is free in the common case and cheap in the one that matters:
 *
 *   • This process IS that file and the file has not changed since we started → our own compiled version.
 *   • Anything else (the file was swapped under us, we are a dev run, a binary from Downloads) → ask the file
 *     what it is, once per version of it, and remember the answer.
 *
 * A machine with no installed agent at all (a dev run with an empty ~/.intentic/bin, an `npx` one) answers
 * undefined, which every reader already treats as "not known" rather than as a version. */

export const agentPath = join(binDir, `intentic-machine${exe}`);

// Long enough for a cold 95 MB binary to start on a busy laptop and print one line, short enough that a wedged
// one cannot hold a report (or an upgrade) open. A probe that times out reads as "not known", never as a version.
const PROBE_TIMEOUT_MS = 30_000;

/* The file at that path, as much of its identity as this needs: any swap changes its size or its mtime, and the
 * only question asked of it is "is this still the file we already know about". */
const identity = (): string | undefined => {
    try {
        const info = statSync(agentPath);
        return `${info.size}:${Math.round(info.mtimeMs)}`;
    } catch {
        return undefined;
    }
};

/* Both read ONCE, at startup, because both are questions about the process rather than about the disk: what we
 * were launched from, and what was at `agentPath` when we were. Read later they answer about a file that may
 * have been replaced in the meantime, which is the very thing this module exists to notice. */
const STARTED_FROM = identity();
const IS_INSTALLED_AGENT = ((): boolean => {
    try {
        return realpathSync(process.execPath) === realpathSync(agentPath);
    } catch {
        return false;
    }
})();

// One probe per version of the file: the resident loop asks on every report it builds, and spawning a binary
// every few seconds to be told the same number is not a thing to do to somebody's laptop.
let probed: { readonly of: string; readonly version: string | undefined } | undefined;

const probe = (of: string): string | undefined => {
    if (probed?.of === of) {
        return probed.version;
    }
    const result = spawnSync(agentPath, ["version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    // `version` prints the bare number and nothing else (commands.ts). Anything else — a non-zero exit, an agent
    // too old to have the command, a file that is not an agent at all — is not a version, and saying so is the
    // honest answer: this is a report field, not a gate on anything.
    const version = result.status === 0 ? /^\d+\.\d+\.\d+$/.exec(result.stdout.trim())?.[0] : undefined;
    probed = { of, version };
    return version;
};

/* THE DECISION, pure and on its own, because it is three cases that each answer a different machine and the one
 * in the middle is the whole point of the module — the file was replaced under a process that is still running.
 *
 * `own` is the version compiled into whoever is asking. It is the right answer twice: when the file at the path
 * IS us and has not moved since we started, and when there is no file at that path at all (an agent somebody put
 * elsewhere on their PATH, a dev run, an `npx` one) — where the agent that answered is the only installed agent
 * this machine can be said to have, which is also what this field meant before it was about the file. */
export const buildOf = (
    at: string | undefined,
    started: { readonly at: string | undefined; readonly ours: boolean },
    own: string,
    ask: (at: string) => string | undefined,
): string | undefined => {
    if (at === undefined) {
        return own;
    }
    return started.ours && at === started.at ? own : ask(at);
};

export const installedBuild = (): string | undefined => buildOf(identity(), { at: STARTED_FROM, ours: IS_INSTALLED_AGENT }, MACHINE_VERSION, probe);
