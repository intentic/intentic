import {
    type ChildProcess,
    type ChildProcessByStdio,
    spawn,
    type SpawnOptions,
    type SpawnOptionsWithStdioTuple,
    type StdioNull,
    type StdioPipe,
} from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { getPriority, setPriority } from "node:os";
import type { Readable, Writable } from "node:stream";
import { forkedExec } from "@intentic/scaffold";

// What a process is to this sandbox, decided by whoever spawned it and applied as it starts: its CPU niceness, its IO
// class and its rank for the kernel's OOM killer. Children inherit all three at fork, so a class set on a runtime, a
// panel's shell or an agent's command covers everything they go on to start. Nothing reads a command line for this: a
// runtime launched as `npx some-agent` is a runtime because the runtime adapter started it. Anything the daemon starts
// without a class (git, one-shot probes, the tmux server and the terminals under it) stays with the daemon's own tier.

// oom_score_adj raised above the daemon's 0. The kernel counts 100 points as a tenth of the memory it weighs (limit plus
// swap), so a tier outranks any size gap short of that, and within one tier the biggest still goes first.
export const OOM_SCORE = {
    // A turn's own runtime: a person's, or the top of a fan-out whose loss orphans every child it supervises.
    turn: 100,
    // Added per spawn level, so a child goes before its parent and a grandchild before both.
    perSpawnLevel: 100,
    // A helper the daemon restarts or reopens (gateway, translator, search engine, browser backend, a panel's server):
    // losing one costs a restart.
    service: 500,
    // An agent's shell command or a dependency install: the tool call ends 137 and the agent reads it, or the install
    // is run again.
    command: 600,
    // A build, test or typecheck the heavy-command rules matched: the peak consumer, and the cheapest thing to run again.
    heavy: 800,
} as const;

// Spawn levels that still rank below a service; anything deeper shares the last of them.
const RANKED_LEVELS = (OOM_SCORE.service - OOM_SCORE.turn) / OOM_SCORE.perSpawnLevel - 1;

export type Workload =
    // A turn's runtime (Claude CLI, codex app-server, an ACP or pi agent), at the depth of the spawn tree it serves.
    | { readonly class: "agentRuntime"; readonly spawnDepth: number }
    // A process the daemon supervises and restarts: extension gateways, the translator, backends.
    | { readonly class: "service" }
    // A panel's pane: a dev server or operator app the owner runs from the sidebar.
    | { readonly class: "panel" }
    // A dependency install the daemon runs in a panel pane.
    | { readonly class: "install" }
    // An agent's shell command, as tmux-run runs it.
    | { readonly class: "command" }
    // An agent's command a heavy-command rule matched: a build, test or typecheck.
    | { readonly class: "toolchain" };

export type WorkloadClass = Workload["class"];

export interface WorkloadPriority {
    // The niceness the class runs at; only ever raised.
    readonly nice: number;
    // Best-effort IO at its lowest level (`ionice -c 2 -n 7`), for the classes that must not starve the rest of the disk.
    readonly lowIo: boolean;
    readonly oomScoreAdj: number;
}

// The front renices every direct child of the daemon to 10 as well; a class never asks for less.
const WORKLOAD_NICE = 10;
const COMMAND_NICE = 19;

const PRIORITY: Readonly<Record<Exclude<WorkloadClass, "agentRuntime">, WorkloadPriority>> = {
    service: { nice: WORKLOAD_NICE, lowIo: false, oomScoreAdj: OOM_SCORE.service },
    panel: { nice: WORKLOAD_NICE, lowIo: false, oomScoreAdj: OOM_SCORE.service },
    install: { nice: WORKLOAD_NICE, lowIo: true, oomScoreAdj: OOM_SCORE.command },
    command: { nice: COMMAND_NICE, lowIo: true, oomScoreAdj: OOM_SCORE.command },
    toolchain: { nice: COMMAND_NICE, lowIo: true, oomScoreAdj: OOM_SCORE.heavy },
};

export const priorityOf = (workload: Workload): WorkloadPriority =>
    workload.class === "agentRuntime"
        ? {
              nice: WORKLOAD_NICE,
              lowIo: false,
              oomScoreAdj: OOM_SCORE.turn + OOM_SCORE.perSpawnLevel * Math.min(Math.max(0, workload.spawnDepth), RANKED_LEVELS),
          }
        : PRIORITY[workload.class];

// Never lowered: a process that already ranks as killable as asked (Chrome raises its own renderers) keeps its own.
export const raisedScore = (current: number, wanted: number): number | undefined => (current >= wanted ? undefined : wanted);

const raiseOomScore = (pid: number, wanted: number): void => {
    const path = `/proc/${String(pid)}/oom_score_adj`;
    try {
        const next = raisedScore(Number(readFileSync(path, "utf8").trim()), wanted);
        if (next !== undefined) {
            writeFileSync(path, String(next));
        }
    } catch {
        // silent-catch: gone already, or procfs is hidden by a hardened runtime; the kernel then weighs size alone.
    }
};

const raiseNice = (pid: number, wanted: number): void => {
    try {
        if (getPriority(pid) < wanted) {
            setPriority(pid, wanted);
        }
    } catch {
        // silent-catch: gone already, so nothing forked from it is left to cover.
    }
};

/**
 * Puts a process that has not yet started its work in its class. The rank and niceness land synchronously, in the call, so a
 * caller that applies it right after spawn (spawnAs) or before typing into a pane (managed panels) covers everything
 * the process forks; the IO class, which Node has no call for, lands when the returned promise settles.
 */
export const applyWorkload = async (pid: number, workload: Workload): Promise<void> => {
    if (process.platform !== "linux") {
        return;
    }
    const priority = priorityOf(workload);
    raiseOomScore(pid, priority.oomScoreAdj);
    raiseNice(pid, priority.nice);
    if (priority.lowIo) {
        await forkedExec("ionice", ["-c", "2", "-n", "7", "-p", String(pid)])
            // silent-catch: no ionice on this machine, or the process is gone; it then shares the disk like the rest.
            .catch(() => undefined);
    }
};

/**
 * `spawn`, with the child put in its class before the call returns. Node's spawn returns once the child has exec'd, and
 * nothing it runs forks within the microseconds between that and the procfs write, so its whole tree inherits the class.
 */
export function spawnAs(
    workload: Workload,
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>,
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnAs(
    workload: Workload,
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnAs(workload: Workload, command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
export function spawnAs(workload: Workload, command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    const child = spawn(command, args, options);
    if (child.pid !== undefined) {
        void applyWorkload(child.pid, workload);
    }
    return child;
}

/**
 * The same class as a shell prefix, for a command line tmux-run runs in a pane the daemon did not fork. `nice` takes an
 * increment, and every class a prefix renders sits at the ceiling of 19, so it lands there from any pane's niceness.
 */
export const shellPrefix = (workload: Workload): string => {
    const priority = priorityOf(workload);
    return `nice -n ${String(priority.nice)} ${priority.lowIo ? "ionice -c 2 -n 7 " : ""}choom -n ${String(priority.oomScoreAdj)} -- `;
};
