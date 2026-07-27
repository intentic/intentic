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

// Retire the checkouts, then stamp the marker — in that order, so a failure mid-way leaves an agent that is
// still ON the board with its worktree intact rather than one the board has forgotten but the disk has not.
// A repo whose retire throws takes only its own agent out of the batch; the rest still archive.
export const archiveAgents = async (deps: AgentArchiveDeps, ids: readonly string[], now: number): Promise<string[]> => {
    const archived: string[] = [];
    for (const id of ids) {
        const entry = deps.agents.entry(id);
        if (entry === undefined) {
            continue;
        }
        try {
            await deps.agentWorktrees.retire(id, entry.repos, entry.title);
            archived.push(id);
        } catch (error) {
            deps.logger.warn({ err: error, id }, "agents: archive skipped — worktree retire failed");
        }
    }
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
