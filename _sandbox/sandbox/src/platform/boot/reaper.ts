import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENT_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import type { Logger } from "pino";
import { closeBrowserSessionsFor, runningBrowserOwners } from "../../browser/sessions/browser-sessions.js";
import { type Leftover, leftoverProcesses, ownProcessGroup, scanProcesses, signalFor } from "./leftovers.js";

// Reclaims everything a conversation holds (processes, tmux terminals, browser records, scratch /tmp state) once the
// turn registry reports it stopped, on one clock instead of one policy per resource kind. Archive and discard bypass
// the grace and reap immediately, attached terminals included.

const execFileAsync = promisify(execFile);

// tmux user option carrying the owning conversation id; set once by bin/tmux-run, read back by the sweep.
const TMUX_OWNER_OPTION = "@intentic_owner";

// How long a stopped owner's resources wait before reclaim: processes wait out their own SDK unwind and SIGTERM chain;
// terminals wait long enough for a live scrollback and a delayed follow-up message to still find their job.
const PROCESS_GRACE_MS = 2 * 60_000;
const TERMINAL_GRACE_MS = 10 * 60_000;

const SWEEP_INTERVAL_MS = 60_000;
const DISK_SWEEP_INTERVAL_MS = 3_600_000;

// Prefix-and-age sweep for /tmp state a crashed or soft-timed-out turn can leave behind (capture dirs, patch dirs,
// delegation signal files); worktrees are not here, archive/discard owns those.
const TMP_SWEEPS: readonly { readonly prefix: string; readonly maxAgeMs: number }[] = [
    { prefix: "intentic-run-", maxAgeMs: 24 * 3_600_000 },
    { prefix: "intentic-classify-", maxAgeMs: 6 * 3_600_000 },
    { prefix: "intentic-land-", maxAgeMs: 6 * 3_600_000 },
];
const SIGNALS_SWEEP = { dir: join(tmpdir(), "intentic", "agent-signals"), maxAgeMs: 24 * 3_600_000 };

// One agent tmux session as the sweep sees it: owner, whether attached, last activity.
export interface AgentSessionState {
    readonly name: string;
    readonly owner: string | undefined;
    readonly attached: boolean;
    readonly activityAt: number;
}

// Tab-separated: the owner field may be empty, and a space split would shift every field after it.
const SESSION_FORMAT = `#{session_name}\t#{${TMUX_OWNER_OPTION}}\t#{session_attached}\t#{session_activity}`;

// Parses one row per session, not per pane; pane liveness does not matter here. An unparseable activity stamp reads as
// "just now", the safe direction since it gates a kill.
export const parseAgentSessions = (stdout: string, now: number): AgentSessionState[] => {
    const sessions: AgentSessionState[] = [];
    for (const line of stdout.split("\n")) {
        const [name, owner, attached, activity] = line.split("\t");
        if (name === undefined || !name.startsWith(AGENT_SESSION_PREFIX) || attached === undefined) {
            continue;
        }
        const activitySeconds = Number(activity);
        sessions.push({
            name,
            owner: owner === undefined || owner === "" ? undefined : owner,
            attached: attached !== "0",
            activityAt: Number.isFinite(activitySeconds) && activitySeconds > 0 ? activitySeconds * 1000 : now,
        });
    }
    return sessions;
};

export interface TerminalPolicy {
    // Since when this owner has had no run in flight; undefined means live, or not yet known to the caller.
    readonly ownerStoppedSince: (owner: string) => number | undefined;
    // Sessions of turns in flight, by name; a live turn's session is never reaped even without owner attribution.
    readonly liveNames: ReadonlySet<string>;
    readonly graceMs: number;
}

// Which agent sessions go this pass. Attached is absolute; an owned session goes once stopped past grace, an unowned
// one is judged by its own idle clock against the same grace.
export const reapableAgentSessionNames = (sessions: readonly AgentSessionState[], now: number, policy: TerminalPolicy): string[] =>
    sessions
        .filter((session) => {
            if (session.attached || policy.liveNames.has(session.name)) {
                return false;
            }
            if (session.owner === undefined) {
                return session.activityAt <= now - policy.graceMs;
            }
            const stoppedSince = policy.ownerStoppedSince(session.owner);
            return stoppedSince !== undefined && stoppedSince <= now - policy.graceMs;
        })
        .map((session) => session.name);

export interface ReaperDeps {
    // Whether this owner still has a run in flight, per the turn registry (plus the reserved owners).
    readonly ownerLive: (owner: string) => boolean;
    // Whether this owner is a conversation this daemon's registry knows (leftovers.ts LeftoverPolicy.ownerKnown).
    readonly ownerKnown: (owner: string) => boolean;
    // tmux session names of turns in flight.
    readonly liveSessionNames: () => ReadonlySet<string>;
    // Every live tmux pane's root pid, shared with the ports scan.
    readonly panePids: () => Promise<Map<number, string>>;
    // Fires with the conversation id the moment a run finishes, seeding the stop clock.
    readonly onOwnerStopped: (listener: (owner: string) => void) => () => void;
    readonly logger: Logger;
    readonly processGraceMs?: number;
    readonly terminalGraceMs?: number;
    readonly intervalMs?: number;
}

export interface ResourceReaper {
    readonly start: () => void;
    readonly stop: () => void;
    // One full sweep pass, exposed for boot and tests; never rejects.
    readonly sweep: () => Promise<void>;
    // Reaps everything this conversation holds immediately. `force` also kills attached terminals, for archive and
    // discard, which have already decided the conversation is over.
    readonly reapConversation: (owner: string, options?: { readonly force?: boolean }) => Promise<void>;
    readonly metrics: () => Readonly<Record<string, number>>;
}

const killSession = async (name: string): Promise<void> => {
    await execFileAsync("tmux", ["kill-session", "-t", `=${name}`]).catch(() => undefined);
};

const listAgentSessions = async (now: number): Promise<AgentSessionState[]> => {
    try {
        const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", SESSION_FORMAT]);
        return parseAgentSessions(stdout, now);
    } catch {
        // No tmux server: nothing of ours runs in a terminal.
        return [];
    }
};

export const createResourceReaper = (deps: ReaperDeps): ResourceReaper => {
    const { logger } = deps;
    const processGraceMs = deps.processGraceMs ?? PROCESS_GRACE_MS;
    const terminalGraceMs = deps.terminalGraceMs ?? TERMINAL_GRACE_MS;
    const intervalMs = deps.intervalMs ?? SWEEP_INTERVAL_MS;
    const group = ownProcessGroup();

    // Owner → when first known stopped; cleared when the owner runs again, resetting its grace window.
    const stoppedAt = new Map<string, number>();
    // Since when a pid has been unowned, and which pids were already asked; both pruned to pids still visible.
    const unownedSince = new Map<number, number>();
    const asked = new Set<number>();
    let lastDiskSweep = 0;
    let running = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    const scheduled = new Set<ReturnType<typeof setTimeout>>();

    const ownerStoppedSince = (owner: string, now: number): number | undefined => {
        if (deps.ownerLive(owner)) {
            stoppedAt.delete(owner);
            return undefined;
        }
        const since = stoppedAt.get(owner) ?? now;
        stoppedAt.set(owner, since);
        return since;
    };

    const sweepProcesses = async (now: number): Promise<void> => {
        if (group === undefined || process.platform !== "linux") {
            return;
        }
        const [scanned, panes] = await Promise.all([scanProcesses(), deps.panePids().catch(() => new Map<number, string>())]);
        const leftovers = leftoverProcesses(scanned, {
            group,
            ownerLive: deps.ownerLive,
            ownerKnown: deps.ownerKnown,
            panePids: new Set(panes.keys()),
        });
        const seen = new Set(leftovers.map((entry) => entry.pid));
        for (const pid of unownedSince.keys()) {
            if (!seen.has(pid)) {
                unownedSince.delete(pid);
                asked.delete(pid);
            }
        }
        const reclaimed: Leftover[] = [];
        for (const leftover of leftovers) {
            const since = unownedSince.get(leftover.pid) ?? now;
            unownedSince.set(leftover.pid, since);
            if (now - since < processGraceMs) {
                continue;
            }
            try {
                process.kill(leftover.pid, signalFor(leftover.pid, asked));
                reclaimed.push(leftover);
                asked.add(leftover.pid);
            } catch {
                // Already gone, or not ours to signal; the next pass sees the truth.
            }
        }
        if (reclaimed.length > 0) {
            logger.info(
                { reclaimed: reclaimed.length, group, owners: [...new Set(reclaimed.map((entry) => entry.owner))].slice(0, 10) },
                "reaper: reclaimed processes whose conversation had stopped",
            );
        }
    };

    const sweepTerminals = async (now: number): Promise<void> => {
        const sessions = await listAgentSessions(now);
        if (sessions.length === 0) {
            return;
        }
        const names = reapableAgentSessionNames(sessions, now, {
            ownerStoppedSince: (owner) => ownerStoppedSince(owner, now),
            liveNames: deps.liveSessionNames(),
            graceMs: terminalGraceMs,
        });
        if (names.length === 0) {
            return;
        }
        await Promise.all(names.map(killSession));
        logger.info({ count: names.length, sessions: names.slice(0, 10) }, "reaper: killed terminals of stopped conversations");
    };

    // Closes browser records of owners that have stopped; Chromium itself is reaped by the process sweep. Puts every
    // running record's owner on the stop clock, so browsing alone still closes on schedule.
    const sweepBrowsers = async (now: number): Promise<void> => {
        const owners = new Set<string>();
        for (const owner of runningBrowserOwners()) {
            const since = ownerStoppedSince(owner, now);
            if (since !== undefined && now - since >= processGraceMs) {
                owners.add(owner);
            }
        }
        await Promise.all([...owners].map((owner) => closeBrowserSessionsFor(owner)));
    };

    // A directory's own mtime freezes at creation, so age is judged by the newest file inside it.
    const newestMtime = async (path: string): Promise<number | undefined> => {
        const stats = await stat(path).catch(() => undefined);
        if (stats === undefined) {
            return undefined;
        }
        if (!stats.isDirectory()) {
            return stats.mtimeMs;
        }
        const children = await readdir(path).catch(() => [] as string[]);
        const stamps = await Promise.all(
            children.map((child) =>
                stat(join(path, child))
                    .then((s) => s.mtimeMs)
                    .catch(() => 0),
            ),
        );
        return Math.max(stats.mtimeMs, ...stamps);
    };

    const sweepDisk = async (now: number): Promise<void> => {
        if (now - lastDiskSweep < DISK_SWEEP_INTERVAL_MS) {
            return;
        }
        lastDiskSweep = now;
        const tmp = tmpdir();
        const entries = await readdir(tmp).catch(() => [] as string[]);
        let removed = 0;
        await Promise.all(
            entries.map(async (entry) => {
                const rule = TMP_SWEEPS.find((candidate) => entry.startsWith(candidate.prefix));
                if (rule === undefined) {
                    return;
                }
                const path = join(tmp, entry);
                const freshest = await newestMtime(path);
                if (freshest !== undefined && freshest <= now - rule.maxAgeMs) {
                    await rm(path, { recursive: true, force: true }).catch(() => undefined);
                    removed += 1;
                }
            }),
        );
        const signals = await readdir(SIGNALS_SWEEP.dir).catch(() => [] as string[]);
        await Promise.all(
            signals.map(async (entry) => {
                const path = join(SIGNALS_SWEEP.dir, entry);
                const stats = await stat(path).catch(() => undefined);
                if (stats !== undefined && stats.mtimeMs <= now - SIGNALS_SWEEP.maxAgeMs) {
                    await rm(path, { force: true }).catch(() => undefined);
                    removed += 1;
                }
            }),
        );
        if (removed > 0) {
            logger.info({ removed }, "reaper: swept expired temp state");
        }
    };

    const sweep = async (): Promise<void> => {
        if (running) {
            return;
        }
        running = true;
        try {
            const now = Date.now();
            // Drops stale owners so the map cannot grow forever; pruned by a day, not a grace.
            for (const [owner, since] of stoppedAt) {
                if (now - since > 24 * 3_600_000) {
                    stoppedAt.delete(owner);
                }
            }
            await sweepProcesses(now);
            await sweepTerminals(now);
            await sweepBrowsers(now);
            await sweepDisk(now);
        } catch (error) {
            logger.warn({ err: error }, "reaper: sweep failed");
        } finally {
            running = false;
        }
    };

    const reapConversation = async (owner: string, options: { readonly force?: boolean } = {}): Promise<void> => {
        const now = Date.now();
        try {
            const sessions = await listAgentSessions(now);
            const mine = sessions.filter((session) => session.owner === owner && (options.force === true || !session.attached));
            await Promise.all(mine.map((session) => killSession(session.name)));
            await closeBrowserSessionsFor(owner);
            if (group !== undefined && process.platform === "linux") {
                // The conversation is over: SIGTERM its processes now; survivors meet SIGKILL on the interval sweep.
                const [scanned, panes] = await Promise.all([scanProcesses(), deps.panePids().catch(() => new Map<number, string>())]);
                const mineToo = leftoverProcesses(scanned, {
                    group,
                    ownerLive: (candidate) => candidate !== owner && deps.ownerLive(candidate),
                    ownerKnown: deps.ownerKnown,
                    panePids: new Set(panes.keys()),
                }).filter((leftover) => leftover.owner === owner);
                for (const leftover of mineToo) {
                    try {
                        process.kill(leftover.pid, "SIGTERM");
                        asked.add(leftover.pid);
                    } catch {
                        // Already gone, which is the goal.
                    }
                }
            }
            if (mine.length > 0) {
                logger.info({ owner, terminals: mine.length }, "reaper: reaped a conversation's resources on demand");
            }
        } catch (error) {
            logger.warn({ err: error, owner }, "reaper: on-demand reap failed");
        }
    };

    const start = (): void => {
        if (timer !== undefined) {
            return;
        }
        timer = setInterval(() => void sweep(), intervalMs);
        // The reaper must never be what keeps the daemon alive.
        timer.unref();
        unsubscribe = deps.onOwnerStopped((owner) => {
            stoppedAt.set(owner, Date.now());
            // Acts grace after the stop, not after a timer notices it, via one scheduled pass per grace edge.
            for (const delay of [processGraceMs + 2_000, terminalGraceMs + 2_000]) {
                const edge = setTimeout(() => {
                    scheduled.delete(edge);
                    void sweep();
                }, delay);
                edge.unref();
                scheduled.add(edge);
            }
        });
    };

    const stop = (): void => {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
        unsubscribe?.();
        unsubscribe = undefined;
        for (const edge of scheduled) {
            clearTimeout(edge);
        }
        scheduled.clear();
    };

    return {
        start,
        stop,
        sweep,
        reapConversation,
        metrics: () => ({ stoppedOwners: stoppedAt.size, trackedPids: unownedSince.size, askedPids: asked.size, edgeTimers: scheduled.size }),
    };
};
