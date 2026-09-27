import { type ChildProcess, spawn } from "node:child_process";
import { LOG_ROTATE_BYTES, type Log, ROTATE_LOG_SH } from "@intentic/local-agent";
import { MACHINE_AUTOSTART } from "../autostart.js";
import { listDistros } from "../wsl.js";
import { MACHINE_ID_ENV, machineId } from "../machine-id.js";
import { crossEnv, NO_AGENT_EXIT } from "./crossing.js";
import { SUPERVISOR_ENV, WINDOWS_SUPERVISOR } from "./machine.js";

// One held wsl.exe session per attached distro: it boots the distro at sign-in, keeps WSL from idling out, restarts its agent
// when the agent stops inside a running distro. When WSL itself stopped the distro (`wsl --shutdown`, `--terminate`, a
// maintenance task about to compact its disk), it is not booted again from here straight away: the session waits for
// something else to start the distro, or for the backstop below.

// `$1` is the log's roll size; the agent's own stdout goes to the distro's own log, where its status command points.
const CHILD_SH = [
    `a="$HOME/.intentic/machine/bin/intentic-machine"; [ -x "$a" ] || exit ${NO_AGENT_EXIT}`,
    `log="$HOME/.intentic/machine/machine.log"; mkdir -p "$HOME/.intentic/machine"`,
    `rotate() { ${ROTATE_LOG_SH}; }; rotate "$log" "$1"`,
    `PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" exec "$a" ${MACHINE_AUTOSTART.foregroundArgs.join(" ")} >>"$log" 2>&1`,
].join("\n");

export const childArgv = (distro: string): { readonly command: string; readonly args: readonly string[] } => ({
    command: "wsl.exe",
    args: ["-d", distro, "--cd", "~", "--exec", "sh", "-c", CHILD_SH, "sh", String(LOG_ROTATE_BYTES)],
});

// SIGHUP, SIGINT and SIGTERM as the agent reports them (128+n): somebody stopped or restarted it, which is not a crash.
const STOPPED_EXITS: ReadonlySet<number> = new Set([129, 130, 143]);
// What a crash-looping child waits, rung by rung; a run this long resets the ladder, since it was a crash, not a loop.
const RESTART_LADDER_MS = [1_000, 5_000, 15_000, 60_000, 300_000];
const HEALTHY_RUN_MS = 10 * 60_000;

// How often a distro WSL stopped is asked after, by listing the running ones, which boots nothing.
export const STOPPED_DISTRO_POLL_MS = 20_000;
// How long a distro WSL stopped is left alone when nothing else starts it. The disk compaction that stops it on the
// owner's PC attaches the distro's VHDX about 25 s after `wsl --shutdown` and holds it for the whole compaction; once it
// is attached a boot from here only fails (the file is in use) and brings the session back to this wait. Five minutes
// is ten times that gap with room for a slow shutdown, and no longer than the ladder's own top rung, so a distro that
// was just shut down on purpose comes back no later than a crash-looping agent would.
export const STOPPED_DISTRO_BACKSTOP_MS = 5 * 60_000;
// Asking right after the session ended waits out a shutdown still in flight (WSL answers a listing only once it is done),
// which took about 12 s on the owner's PC; past this the answer counts as "WSL cannot be asked".
const RUNNING_ASK_TIMEOUT_MS = 30_000;

export type ChildVerdict = { readonly kind: "drop"; readonly why: string } | { readonly kind: "restart"; readonly delayMs: number; readonly failures: number };

// Exit 0 is the agent retiring (nothing left to serve) and 64 is no agent at all: neither is brought back.
export const childVerdict = (code: number | null, ranForMs: number, failures: number): ChildVerdict => {
    if (code === 0) {
        return { kind: "drop", why: "its agent has nothing left to serve" };
    }
    if (code === NO_AGENT_EXIT) {
        return { kind: "drop", why: "no agent is installed there any more" };
    }
    if (code !== null && STOPPED_EXITS.has(code)) {
        return { kind: "restart", delayMs: RESTART_LADDER_MS[0] ?? 1_000, failures: 0 };
    }
    const next = ranForMs >= HEALTHY_RUN_MS ? 1 : failures + 1;
    return { kind: "restart", delayMs: RESTART_LADDER_MS[Math.min(next, RESTART_LADDER_MS.length) - 1] ?? 300_000, failures: next };
};

export interface ChildSpawner {
    readonly spawn: (distro: string) => ChildProcess;
    // The distros WSL has right now; undefined when it cannot be asked, which is never read as "that one is gone".
    readonly distros: () => Promise<readonly string[] | undefined>;
    // The distros running right now, asked without booting any; undefined when WSL cannot be asked.
    readonly running: () => Promise<readonly string[] | undefined>;
    readonly now: () => number;
}

// What a distro's agent is started with: that it is supervised, and which computer it is an environment of (this PC's
// own id, so its enrollments and rows join the PC's rather than standing as a computer of their own).
export const childEnv = (id: string): Record<string, string> => ({ [SUPERVISOR_ENV]: WINDOWS_SUPERVISOR, [MACHINE_ID_ENV]: id });

// Not detached: a child that outlived the root would be a distro agent nothing supervises, so it dies with the root.
const realSpawner: ChildSpawner = {
    spawn: (distro) => {
        const { command, args } = childArgv(distro);
        return spawn(command, [...args], { windowsHide: true, stdio: "ignore", env: crossEnv(childEnv(machineId()), "u") });
    },
    distros: async () => await listDistros(),
    running: async () => await listDistros({ running: true, timeoutMs: RUNNING_ASK_TIMEOUT_MS }),
    now: Date.now,
};

export interface Children {
    // The distros that should be held now; the rest are let go. Called every tick with the registry as it reads.
    readonly reconcile: (wanted: readonly string[]) => void;
    readonly held: () => readonly string[];
    readonly stopAll: () => void;
}

interface Held {
    process: ChildProcess | undefined;
    startedAt: number;
    failures: number;
    // The ladder's delay, or the next look at whether a stopped distro is running again.
    timer: NodeJS.Timeout | undefined;
    // Set only while waiting on a distro WSL stopped: when it is booted from here anyway.
    backstop: NodeJS.Timeout | undefined;
    // The wait in progress; a poll whose wait was cancelled or finished while it asked WSL does nothing.
    wait: object | undefined;
}

const inWords = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`);

export const superviseChildren = (log: Log, drop: (distro: string, why: string) => Promise<void>, spawner: ChildSpawner = realSpawner): Children => {
    const held = new Map<string, Held>();
    let stopping = false;

    const current = (distro: string, entry: Held): boolean => held.get(distro) === entry && !stopping;

    const cancel = (entry: Held): void => {
        clearTimeout(entry.timer);
        clearTimeout(entry.backstop);
        entry.timer = undefined;
        entry.backstop = undefined;
        entry.wait = undefined;
    };

    const start = (distro: string, entry: Held): void => {
        cancel(entry);
        entry.startedAt = spawner.now();
        const child = spawner.spawn(distro);
        entry.process = child;
        child.once("error", (error) => log(`${distro}: could not start its agent through wsl.exe (${error.message})`));
        child.once("exit", (code) => void exited(distro, entry, child, code));
    };

    // Never boots anything while it waits: each look lists the running distros, and only the backstop starts the session.
    const waitForBoot = (distro: string, entry: Held): void => {
        const wait = {};
        entry.wait = wait;
        const live = (): boolean => current(distro, entry) && entry.wait === wait;
        const look = (): void => {
            entry.timer = setTimeout(() => {
                void spawner.running().then((running) => {
                    if (!live()) {
                        return;
                    }
                    if (running?.includes(distro) === true) {
                        log(`${distro}: running again, so starting its agent now.`);
                        start(distro, entry);
                        return;
                    }
                    look();
                });
            }, STOPPED_DISTRO_POLL_MS);
        };
        entry.backstop = setTimeout(() => {
            if (live()) {
                log(`${distro}: nothing started it in ${inWords(STOPPED_DISTRO_BACKSTOP_MS)}, so booting it from here to start its agent.`);
                start(distro, entry);
            }
        }, STOPPED_DISTRO_BACKSTOP_MS);
        look();
    };

    const exited = async (distro: string, entry: Held, child: ChildProcess, code: number | null): Promise<void> => {
        if (held.get(distro) !== entry || entry.process !== child || stopping) {
            return;
        }
        entry.process = undefined;
        const listed = code === 0 || code === NO_AGENT_EXIT ? undefined : await spawner.distros();
        const verdict: ChildVerdict =
            listed !== undefined && !listed.includes(distro)
                ? { kind: "drop", why: "WSL no longer has that distro" }
                : childVerdict(code, spawner.now() - entry.startedAt, entry.failures);
        if (verdict.kind === "drop") {
            held.delete(distro);
            log(`${distro}: no longer kept running from here, ${verdict.why}.`);
            await drop(distro, verdict.why).catch((error: unknown) => log(`${distro}: could not be taken off the list (${String(error)})`));
            return;
        }
        const exit = `exit ${code ?? "by signal"}`;
        // Whether the distro is still up tells an agent that died inside it from WSL stopping the distro under it.
        const running = await spawner.running();
        if (!current(distro, entry) || entry.process !== undefined) {
            return;
        }
        if (running !== undefined && !running.includes(distro)) {
            // Not the agent's fault, so it starts the next run with a clean ladder.
            entry.failures = 0;
            const by = new Date(spawner.now() + STOPPED_DISTRO_BACKSTOP_MS).toISOString();
            log(
                `${distro}: WSL stopped the distro (its session ended, ${exit}); not booting it again from here. ` +
                    `Its agent starts once something else starts the distro, or at ${by} at the latest.`,
            );
            waitForBoot(distro, entry);
            return;
        }
        entry.failures = verdict.failures;
        const where = running === undefined ? "WSL could not say whether the distro is still running" : "the distro is still running";
        log(`${distro}: its agent stopped (${exit}) and ${where}; starting it again in ${inWords(verdict.delayMs)}.`);
        entry.timer = setTimeout(() => {
            if (current(distro, entry)) {
                start(distro, entry);
            }
        }, verdict.delayMs);
    };

    const release = (distro: string, entry: Held): void => {
        cancel(entry);
        held.delete(distro);
        entry.process?.kill();
    };
    return {
        reconcile: (wanted) => {
            for (const [distro, entry] of held) {
                if (!wanted.includes(distro)) {
                    release(distro, entry);
                    log(`${distro}: let go, it is no longer attached to this PC's Windows side.`);
                }
            }
            for (const distro of wanted) {
                if (!held.has(distro)) {
                    const entry: Held = { process: undefined, startedAt: 0, failures: 0, timer: undefined, backstop: undefined, wait: undefined };
                    held.set(distro, entry);
                    log(`${distro}: keeping its agent running from here.`);
                    start(distro, entry);
                }
            }
        },
        held: () => [...held.keys()],
        stopAll: () => {
            stopping = true;
            for (const [distro, entry] of held) {
                release(distro, entry);
            }
        },
    };
};
