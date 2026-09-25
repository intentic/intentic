import { type ChildProcess, spawn } from "node:child_process";
import { LOG_ROTATE_BYTES, type Log, ROTATE_LOG_SH } from "@intentic/local-agent";
import { MACHINE_AUTOSTART } from "../autostart.js";
import { listDistros } from "../wsl.js";
import { MACHINE_ID_ENV, machineId } from "../machine-id.js";
import { crossEnv, NO_AGENT_EXIT } from "./crossing.js";
import { SUPERVISOR_ENV, WINDOWS_SUPERVISOR } from "./machine.js";

// One held wsl.exe session per attached distro: it boots the distro at sign-in, keeps WSL from idling out, restarts its agent.

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
    timer: NodeJS.Timeout | undefined;
}

export const superviseChildren = (log: Log, drop: (distro: string, why: string) => Promise<void>, spawner: ChildSpawner = realSpawner): Children => {
    const held = new Map<string, Held>();
    let stopping = false;

    const start = (distro: string, entry: Held): void => {
        entry.timer = undefined;
        entry.startedAt = spawner.now();
        const child = spawner.spawn(distro);
        entry.process = child;
        child.once("error", (error) => log(`${distro}: could not start its agent through wsl.exe (${error.message})`));
        child.once("exit", (code) => void exited(distro, entry, child, code));
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
        entry.failures = verdict.failures;
        log(`${distro}: its agent stopped (exit ${code ?? "by signal"}); starting it again in ${Math.round(verdict.delayMs / 1000)}s.`);
        entry.timer = setTimeout(() => {
            if (held.get(distro) === entry && !stopping) {
                start(distro, entry);
            }
        }, verdict.delayMs);
    };

    const release = (distro: string, entry: Held): void => {
        clearTimeout(entry.timer);
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
                    const entry: Held = { process: undefined, startedAt: 0, failures: 0, timer: undefined };
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
