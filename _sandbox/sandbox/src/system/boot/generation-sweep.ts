import { readlink } from "node:fs/promises";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import { daemonGeneration, type DetachedKind } from "../../seams/workload-stamp.js";
import { readText } from "../resources/cgroup.js";
import { procUnits, type ScannedProcess, scanProcesses } from "../resources/process-scan.js";

// WHAT AN EARLIER DAEMON RUN LEFT RUNNING (2026-10-05). Every process the daemon starts carries its run's generation
// (seams/workload-stamp.ts `INTENTIC_DAEMON_GEN`), and a detached child of the daemon's own (an isolation anchor, a
// watch check, an edit rule's command, the sign-in window's Chromium) also says what it is. intentic-netd ends a
// crashed daemon's process group, but these sit in groups of their own, so before this pass an isolation anchor leaked
// one `sleep infinity` per crash and nothing ever ended it. At boot, before anything is started, a stamped process of
// an earlier run goes, except:
// - what tmux holds (a pane's session, the server itself): the sessions have their own sweep and their own adoptions,
//   the servers an agent kept for the person among them;
// - what is meant to outlive the daemon (ADOPTED_PROGRAMS): the browsers' X displays and their window manager, VPN and
//   exit clients, the agents' Docker engine, a loaded local model;
// - an unstamped process, which is not the daemon's to judge however it was started.
// An isolation anchor of an earlier run always goes: no turn survives a restart, so nothing will enter its namespace
// again. Anchors from before the stamp are known by their shape (`sleep infinity` leading its own session in a mount
// namespace of its own, orphaned).
// Every command run through workload/run-check.ts (a watch check, an edit rule, a guard, a stop check, a probe, a JS
// run, a Python check) carries its own deadline as well, which the reaper's minute sweep enforces whichever run started
// them (overdueDetached).

// Kernel names (comm, at most 15 characters) of programs meant to survive a daemon restart, adopted rather than
// ended. dockerd and model servers normally run in a tmux panel and are spared by that already; named here for the
// child a stamped process started outside one.
export const ADOPTED_PROGRAMS: ReadonlySet<string> = new Set([
    "Xvfb",
    "Xvnc",
    "openbox",
    "openconnect",
    "openvpn",
    "vpnc",
    "tor",
    "wireguard-go",
    "tailscaled",
    "dockerd",
    "containerd",
    "containerd-shim",
    "docker-proxy",
    "runc",
    "llama-server",
    "ollama",
]);

// The process as this pass reads it: the scan's fields, plus what only an anchor's fingerprint needs.
export interface GenerationCandidate {
    readonly pid: number;
    readonly ppid: number;
    readonly pgrp: number;
    readonly session?: number | undefined;
    readonly comm: string;
    readonly owner?: string | undefined;
    readonly generation?: string | undefined;
    readonly detached?: DetachedKind | undefined;
    // argv, read only for a process whose comm could make it a pre-stamp anchor.
    readonly argv?: readonly string[];
    // Whether it sits in a mount namespace other than the daemon's; read only where argv was.
    readonly ownMountNamespace?: boolean;
}

export interface GenerationPolicy {
    readonly generation: string;
    readonly selfPid: number;
    // Where an orphan is reparented to: the container's PID 1, which reaps it (docker's tini locally, netd on a hosted
    // machine, Fly's init on a VM). The daemon's parent is listed too: it is that same PID 1 on a hosted machine, and
    // elsewhere netd, which sets no subreaper, so nothing is reparented to it there.
    readonly orphanParents: ReadonlySet<number>;
    // Every live tmux pane's root pid, and the tmux server's.
    readonly panePids: ReadonlySet<number>;
}

export type GenerationVerdict =
    | { readonly kill: true; readonly why: "anchor" | "earlier-anchor" | "earlier-run" }
    | { readonly kill: false; readonly why: "self" | "unstamped" | "this-run" | "tmux" | "adopted" };

const MAX_ANCESTRY = 64;

const underTmux = (candidate: GenerationCandidate, parents: ReadonlyMap<number, number>, panes: ReadonlySet<number>): boolean => {
    if (candidate.session !== undefined && panes.has(candidate.session)) {
        return true;
    }
    let current = candidate.pid;
    for (let step = 0; step < MAX_ANCESTRY; step += 1) {
        if (panes.has(current)) {
            return true;
        }
        const parent = parents.get(current);
        if (parent === undefined || parent === current || parent <= 1) {
            return false;
        }
        current = parent;
    }
    return false;
};

// An isolation anchor started before anchors were stamped: `sleep infinity`, leading the session `detached` gave it,
// in a mount namespace of its own, and orphaned. Each of the four alone is common; together they are an anchor.
const preStampAnchor = (candidate: GenerationCandidate, policy: GenerationPolicy): boolean =>
    candidate.generation === undefined &&
    candidate.comm === "sleep" &&
    candidate.argv?.length === 2 &&
    candidate.argv[1] === "infinity" &&
    candidate.session === candidate.pid &&
    candidate.ownMountNamespace === true &&
    policy.orphanParents.has(candidate.ppid);

/** What the boot pass does with one process. Pure, so every rule above is a test. */
export const generationVerdict = (
    candidate: GenerationCandidate,
    parents: ReadonlyMap<number, number>,
    policy: GenerationPolicy,
): GenerationVerdict => {
    if (candidate.pid === policy.selfPid) {
        return { kill: false, why: "self" };
    }
    if (preStampAnchor(candidate, policy)) {
        return { kill: true, why: "earlier-anchor" };
    }
    if (candidate.generation === undefined || (candidate.owner === undefined && candidate.detached === undefined)) {
        return { kill: false, why: "unstamped" };
    }
    if (candidate.generation === policy.generation) {
        return { kill: false, why: "this-run" };
    }
    if (candidate.detached === "isolation-anchor") {
        return { kill: true, why: "anchor" };
    }
    if (underTmux(candidate, parents, policy.panePids)) {
        return { kill: false, why: "tmux" };
    }
    if (ADOPTED_PROGRAMS.has(candidate.comm) || candidate.comm.startsWith("tmux")) {
        return { kill: false, why: "adopted" };
    }
    return { kill: true, why: "earlier-run" };
};

// How long past its own deadline a detached child may run before the sweep ends it: its own timer is the first line,
// this is the backstop for one whose daemon died or whose kill missed.
export const DEADLINE_SLACK_MS = 30_000;

/** The detached children past their own deadline, whichever daemon run started them. */
export const overdueDetached = (scanned: readonly Pick<ScannedProcess, "pid" | "stamps">[], now: number, slackMs = DEADLINE_SLACK_MS): number[] =>
    scanned
        .filter(({ stamps }) => stamps?.deadlineAt !== undefined && stamps.detached !== undefined && stamps.deadlineAt + slackMs < now)
        .map(({ pid }) => pid);

const TERM_GRACE_MS = 3_000;

/** SIGTERM, then SIGKILL after a grace that nothing waits for; the whole group when it leads one. */
export const endProcess = (pid: number, leadsGroup: boolean, signal: NodeJS.Signals = "SIGTERM"): boolean => {
    const target = leadsGroup ? -pid : pid;
    try {
        process.kill(target, signal);
    } catch {
        // allow(silent-catch): gone already, or not ours to signal; either way nothing was ended, as false says.
        return false;
    }
    if (signal !== "SIGKILL") {
        setTimeout(() => {
            try {
                process.kill(target, "SIGKILL");
            } catch {
                // allow(silent-catch): gone within the grace, which is the goal.
            }
        }, TERM_GRACE_MS).unref();
    }
    return true;
};

const argvOf = async (pid: number): Promise<string[] | undefined> => {
    const raw = await readText(`/proc/${pid}/cmdline`);
    return raw === undefined ? undefined : raw.split("\0").filter((part) => part !== "");
};

// allow(silent-catch): a process gone since, or one whose namespace this one may not read, is a namespace unknown.
const mountNamespace = (pid: number | "self"): Promise<string | undefined> => readlink(`/proc/${pid}/ns/mnt`).catch(() => undefined);

export interface GenerationSweepDeps {
    readonly logger: Pick<Logger, "info" | "warn">;
    // Every live tmux pane's root pid; a failed listing must reject, since it spares exactly what is under them.
    readonly panePids: () => Promise<ReadonlySet<number>>;
    readonly scan?: () => Promise<readonly ScannedProcess[]>;
}

/** Once at boot, container owner only: ends what earlier daemon runs left running outside tmux. Never rejects. */
export const sweepEarlierGenerations = async ({ logger, panePids, scan = scanProcesses }: GenerationSweepDeps): Promise<number> => {
    if (process.platform !== "linux") {
        return 0;
    }
    try {
        const [scanned, panes, ownNamespace] = await Promise.all([scan(), panePids(), mountNamespace("self")]);
        const tmuxServers = scanned.filter((entry) => entry.comm.startsWith("tmux")).map((entry) => entry.pid);
        const policy: GenerationPolicy = {
            generation: daemonGeneration(),
            selfPid: process.pid,
            orphanParents: new Set([1, process.ppid]),
            panePids: new Set([...panes, ...tmuxServers]),
        };
        const parents = new Map(scanned.map((entry) => [entry.pid, entry.ppid]));
        const killed: { pid: number; comm: string; why: string; generation?: string | undefined }[] = [];
        for (const entry of scanned) {
            const fingerprinted = entry.comm === "sleep" && entry.stamps?.generation === undefined;
            const argv = fingerprinted ? await argvOf(entry.pid) : undefined;
            const namespace = fingerprinted ? await mountNamespace(entry.pid) : undefined;
            const verdict = generationVerdict(
                {
                    pid: entry.pid,
                    ppid: entry.ppid,
                    pgrp: entry.pgrp,
                    session: entry.session,
                    comm: entry.comm,
                    owner: entry.owner,
                    generation: entry.stamps?.generation,
                    detached: entry.stamps?.detached,
                    ...opt("argv", argv),
                    ...opt("ownMountNamespace", namespace === undefined || ownNamespace === undefined ? undefined : namespace !== ownNamespace),
                },
                parents,
                policy,
            );
            if (verdict.kill && endProcess(entry.pid, entry.pgrp === entry.pid)) {
                killed.push({ pid: entry.pid, comm: entry.comm, why: verdict.why, generation: entry.stamps?.generation });
            }
        }
        if (killed.length > 0) {
            logger.info({ count: killed.length, killed: killed.slice(0, 20) }, "boot: ended processes an earlier daemon run left running");
        }
        return killed.length;
    } catch (error) {
        logger.warn({ err: error }, "boot: what earlier daemon runs left running could not be swept, it stays until the next boot");
        return 0;
    }
};

/** How long ago each process started, in ms, from the kernel's own clock; empty when procfs will not say. */
export const processAges = async (scanned: readonly Pick<ScannedProcess, "pid" | "startTimeTicks">[]): Promise<Map<number, number>> => {
    const [uptimeText, { ticksPerSecond }] = await Promise.all([readText("/proc/uptime"), procUnits()]);
    const uptimeSeconds = Number((uptimeText ?? "").trim().split(/\s+/u)[0]);
    const ages = new Map<number, number>();
    if (!Number.isFinite(uptimeSeconds)) {
        return ages;
    }
    for (const { pid, startTimeTicks } of scanned) {
        if (startTimeTicks !== undefined) {
            ages.set(pid, Math.max(0, Math.round((uptimeSeconds - startTimeTicks / ticksPerSecond) * 1000)));
        }
    }
    return ages;
};
