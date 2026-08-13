import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENT_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import type { Logger } from "pino";
import { closeBrowserSessionsFor, runningBrowserOwners } from "../browser/browser-sessions.js";
import { type Leftover, leftoverProcesses, ownProcessGroup, scanProcesses, signalFor } from "./leftovers.js";

/* THE REAPER — everything a conversation holds, reclaimed on one clock, from one place.
 *
 * A conversation that stops leaves things behind, and before this module each kind had its own custodian on its
 * own schedule: stamped processes on a 3-minute grace (leftovers), tmux sessions on a 2-hour idle sweep that
 * never touched a live pane at all, browser records on a prune nobody triggered, and /tmp on nothing. The sum
 * read as "cleanup exists"; the machine read 17 idle terminals, a fleet of orphaned dev servers, and a sandbox
 * swapping itself to death. The policies were not wrong one by one — they were never one policy.
 *
 * Now they are. The unit of ownership is the CONVERSATION (the same owner the workload stamp carries and the
 * turn registry reports on), the unit of time is "how long since it stopped", and every resource kind hangs off
 * that single clock:
 *
 *   · processes   — stamped with the owner (platform/leftovers.ts), SIGTERM → SIGKILL once the owner has been
 *                   stopped past PROCESS_GRACE. Pane-descended trees are exempt while their pane lives, because
 *                   the session below owns them as a unit.
 *   · terminals   — the conversation's `agent-*` tmux sessions, live panes INCLUDED, killed once the owner has
 *                   been stopped past TERMINAL_GRACE and nobody is attached. A watched session survives while
 *                   it is watched; detaching hands it to the next pass. This deliberately ends the era of the
 *                   immortal left-behind dev server.
 *   · browsers    — the daemon-side records close with the turn (Chromium itself is part of the stamped tree
 *                   and dies with it); the reaper is the backstop for records whose disconnect never fired.
 *   · disk        — the /tmp state turns mint (tmux-run capture dirs, land/classify patch dirs, delegation
 *                   signals), swept hourly by name prefix and age. Worktrees are NOT here: they are the user's
 *                   work, and archive/discard owns them (agents/archive.ts).
 *
 * "Stopped" means the turn registry reports no run in flight — the same fact the chat, the fleet card and the
 * journal key on. The settle event seeds the clock exactly (onOwnerStopped), so a stop is acted on GRACE after
 * it happened, not GRACE after a timer noticed; after a daemon restart the clock starts at first sight, which
 * only ever errs toward patience.
 *
 * Archive and discard are the hard stop: the user has filed the conversation away (or destroyed it), so its
 * resources go NOW, attached viewers included on discard — reapConversation(id, { force: true }).
 *
 * The tmux side is attributed by the `@intentic_owner` session option (set by bin/tmux-run at session creation,
 * from the same stamp the processes carry), so a session names its owner even after every pane in it has died
 * and there is no environ left to read. A session with no owner option is judged by its own idle clock instead:
 * fresh-state rules, no second policy for how it got that way. */

const execFileAsync = promisify(execFile);

// tmux user option carrying the owning conversation id — set once per session by bin/tmux-run, read back by
// the sweep's list format. Contract between exactly those two places.
export const TMUX_OWNER_OPTION = "@intentic_owner";

/* HOW LONG AN OWNER MAY BE STOPPED before each kind of resource goes.
 *
 * Processes: long enough that a turn's own unwind — the SDK's stdin-EOF, its grace, its SIGTERM, and whatever
 * the CLI then does to its MCP servers — has plainly had its chance and not taken it. Terminals: long enough
 * that the Bash card of the turn that just ended still opens a live scrollback, and that a follow-up message
 * sent minutes later finds its background job still there — then gone, because every pane's bytes are already
 * in the terminal logs and the transcript holds the commands. The tab was never the record. */
const PROCESS_GRACE_MS = 2 * 60_000;
const TERMINAL_GRACE_MS = 10 * 60_000;

const SWEEP_INTERVAL_MS = 60_000;
const DISK_SWEEP_INTERVAL_MS = 3_600_000;

/* The /tmp state turns leave behind, swept by prefix + age. `intentic-run-` is a tmux-run capture dir whose
 * wrapper never got to its own `rm -rf` (soft-timeout returns early on purpose; SIGKILL skips traps) — a day
 * covers any command still legitimately streaming into one. The patch dirs are land/classify workspaces whose
 * in-line cleanup a crash skipped. Delegation signal files are deleted the moment they are folded, so anything
 * still there after a day is a spool orphan (a hook that fired while no daemon lived). */
const TMP_SWEEPS: readonly { readonly prefix: string; readonly maxAgeMs: number }[] = [
    { prefix: "intentic-run-", maxAgeMs: 24 * 3_600_000 },
    { prefix: "intentic-classify-", maxAgeMs: 6 * 3_600_000 },
    { prefix: "intentic-land-", maxAgeMs: 6 * 3_600_000 },
];
const SIGNALS_SWEEP = { dir: join(tmpdir(), "intentic", "agent-signals"), maxAgeMs: 24 * 3_600_000 };

// One agent tmux session as the sweep sees it: who owns it, whether anyone is watching, when it last moved.
export interface AgentSessionState {
    readonly name: string;
    readonly owner: string | undefined;
    readonly attached: boolean;
    readonly activityAt: number;
}

// The list format below — tab-separated because the owner field may be empty, and a space-split would shift
// every field after a hole.
const SESSION_FORMAT = `#{session_name}\t#{${TMUX_OWNER_OPTION}}\t#{session_attached}\t#{session_activity}`;

// The pure parse, one row per SESSION (list-sessions, not list-panes: the decision below needs no per-pane
// fact — pane liveness deliberately does not matter to it). An unparseable activity stamp reads as "just now":
// the flag gates a kill, so the safe direction is "keep".
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
    // Since when this owner has had no run in flight — undefined means it is live (or unknown, which the
    // caller seeds as "first seen now" before asking).
    readonly ownerStoppedSince: (owner: string) => number | undefined;
    // Sessions of turns in flight, by name — the belt to the owner clock's braces: a live turn's session is
    // never reaped even if its owner attribution failed.
    readonly liveNames: ReadonlySet<string>;
    readonly graceMs: number;
}

/* The pure decision: which agent sessions go this pass. Attached is absolute (someone is LOOKING at it — the
 * kill button in the panel is theirs to press); an owned session goes when its owner has been stopped past the
 * grace; an unowned one is judged by its own idle clock against the same grace, because a session nobody can
 * attribute is not entitled to a longer afterlife than one somebody can. */
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
    // Whether this owner still has a run in flight — the turn registry's answer (plus the reserved owners).
    readonly ownerLive: (owner: string) => boolean;
    // Whether this owner is a conversation this daemon's registry knows — the out-of-group licence
    // (platform/leftovers.ts LeftoverPolicy.ownerKnown).
    readonly ownerKnown: (owner: string) => boolean;
    // The tmux session names of turns in flight (registry's live session ids, name-derived).
    readonly liveSessionNames: () => ReadonlySet<string>;
    // Every live tmux pane's root pid — the pane exemption's input, shared with the ports scan.
    readonly panePids: () => Promise<Map<number, string>>;
    // The settle event: fires with the conversation id the moment a run finishes, seeding the stop clock.
    readonly onOwnerStopped: (listener: (owner: string) => void) => () => void;
    readonly logger: Logger;
    readonly processGraceMs?: number;
    readonly terminalGraceMs?: number;
    readonly intervalMs?: number;
}

export interface ResourceReaper {
    readonly start: () => void;
    readonly stop: () => void;
    // One full pass, exposed for boot and tests. Never rejects.
    readonly sweep: () => Promise<void>;
    // The hard stop: everything this conversation holds goes now. `force` includes attached terminals — discard
    // and archive have already decided the conversation is over, watchers included.
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
        // No tmux server ⇒ nothing of ours runs in a terminal.
        return [];
    }
};

export const createResourceReaper = (deps: ReaperDeps): ResourceReaper => {
    const { logger } = deps;
    const processGraceMs = deps.processGraceMs ?? PROCESS_GRACE_MS;
    const terminalGraceMs = deps.terminalGraceMs ?? TERMINAL_GRACE_MS;
    const intervalMs = deps.intervalMs ?? SWEEP_INTERVAL_MS;
    const group = ownProcessGroup();

    /* The stop clock: owner → when it was first known to be stopped. Seeded exactly by the settle event, lazily
     * by the sweep for stops nobody announced (a daemon restart), and cleared the moment the owner runs again —
     * so a follow-up message resets every grace window it is entitled to. */
    const stoppedAt = new Map<string, number>();
    // Process-sweep state: since when a pid has been unowned, and which pids were already asked nicely. Both
    // pruned to what the current pass can still see, so an exited (or reused) pid carries nothing forward.
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
                // Already gone, or not ours to signal. Either way the next pass sees the truth.
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

    // Browser records whose owner has stopped: Chromium itself is part of the stamped tree (the process sweep's
    // business); this closes the observer record — and with it any Chromium whose disconnect never fired. Every
    // running record's owner is put on the stop clock here, so a conversation that browsed without ever opening
    // a terminal still closes on schedule.
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

    /* A capture dir's own mtime freezes at creation (appends inside move only the file), so a directory is
     * judged by the newest thing IN it — a dev server still tee-ing into its `out` a day later keeps its dir. */
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
            /* The stop clock is pruned by liveness on read (ownerStoppedSince); owners nothing references any
             * more are dropped here so the map cannot grow one entry per conversation forever. A day, not a
             * multiple of the graces: an ATTACHED terminal of a stopped conversation legitimately outlives
             * every grace, and pruning its owner's clock would restart the wait each time someone detached. */
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
                // The conversation is over by decree, so its stamped processes get their SIGTERM now — pane
                // trees included, whose sessions died above. Survivors meet SIGKILL on the interval sweep.
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
                        // Already gone — which is the goal.
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
            /* Act GRACE after the stop, not GRACE after a timer notices the stop: one pass at each grace edge
             * (plus slack for the clocks to agree), so the longest a resource outlives its conversation is the
             * grace itself. The interval remains the backstop for everything event-less. */
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
