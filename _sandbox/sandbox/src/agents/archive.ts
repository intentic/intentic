import type { AgentSummary } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ResourceReaper } from "../platform/reaper.js";
import type { AgentsRegistry } from "./agents-registry.js";
import type { PersistedAgent } from "./agents-store.js";
import type { AgentWorktrees } from "./worktrees.js";

// ARCHIVING, the board's only exit that isn't a deletion.
//
// The Finished lane is the fleet's one terminal state: nothing transitions out of `landed`/`idle`, so without
// this every agent that ever ran stays on the board forever. And a finished card is not a row, it holds a git
// worktree, one full checkout PER REPO, for as long as the entry lives. So the lane growing without bound is a
// disk footprint growing without bound, and any fix that only hid old cards would turn a visible cost into an
// invisible one.
//
// What archiving costs the user is therefore exactly nothing, and that is the point, it is what lets the
// sweep below run unattended and the UI ask no confirmation:
//   · whatever the worktree still held is COMMITTED onto agent/<id> first (worktrees.retire)
//   · every commit, the registry entry, every counter, and the transcript all stay
//   · only the CHECKOUT is reclaimed, the one part that is pure cache, restorable from the commits
//   · and the branch moves off refs/heads/ onto the parked shelf (agents/agent-refs.ts), so a fleet's worth of
//     archived conversations stops being a fleet's worth of branches in every repo. `agent/<id>` still names
//     the same commits either way, which is why nothing below this file has to know.
// A follow-up message re-attaches the checkout, unparks the branch and clears the marker (registry.begin +
// worktrees.ensure), the review still reads from the two refs (agents.routes diff/fileDiff), and `unarchive`
// puts the card back on the board untouched.
//
// Contrast `discard`, which is the destructive one: it drops the branch too, and with it the only record of
// work that never landed.

/* Is this agent safe to archive UNATTENDED? The guards are about not stranding the user, not about disk, and
 * they are exactly two statuses wide because the SUMMARY status already folds in everything they used to test
 * separately. Reading the summary rather than the persisted entry is what keeps this honest: `conflict` and
 * `ready` are derived per roster now (agents/standing.ts), so an entry-level test could not see them at all,
 * and the sweep would have started filing conflicted and held-work agents away unread.
 *
 * What each excluded status is protecting:
 *   · running/awaiting, the worktree is the live turn's working state (the same guard land/discard take), and
 *     an awaiting turn is holding a question
 *   · conflict, the card is in the Attention lane asking for something; archiving it hides the ask
 *   · ready, a held delta nobody has landed yet: finished, but the user's deliberate land is still owed
 *   · error, a failure nobody has necessarily seen
 *   · interrupted, the same, for a turn the daemon died under: its worktree holds however far it got. This one
 *     is why the status is persisted rather than rehydrating to `idle`: the runtime flags a park raised die
 *     WITH the daemon, so a question-blocked agent used to come back `idle` and not running, passing every
 *     guard here, and eligible to be swept away unread.
 * `idle` with nothing landed is the most archivable case there is: a throwaway agent that produced nothing. */
export const archivable = (agent: AgentSummary): boolean => agent.archivedAt === undefined && (agent.status === "landed" || agent.status === "idle");

// Aged out of the board, per the sandbox's retention setting. Kept separate from `archivable` so the manual
// "Clear finished" button can archive on demand while the sweep waits, same safety guards, different clock.
export const archivableByAge = (agent: AgentSummary, now: number, retentionMs: number): boolean =>
    retentionMs > 0 && archivable(agent) && now - agent.updatedAt >= retentionMs;

export interface AgentArchiveDeps {
    readonly agents: AgentsRegistry;
    readonly agentWorktrees: AgentWorktrees;
    readonly logger: Logger;
    // The hard stop for everything a filed-away conversation still runs, its terminals, browsers, processes
    // (platform/reaper.ts). Archiving already committed whatever the worktree held, so nothing a shell was
    // mid-writing is owed a grace window; attached viewers included, because the user just closed the card.
    readonly reaper?: Pick<ResourceReaper, "reapConversation">;
    readonly purgeConversationState?: (removed: readonly PersistedAgent[], retained: readonly PersistedAgent[]) => Promise<void>;
}

// How many agents are torn down at once, by the archive's retire, and by the purge's outright removal. Each
// one spawns a handful of short-lived git processes per repo, so this is a throttle on process pressure, not
// on the lock: "Clear" on a full lane must not fork a hundred `git status` at once, and past a small number
// the per-repo worktree-admin lock (worktrees.retire pass 2 / worktrees.remove) is the real ceiling anyway.
const TEARDOWN_CONCURRENCY = 4;

// Run `worker` over [0, count) with at most TEARDOWN_CONCURRENCY in flight, off a shared cursor rather than
// fixed chunks: a slow agent (a big checkout) holds up only its own worker.
const pooled = async (count: number, worker: (index: number) => Promise<void>): Promise<void> => {
    let cursor = 0;
    await Promise.all(
        Array.from({ length: Math.min(TEARDOWN_CONCURRENCY, count) }, async () => {
            for (let index = cursor++; index < count; index = cursor++) {
                await worker(index);
            }
        }),
    );
};

// Retire the checkouts, then stamp the marker, in that order, so a failure mid-way leaves an agent that is
// still ON the board with its worktree intact rather than one the board has forgotten but the disk has not.
// An agent whose retire throws takes only itself out of the batch; the rest still archive.
//
// The retires overlap: "Clear" on a lane of ten is ten independent teardowns that share nothing but the repo
// locks their removal pass takes, and running them one after another made the wait scale with the size of the
// lane. The marker is still ONE write at the end, one persist, one roster broadcast, one repaint.
export const archiveAgents = async (deps: AgentArchiveDeps, ids: readonly string[], now: number): Promise<string[]> => {
    const pending = ids.filter((id) => deps.agents.entry(id) !== undefined);
    // Written by slot, not pushed: the workers finish out of order, and the caller's undo reads better when the
    // result still lists what the user picked in the order they picked it.
    const done: (string | undefined)[] = Array.from({ length: pending.length });
    const retire = async (index: number): Promise<void> => {
        const id = pending[index];
        const entry = id === undefined ? undefined : deps.agents.entry(id);
        if (id === undefined || entry === undefined) {
            return;
        }
        // A workspace conversation has no checkout or ref to retire. Archiving it is purely the registry
        // presentation change below, while its transcript and counters remain exactly like an isolated one's.
        if (entry.branch === undefined) {
            done[index] = id;
            return;
        }
        try {
            await deps.agentWorktrees.retire(id, entry.repos, entry.title);
            done[index] = id;
        } catch (error) {
            deps.logger.warn({ err: error, id }, "agents: archive skipped — worktree retire failed");
        }
    };
    await pooled(pending.length, retire);
    const archived = done.filter((id) => id !== undefined);
    if (archived.length > 0) {
        await deps.agents.setArchived(archived, now);
        // The marker is down; whatever the conversation still runs goes with it. After the registry write on
        // purpose, an archive that half-fails must not have killed the shells of agents still on the board.
        for (const id of archived) {
            await deps.reaper?.reapConversation(id, { force: true });
        }
    }
    return archived;
};

/* EMPTY THE ARCHIVE, `discard` applied to everything already filed away, and the fleet's only irreversible
 * bulk action. Where archiving reclaims the checkout and keeps the branch, this drops the branch too (and the
 * conversation dir with it, see worktrees.remove), so the work an agent never landed goes with it.
 *
 * Scoped to the ARCHIVE and nothing else: the archive is the pile of agents the user has already decided are
 * over, which is what makes one confirmation for the whole pile honest. A running agent cannot be in it (a turn
 * un-archives its own agent, registry.begin), but the guard stays because the cost of being wrong here is a
 * live turn's worktree pulled out from under it.
 *
 * An agent whose teardown throws takes only itself out of the batch, exactly as in archiveAgents: the rest are
 * deleted and the caller is told what actually went, so a repo that is momentarily locked leaves one row in the
 * archive rather than failing the press. The registry write is ONE persist and one broadcast at the end. */
export const purgeArchived = async (deps: AgentArchiveDeps): Promise<string[]> => {
    const targets = deps.agents
        .ids()
        .map((id) => deps.agents.entry(id))
        .filter((entry) => entry !== undefined)
        .filter((entry) => entry.archivedAt !== undefined && !deps.agents.running(entry.id));
    const done: (string | undefined)[] = Array.from({ length: targets.length });
    await pooled(targets.length, async (index) => {
        const entry = targets[index];
        if (entry === undefined) {
            return;
        }
        if (entry.branch === undefined) {
            done[index] = entry.id;
            return;
        }
        try {
            await deps.agentWorktrees.remove(entry.id, entry.repos);
            done[index] = entry.id;
        } catch (error) {
            deps.logger.warn({ err: error, id: entry.id }, "agents: purge skipped — worktree removal failed");
        }
    });
    const removed = done.filter((id) => id !== undefined);
    if (removed.length > 0) {
        const removedSet = new Set(removed);
        const removedEntries = targets.filter((entry) => removedSet.has(entry.id));
        const retainedEntries = deps.agents
            .ids()
            .filter((id) => !removedSet.has(id))
            .map((id) => deps.agents.entry(id))
            .filter((entry) => entry !== undefined);
        await deps
            .purgeConversationState?.(removedEntries, retainedEntries)
            .catch((error: unknown) => deps.logger.warn({ err: error, count: removed.length }, "agents: purge left some conversation state behind"));
        await deps.agents.remove(removed);
        deps.logger.info({ count: removed.length }, "agents: purged archived agents");
    }
    return removed;
};

// The unattended pass: archive every agent that has sat finished longer than the retention window. Runs at
// boot and on an interval, `updatedAt` is the clock, so an agent the user keeps talking to never ages out.
export const sweepAgedAgents = async (deps: AgentArchiveDeps, now: number, retentionMs: number): Promise<string[]> => {
    const aged = deps.agents
        .list()
        .filter((agent) => archivableByAge(agent, now, retentionMs))
        .map((agent) => agent.id);
    if (aged.length === 0) {
        return [];
    }
    const archived = await archiveAgents(deps, aged, now);
    deps.logger.info({ count: archived.length }, "agents: archived aged-out agents");
    return archived;
};
