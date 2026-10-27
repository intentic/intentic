import { spawn } from "node:child_process";
import { homeDir, type Log } from "@intentic/local-agent";
import { DEVICE_FEATURE_EGRESS } from "@intentic/sandbox-contract/schemas/hosts";
import { icEgressFollowArgs } from "@intentic/sandbox-contract/schemas/egress";
import { deviceFeatures, icCandidates } from "../tools/ic-binary.js";
import { lineSplitter } from "../tools/sandboxes.js";

/* THE EGRESS FOLLOWER (2026-10-27): `ic sandbox egress --follow`, one long child of the resident agent while its ic
   advertises `egress`. ic reads docker's events through it and fences a sandbox the moment its container starts, which
   is what keeps a sandbox Docker Compose recreates (ic did not start it, so no ic verb put its rules in) fenced within a
   second instead of at the next minute's `ic sandbox watch`, which stays the backstop. The agent keeps the child alive:
   restarted after every exit with a backoff that doubles from a second to a minute and starts over once a run has held
   for a minute, so a crash loop costs a line a minute and a single crash costs a second. */

const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
// A run that held this long was a working follower: the next crash is news, not the same loop.
const STEADY_MS = 60_000;
// How often an agent whose ic does not advertise `egress` asks again (an ic fetched in the meantime does).
const RECHECK_MS = 10 * 60_000;

// One follower process: how it ended, said as a phrase for the log, and how to end it.
export interface FollowerChild {
    readonly exited: Promise<string>;
    readonly stop: () => void;
}

export interface FollowerSeams {
    readonly advertised: () => Promise<boolean>;
    readonly spawn: (onLine: (line: string) => void) => FollowerChild;
    readonly now: () => number;
}

// The next backoff after a run that started at `startedAt` and ended at `endedAt`. Pure.
export interface Backoff {
    readonly wait: number;
    readonly next: number;
}
export const nextBackoff = (previous: number, startedAt: number, endedAt: number): Backoff => {
    const wait = endedAt - startedAt >= STEADY_MS ? FIRST_BACKOFF_MS : previous;
    return { wait, next: Math.min(wait * 2, MAX_BACKOFF_MS) };
};

export interface EgressFollower {
    readonly stop: () => void;
}
export const startEgressFollower = (log: Log, seams: FollowerSeams = realFollowerSeams()): EgressFollower => {
    let stopped = false;
    let child: FollowerChild | undefined;
    let wake: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    const pause = async (ms: number): Promise<void> =>
        await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, ms);
            timer.unref();
        });
    const loop = async (): Promise<void> => {
        let backoff = FIRST_BACKOFF_MS;
        let said = false;
        // until stop() ends it, at one of the two waits below
        for (;;) {
            if (stopped) {
                return;
            }
            // allow(silent-catch): an ic that cannot say its features does not advertise this one; asked again later
            if (!(await seams.advertised().catch(() => false))) {
                // one ask per recheck interval, until stopped
                await pause(RECHECK_MS);
                continue;
            }
            if (!said) {
                log("egress follow: fencing sandboxes as docker starts them (ic sandbox egress --follow)");
                said = true;
            }
            const startedAt = seams.now();
            child = seams.spawn((line) => log(`egress follow: ${line}`));
            // the one child runs until it ends; the next starts only after it
            const ended = await child.exited;
            child = undefined;
            if (stopped) {
                return;
            }
            const { wait, next } = nextBackoff(backoff, startedAt, seams.now());
            backoff = next;
            log(`egress follow: ${ended}; starting it again in ${Math.round(wait / 1_000)}s (the minute's ic sandbox watch fences sandboxes meanwhile)`);
            // the backoff before the restart
            await pause(wait);
        }
    };
    void loop();
    return {
        stop: () => {
            stopped = true;
            clearTimeout(timer);
            wake?.();
            child?.stop();
        },
    };
};

// The first installed ic, as every other verb finds it: a candidate that is not there (ENOENT) hands over to the next.
// Not a process group of its own, unlike a swap's ic: the follower changes nothing that must outlive the agent, and is
// ended with it. Its stdin is a pipe the agent holds, so an agent that dies without ending it closes it.
const spawnFollower = (onLine: (line: string) => void): FollowerChild => {
    const candidates = icCandidates(process.platform, homeDir());
    let current: ReturnType<typeof spawn> | undefined;
    let stopping = false;
    const attempt = (index: number): Promise<string> =>
        new Promise((resolve) => {
            const binary = candidates[index];
            if (binary === undefined) {
                resolve("no ic was found where this agent installs it");
                return;
            }
            const out = lineSplitter(onLine);
            const err = lineSplitter(onLine);
            const proc = spawn(binary, icEgressFollowArgs(), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
            current = proc;
            proc.stdin.on("error", () => undefined);
            proc.stdout.setEncoding("utf8").on("data", out.push);
            proc.stderr.setEncoding("utf8").on("data", err.push);
            let missing = false;
            proc.on("error", (error: NodeJS.ErrnoException) => {
                missing = error.code === "ENOENT" && !stopping;
                if (!missing) {
                    resolve(`it could not run (${error.message})`);
                }
            });
            proc.on("close", (code, signal) => {
                out.end();
                err.end();
                if (missing) {
                    void attempt(index + 1).then(resolve);
                    return;
                }
                resolve(signal === null ? `it exited with code ${code ?? 1}` : `it was ended by ${signal}`);
            });
        });
    return {
        exited: attempt(0),
        stop: () => {
            stopping = true;
            current?.kill();
        },
    };
};

const realFollowerSeams = (): FollowerSeams => ({
    advertised: async () => (await deviceFeatures()).includes(DEVICE_FEATURE_EGRESS),
    spawn: spawnFollower,
    now: Date.now,
});
