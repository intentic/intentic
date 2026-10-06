import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AGENT_SESSION_PREFIX,
    BROWSER_SESSION_PREFIX,
    JOB_SESSION_PREFIX,
    PANEL_SESSION_PREFIX,
    WEB_SESSION_PREFIX,
} from "@intentic/sandbox-contract/session-names";
import type { Logger } from "pino";
import { errnoCode } from "@intentic/base/errors";
import { forkedExec } from "@intentic/base/git";
import { WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { SERVICE_SESSION_PREFIX } from "../../terminal/terminal-session.js";
import { HOLDER_SESSION, isNoTmuxServer } from "../../terminal/tmux-server.js";
import { type ScannedProcess, scanProcesses } from "../resources/process-scan.js";
import { endProcess, overdueDetached, processAges } from "./generation-sweep.js";
import { type Leftover, leftoverProcesses, ownProcessGroup, signalFor, type SweptProcess } from "./leftovers.js";

// A signal sent to a process that exited meanwhile (ESRCH), or whose id now names someone else's (EPERM), lost a race
// the next pass settles; any other refusal is a fault worth surfacing.
const signalRaced = (error: unknown): boolean => {
    const code = errnoCode(error);
    return code === "ESRCH" || code === "EPERM";
};

// Reclaims everything a conversation holds (processes, tmux terminals, browser records, scratch /tmp state) once the
// turn registry reports it stopped, on one clock instead of one policy per resource kind. Archive and discard bypass
// the grace and reap immediately, attached terminals included.

// tmux user option carrying the owning conversation id; set once by bin/tmux-run, read back by the sweep.
const TMUX_OWNER_OPTION = "@intentic_owner";

// How long a stopped owner's resources wait before reclaim: processes wait out their own SDK unwind and SIGTERM chain;
// terminals wait long enough for a live scrollback and a delayed follow-up message to still find their job.
const PROCESS_GRACE_MS = 2 * 60_000;
const TERMINAL_GRACE_MS = 10 * 60_000;
// How long a session whose owner is still LIVE may sit untouched before its own clock ends it. Everything below
// keys off the owner having stopped, which a conversation that goes on working never does — so the session of a
// turn it replaced an hour ago is held, and so is anything stuck inside it (measured: a hung `npx` held a queue
// slot for 26 minutes in a session its conversation had moved on from). Six times the stopped grace, because
// here the cost of being wrong is a live conversation losing scrollback it might still come back to.
const TERMINAL_IDLE_MS = 60 * 60_000;
// How long a browser nobody is driving stays open, on its own clock rather than its owner's. Matched to the terminal
// grace: both are things a turn may come back to, and a Chromium is the more expensive of the two to leave standing
// (a dozen processes and a few hundred MB against a tmux session's kilobytes).
const BROWSER_IDLE_MS = 10 * 60_000;

const SWEEP_INTERVAL_MS = 60_000;
const DISK_SWEEP_INTERVAL_MS = 3_600_000;

// Prefix-and-age sweep for /tmp state a crashed or soft-timed-out turn can leave behind (capture dirs, patch dirs,
// delegation signal files); worktrees are not here, archive/discard owns those.
const TMP_SWEEPS: readonly { readonly prefix: string; readonly maxAgeMs: number }[] = [
    { prefix: "intentic-run-", maxAgeMs: 24 * 3_600_000 },
    { prefix: "intentic-classify-", maxAgeMs: 6 * 3_600_000 },
    { prefix: "intentic-land-", maxAgeMs: 6 * 3_600_000 },
    // An offloaded command's scratch: bin/offload-run's offload-snapshot-* and offload-patch-*, which a killed run leaves,
    // and a runner's own offload-* (runners/runner-command.ts). A day, like a run's capture: past any run's timeout (six
    // hours at most), and a patch that would not apply is left there on purpose, for someone to apply by hand.
    { prefix: "offload-", maxAgeMs: 24 * 3_600_000 },
];

// How old a /tmp entry of this name may get before the sweep removes it; undefined for one it never touches.
export const tmpSweepAgeOf = (entry: string): number | undefined => TMP_SWEEPS.find((candidate) => entry.startsWith(candidate.prefix))?.maxAgeMs;
const SIGNALS_SWEEP = { dir: join(tmpdir(), "intentic", "agent-signals"), maxAgeMs: 24 * 3_600_000 };

// One tmux session as the sweep sees it: owner, whether attached, last activity.
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
export const parseSessions = (stdout: string, now: number): AgentSessionState[] => {
    const sessions: AgentSessionState[] = [];
    for (const line of stdout.split("\n")) {
        const [name, owner, attached, activity] = line.split("\t");
        if (name === undefined || name === "" || attached === undefined) {
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

export const parseAgentSessions = (stdout: string, now: number): AgentSessionState[] =>
    parseSessions(stdout, now).filter((session) => session.name.startsWith(AGENT_SESSION_PREFIX));

// The sandbox's own session names, each retired by its own sweep: agent and job terminals, panels, the owner's web
// terminals, services, and the server's pin.
const OWN_SESSION_PREFIXES = [
    AGENT_SESSION_PREFIX,
    JOB_SESSION_PREFIX,
    PANEL_SESSION_PREFIX,
    WEB_SESSION_PREFIX,
    BROWSER_SESSION_PREFIX,
    SERVICE_SESSION_PREFIX,
];

// What a session is to the sweep (2026-10-05): one of the sandbox's own (`own`), one a conversation's agent made by hand
// with `tmux new-session` (`tagged`: bin/tmux-run's owner option, or the owner its creating shell's environment carried
// in, which terminal/tmux-server.ts has tmux copy into the session), or one nobody can name (`untagged`: a person's own,
// or a program's).
export type SessionKind = "own" | "tagged" | "untagged";

export const sessionKind = (session: Pick<AgentSessionState, "name" | "owner">): SessionKind => {
    if (session.name === HOLDER_SESSION || OWN_SESSION_PREFIXES.some((prefix) => session.name.startsWith(prefix))) {
        return "own";
    }
    return session.owner === undefined ? "untagged" : "tagged";
};

/**
 * Which hand-made sessions of an agent go this pass: one whose conversation is gone (deleted, or archived) past the
 * grace, never an attached one. `goneSince` answers undefined while the conversation stands or the registry cannot
 * tell, and nothing goes on doubt.
 */
export const reapableTaggedSessionNames = (
    sessions: readonly AgentSessionState[],
    now: number,
    { goneSince, graceMs }: { readonly goneSince: (owner: string) => number | undefined; readonly graceMs: number },
): string[] =>
    sessions
        .filter((session) => {
            if (session.attached || session.owner === undefined || sessionKind(session) !== "tagged") {
                return false;
            }
            const since = goneSince(session.owner);
            return since !== undefined && since <= now - graceMs;
        })
        .map((session) => session.name);

// The owner a hand-made session's creating shell carried in, which tmux copied into its environment; undefined when it
// carried none.
export const parseSessionOwner = (stdout: string): string | undefined => {
    const line = stdout.split("\n").find((candidate) => candidate.startsWith(`${WORKLOAD_ENV}=`));
    const owner = line?.slice(WORKLOAD_ENV.length + 1).trim();
    return owner === undefined || owner === "" ? undefined : owner;
};

export interface TerminalPolicy {
    // Since when this owner has had no run in flight; undefined means live, or not yet known to the caller.
    readonly ownerStoppedSince: (owner: string) => number | undefined;
    // Sessions of turns in flight, by name; a live turn's session is never reaped even without owner attribution.
    readonly liveNames: ReadonlySet<string>;
    readonly graceMs: number;
    // Ceiling for a session whose owner has NOT stopped; without it a working conversation holds every session it
    // ever opened, which is the one case the stop clock structurally cannot reach.
    readonly idleMs: number;
}

// Which agent sessions go this pass. Attached is absolute; an owned session goes once stopped past grace, an unowned
// one is judged by its own idle clock against the same grace, and a live owner's stale session by that clock against
// the longer ceiling.
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
            if (stoppedSince !== undefined) {
                return stoppedSince <= now - policy.graceMs;
            }
            // Owner still working. A turn in flight is already excluded by `liveNames` above, so what is left is a
            // session the conversation has replaced and will not touch again.
            return session.activityAt <= now - policy.idleMs;
        })
        .map((session) => session.name);

// The browser records the reaper closes (browser/sessions/browser-sessions.ts), handed in since browsers sit above
// system/: the owners with a browser running, the sessions nobody has driven for `idleMs`, and closing either.
export interface ReaperBrowsers {
    readonly runningOwners: () => readonly string[];
    readonly idleNames: (now: number, idleMs: number) => readonly string[];
    readonly close: (name: string) => Promise<void>;
    readonly closeFor: (owner: string) => Promise<void>;
}

export interface ReaperDeps {
    readonly browsers: ReaperBrowsers;
    // Whether this owner still has a run in flight, per the turn registry (plus the reserved owners).
    readonly ownerLive: (owner: string) => boolean;
    // The same question for its processes alone: a turn in flight, not a watch the conversation waits on. A watch keeps
    // the conversation for its wake, never a finished turn's processes (2026-10-05). Absent, `ownerLive`.
    readonly processOwnerLive?: (owner: string) => boolean;
    // Whether this conversation is gone for good (deleted, or archived): true or false once the registry can say,
    // undefined while it cannot. Retires the sessions an agent made by hand. Absent, none are retired.
    readonly ownerGone?: (owner: string) => boolean | undefined;
    // Whether this owner is a conversation this daemon's registry knows (leftovers.ts LeftoverPolicy.ownerKnown).
    readonly ownerKnown: (owner: string) => boolean;
    // tmux session names of turns in flight.
    readonly liveSessionNames: () => ReadonlySet<string>;
    // Every live tmux pane's root pid, shared with the ports scan.
    readonly panePids: () => Promise<Map<number, string>>;
    // The /tmp capture dirs of jobs kept running for the person, which the tmp sweep leaves however quiet they are.
    readonly keptJobDirs?: (root: string) => readonly string[];
    // Fires with the conversation id the moment a run finishes, seeding the stop clock.
    readonly onOwnerStopped: (listener: (owner: string) => void) => () => void;
    readonly logger: Logger;
    readonly processGraceMs?: number;
    readonly terminalGraceMs?: number;
    readonly terminalIdleMs?: number;
    readonly browserIdleMs?: number;
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
    await forkedExec("tmux", ["kill-session", "-t", `=${name}`]).catch(() => undefined);
};

const listSessions = async (now: number): Promise<AgentSessionState[]> => {
    try {
        const { stdout } = await forkedExec("tmux", ["list-sessions", "-F", SESSION_FORMAT]);
        return parseSessions(stdout, now);
    } catch (error) {
        // No tmux server: nothing of ours runs in a terminal. Any other failure left the question unanswered, so the
        // pass fails (its caller logs it) rather than sweeping as if no terminal shielded anything.
        if (isNoTmuxServer(error)) {
            return [];
        }
        throw error;
    }
};

const listAgentSessions = async (now: number): Promise<AgentSessionState[]> =>
    (await listSessions(now)).filter((session) => session.name.startsWith(AGENT_SESSION_PREFIX));

// A hand-made session's owner, from the environment its creating shell carried in, written onto the session as the
// owner option so it outlives a later attach (which drops a variable the attaching client lacks).
const tagFromEnvironment = async (session: AgentSessionState): Promise<AgentSessionState> => {
    if (session.owner !== undefined || sessionKind(session) === "own") {
        return session;
    }
    const shown = await forkedExec("tmux", ["show-environment", "-t", `=${session.name}`, WORKLOAD_ENV]).catch(() => undefined);
    const owner = parseSessionOwner(shown?.stdout ?? "");
    if (owner === undefined) {
        return session;
    }
    await forkedExec("tmux", ["set-option", "-t", `=${session.name}:`, TMUX_OWNER_OPTION, owner]).catch(() => undefined);
    return { ...session, owner };
};

// The pane pids that shield everything under them, and those of the untagged sessions, which shield only the young.
export interface PaneShields {
    readonly full: ReadonlySet<number>;
    readonly untagged: ReadonlySet<number>;
}

export const paneShields = (panes: ReadonlyMap<number, string>, sessions: readonly AgentSessionState[]): PaneShields => {
    const untaggedNames = new Set(sessions.filter((session) => sessionKind(session) === "untagged").map((session) => session.name));
    const full = new Set<number>();
    const untagged = new Set<number>();
    for (const [pid, name] of panes) {
        (untaggedNames.has(name) ? untagged : full).add(pid);
    }
    return { full, untagged };
};

// A watch check or an edit rule's command past its own deadline, whichever run started it, ended with its group; answers
// which.
const endOverdue = (scanned: readonly ScannedProcess[], now: number): number[] => {
    const leaders = new Map(scanned.map((entry) => [entry.pid, entry.pgrp === entry.pid]));
    return overdueDetached(scanned, now).filter((pid) => endProcess(pid, leaders.get(pid) === true, "SIGKILL"));
};

// The scan with each process's age, read only when an untagged pane makes age matter.
const aged = async (scanned: readonly ScannedProcess[], needed: boolean): Promise<readonly SweptProcess[]> => {
    if (!needed) {
        return scanned;
    }
    const ages = await processAges(scanned).catch(() => new Map<number, number>());
    return scanned.map((entry) => {
        const ageMs = ages.get(entry.pid);
        return ageMs === undefined ? entry : { ...entry, ageMs };
    });
};

// After a forced reap's SIGTERM, how long its processes have before SIGKILL, and how long the owner is remembered for
// it: the registry may forget the conversation the moment the reap returns (a discard), and the sweep would then no
// longer license a survivor outside the daemon's group.
const FORCED_KILL_AFTER_MS = 10_000;

export const createResourceReaper = (deps: ReaperDeps): ResourceReaper => {
    const { logger } = deps;
    const processGraceMs = deps.processGraceMs ?? PROCESS_GRACE_MS;
    const terminalGraceMs = deps.terminalGraceMs ?? TERMINAL_GRACE_MS;
    const terminalIdleMs = deps.terminalIdleMs ?? TERMINAL_IDLE_MS;
    const browserIdleMs = deps.browserIdleMs ?? BROWSER_IDLE_MS;
    const intervalMs = deps.intervalMs ?? SWEEP_INTERVAL_MS;
    const group = ownProcessGroup();

    const processOwnerLive = deps.processOwnerLive ?? deps.ownerLive;
    // Owner → when first known stopped; cleared when the owner runs again, resetting its grace window.
    const stoppedAt = new Map<string, number>();
    // Owner → when first known gone for good, for the sessions its agent made by hand.
    const goneAt = new Map<string, number>();
    // Owner → until when a forced reap licenses its processes, whatever the registry says by then.
    const forcedUntil = new Map<string, number>();
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

    const goneSince = (owner: string, now: number): number | undefined => {
        if (deps.ownerGone?.(owner) !== true) {
            goneAt.delete(owner);
            return undefined;
        }
        const since = goneAt.get(owner) ?? now;
        goneAt.set(owner, since);
        return since;
    };

    const forced = (owner: string, now: number): boolean => (forcedUntil.get(owner) ?? 0) > now;

    const sweepProcesses = async (now: number, sessions: readonly AgentSessionState[]): Promise<void> => {
        if (group === undefined || process.platform !== "linux") {
            return;
        }
        let panes: Map<number, string>;
        try {
            panes = await deps.panePids();
        } catch (error) {
            // Unknown panes are not "no panes": every process under a live terminal would lose its exemption.
            logger.warn({ err: error }, "reaper: could not list terminal panes, skipping the process sweep this pass");
            return;
        }
        const scanned = await scanProcesses();
        const ended = endOverdue(scanned, now);
        if (ended.length > 0) {
            logger.warn({ pids: ended }, "reaper: ended detached commands past their own deadline");
        }
        const shields = paneShields(panes, sessions);
        const leftovers = leftoverProcesses(await aged(scanned, shields.untagged.size > 0), {
            group,
            ownerLive: (owner) => !forced(owner, now) && processOwnerLive(owner),
            ownerKnown: (owner) => forced(owner, now) || deps.ownerKnown(owner),
            panePids: shields.full,
            untaggedPanePids: shields.untagged,
            selfPid: process.pid,
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
            } catch (error) {
                // Already gone, or not ours to signal; the next pass sees the truth. Anything else is not a race.
                if (!signalRaced(error)) {
                    throw error;
                }
            }
        }
        if (reclaimed.length > 0) {
            logger.info(
                { reclaimed: reclaimed.length, group, owners: [...new Set(reclaimed.map((entry) => entry.owner))].slice(0, 10) },
                "reaper: reclaimed processes whose conversation had stopped",
            );
        }
    };

    const sweepTerminals = async (now: number, sessions: readonly AgentSessionState[]): Promise<void> => {
        if (sessions.length === 0) {
            return;
        }
        const names = reapableAgentSessionNames(
            sessions.filter((session) => session.name.startsWith(AGENT_SESSION_PREFIX)),
            now,
            {
                ownerStoppedSince: (owner) => ownerStoppedSince(owner, now),
                liveNames: deps.liveSessionNames(),
                graceMs: terminalGraceMs,
                idleMs: terminalIdleMs,
            },
        );
        if (names.length > 0) {
            await Promise.all(names.map(killSession));
            logger.info({ count: names.length, sessions: names.slice(0, 10) }, "reaper: killed terminals of stopped conversations");
        }
        const handMade = reapableTaggedSessionNames(sessions, now, { goneSince: (owner) => goneSince(owner, now), graceMs: terminalGraceMs });
        if (handMade.length > 0) {
            await Promise.all(handMade.map(killSession));
            logger.info(
                { count: handMade.length, sessions: handMade.slice(0, 10) },
                "reaper: killed sessions agents made whose conversation is gone",
            );
        }
    };

    // Closes browser records of owners that have stopped; Chromium itself is reaped by the process sweep. Puts every
    // running record's owner on the stop clock, so browsing alone still closes on schedule.
    //
    // Then the same question asked of the SESSION rather than the owner: the pass above can only fire once a
    // conversation has no run in flight, so a conversation that keeps working holds every browser it ever opened —
    // measured at 25 Chromium processes for 2 browsers, one of them untouched for 21 minutes. Re-opening is what the
    // PreToolUse hook already does on the next browser call, so a closed idle session costs a relaunch, not an error.
    const sweepBrowsers = async (now: number): Promise<void> => {
        const owners = new Set<string>();
        for (const owner of deps.browsers.runningOwners()) {
            const since = ownerStoppedSince(owner, now);
            if (since !== undefined && now - since >= processGraceMs) {
                owners.add(owner);
            }
        }
        await Promise.all([...owners].map((owner) => deps.browsers.closeFor(owner)));
        const idle = deps.browsers.idleNames(now, browserIdleMs);
        if (idle.length > 0) {
            await Promise.all(idle.map((name) => deps.browsers.close(name)));
            logger.info({ count: idle.length, sessions: idle.slice(0, 10) }, "reaper: closed idle browsers");
        }
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
        // A job kept for the person writes nothing while it runs quietly, and its file is what takes it back after a
        // restart.
        const kept = new Set(deps.keptJobDirs?.(tmp) ?? []);
        let removed = 0;
        await Promise.all(
            entries.map(async (entry) => {
                const maxAgeMs = tmpSweepAgeOf(entry);
                if (maxAgeMs === undefined || kept.has(join(tmp, entry))) {
                    return;
                }
                const path = join(tmp, entry);
                const freshest = await newestMtime(path);
                if (freshest !== undefined && freshest <= now - maxAgeMs) {
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
            for (const [owner, until] of forcedUntil) {
                if (until <= now) {
                    forcedUntil.delete(owner);
                }
            }
            const sessions = await Promise.all((await listSessions(now)).map(tagFromEnvironment));
            await sweepProcesses(now, sessions);
            await sweepTerminals(now, sessions);
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
            await deps.browsers.closeFor(owner);
            if (group !== undefined && process.platform === "linux") {
                // The conversation is over: SIGTERM its processes now; survivors meet SIGKILL on the interval sweep.
                // A pane listing that fails rejects to the catch below rather than exempting nothing.
                const [scanned, panes] = await Promise.all([scanProcesses(), deps.panePids()]);
                const mineToo = leftoverProcesses(scanned, {
                    group,
                    ownerLive: (candidate) => candidate !== owner && processOwnerLive(candidate),
                    ownerKnown: (candidate) => candidate === owner || deps.ownerKnown(candidate),
                    panePids: new Set(panes.keys()),
                    selfPid: process.pid,
                }).filter((leftover) => leftover.owner === owner);
                for (const leftover of mineToo) {
                    try {
                        process.kill(leftover.pid, "SIGTERM");
                        asked.add(leftover.pid);
                        // Already past its grace: the next pass that still finds it sends the SIGKILL.
                        unownedSince.set(leftover.pid, now - processGraceMs);
                    } catch (error) {
                        // Already gone, which is the goal.
                        if (!signalRaced(error)) {
                            throw error;
                        }
                    }
                }
                if (mineToo.length > 0) {
                    // Remembered past the registry: a discard forgets the conversation the moment this returns, and the
                    // pass below must still find its survivors to SIGKILL them.
                    forcedUntil.set(owner, now + FORCED_KILL_AFTER_MS + processGraceMs);
                    const edge = setTimeout(() => {
                        scheduled.delete(edge);
                        void sweep();
                    }, FORCED_KILL_AFTER_MS);
                    edge.unref();
                    scheduled.add(edge);
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
        metrics: () => ({
            stoppedOwners: stoppedAt.size,
            goneOwners: goneAt.size,
            forcedOwners: forcedUntil.size,
            trackedPids: unownedSince.size,
            askedPids: asked.size,
            edgeTimers: scheduled.size,
        }),
    };
};
