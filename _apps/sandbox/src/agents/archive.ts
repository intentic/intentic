import type { Logger } from "pino";
import type { AgentsRegistry } from "./agents-registry.js";
import type { PersistedAgent } from "./agents-store.js";
import type { AgentWorktrees } from "./worktrees.js";

// ARCHIVING — the board's only exit that isn't a deletion.
//
// The Finished lane is the fleet's one terminal state: nothing transitions out of `landed`/`idle`, so without
// this every agent that ever ran stays on the board forever. And a finished card is not a row — it holds a git
// worktree, one full checkout PER REPO, for as long as the entry lives. So the lane growing without bound is a
// disk footprint growing without bound, and any fix that only hid old cards would turn a visible cost into an
// invisible one.
//
// What archiving costs the user is therefore exactly nothing, and that is the point — it is what lets the
// sweep below run unattended and the UI ask no confirmation:
//   · whatever the worktree still held is COMMITTED onto agent/<id> first (worktrees.retire)
//   · the branch, the registry entry, every counter, and the transcript all stay
//   · only the CHECKOUT is reclaimed — the one part that is pure cache, restorable from the branch
// A follow-up message re-attaches the checkout and clears the marker (registry.begin), the review still reads
// from the two refs (agents.routes diff/fileDiff), and `unarchive` puts the card back on the board untouched.
//
// Contrast `discard`, which is the destructive one: it drops the branch too, and with it the only record of
// work that never landed.

// Is this entry safe to archive UNATTENDED? The guards are about not stranding the user, not about disk:
//   · running — the worktree is the live turn's working state (the same guard land/discard take)
//   · conflict/error — the card is in the Attention lane asking for something; archiving it would hide a
//     question rather than answer it
//   · attention flags aren't checked here because they are runtime-only state on a RUNNING turn, which the
//     first guard already excludes
// `idle` with nothing landed is the most archivable case there is: a throwaway agent that produced nothing.
export const archivable = (entry: PersistedAgent, running: boolean): boolean =>
    !running && entry.archivedAt === undefined && (entry.status === "landed" || entry.status === "idle");

// Aged out of the board, per the sandbox's retention setting. Kept separate from `archivable` so the manual
// "Clear finished" button can archive on demand while the sweep waits — same safety guards, different clock.
export const archivableByAge = (entry: PersistedAgent, running: boolean, now: number, retentionMs: number): boolean =>
    retentionMs > 0 && archivable(entry, running) && now - entry.updatedAt >= retentionMs;

export interface AgentArchiveDeps {
    readonly agents: AgentsRegistry;
    readonly agentWorktrees: AgentWorktrees;
    readonly logger: Logger;
}

// How many agents retire at once. Each one spawns a handful of short-lived git processes per repo, so this is
// a throttle on process pressure, not on the lock: "Clear" on a full lane must not fork a hundred `git status`
// at once, and past a small number the per-repo worktree-admin lock (worktrees.retire pass 2) is the real
// ceiling anyway.
const RETIRE_CONCURRENCY = 4;

// Retire the checkouts, then stamp the marker — in that order, so a failure mid-way leaves an agent that is
// still ON the board with its worktree intact rather than one the board has forgotten but the disk has not.
// An agent whose retire throws takes only itself out of the batch; the rest still archive.
//
// The retires overlap: "Clear" on a lane of ten is ten independent teardowns that share nothing but the repo
// locks their removal pass takes, and running them one after another made the wait scale with the size of the
// lane. The marker is still ONE write at the end — one persist, one roster broadcast, one repaint.
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
        try {
            await deps.agentWorktrees.retire(id, entry.repos, entry.title);
            done[index] = id;
        } catch (error) {
            deps.logger.warn({ err: error, id }, "agents: archive skipped — worktree retire failed");
        }
    };
    // A shared cursor rather than fixed chunks: a slow agent (a big checkout) holds up only its own worker.
    let cursor = 0;
    await Promise.all(
        Array.from({ length: Math.min(RETIRE_CONCURRENCY, pending.length) }, async () => {
            for (let index = cursor++; index < pending.length; index = cursor++) {
                await retire(index);
            }
        }),
    );
    const archived = done.filter((id) => id !== undefined);
    if (archived.length > 0) {
        await deps.agents.setArchived(archived, now);
    }
    return archived;
};

// The unattended pass: archive every agent that has sat finished longer than the retention window. Runs at
// boot and on an interval — `updatedAt` is the clock, so an agent the user keeps talking to never ages out.
export const sweepAgedAgents = async (deps: AgentArchiveDeps, now: number, retentionMs: number): Promise<string[]> => {
    const aged = deps.agents
        .ids()
        .map((id) => deps.agents.entry(id))
        .filter((entry) => entry !== undefined)
        .filter((entry) => archivableByAge(entry, deps.agents.running(entry.id), now, retentionMs))
        .map((entry) => entry.id);
    if (aged.length === 0) {
        return [];
    }
    const archived = await archiveAgents(deps, aged, now);
    deps.logger.info({ count: archived.length }, "agents: archived aged-out agents");
    return archived;
};
