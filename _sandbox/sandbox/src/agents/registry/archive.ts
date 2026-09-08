import { errorMessage } from "@intentic/base/errors";
import type { AgentSummary } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ResourceReaper } from "../../platform/boot/reaper.js";
import type { AgentsRegistry } from "./agents-registry.js";
import type { PersistedAgent } from "./agents-store.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// The board's only non-destructive exit: the Finished lane never transitions out on its own, and each finished card
// holds a full worktree checkout, so this reclaims that disk. The worktree is committed onto `agent/<id>` first; only
// the checkout is reclaimed, and the branch parks off refs/heads/ rather than being dropped, unlike `discard`.

// Safe to archive unattended, reading the roster status rather than the persisted entry, since `conflict`/`ready` are
// derived per roster and invisible there:
// - running/awaiting: the worktree is live, or a question is pending
// - conflict: still asking for something in Attention
// - ready: held work nobody has landed yet
// - error/interrupted: a failure or a daemon death nobody has seen
export const archivable = (agent: AgentSummary): boolean => agent.archivedAt === undefined && (agent.status === "landed" || agent.status === "idle");

// Aged out per the retention setting; kept separate from `archivable` so the manual Clear button can act immediately
// while the sweep waits, same guards, different clock.
export const archivableByAge = (agent: AgentSummary, now: number, retentionMs: number): boolean =>
    retentionMs > 0 && archivable(agent) && now - agent.updatedAt >= retentionMs;

export interface AgentArchiveDeps {
    readonly agents: AgentsRegistry;
    readonly agentWorktrees: AgentWorktrees;
    readonly logger: Logger;
    // Hard stop for everything the conversation still runs (terminals, viewers); archiving already committed its work,
    // so nothing is owed a grace window.
    readonly reaper?: Pick<ResourceReaper, "reapConversation">;
    readonly purgeConversationState?: (removed: readonly PersistedAgent[], retained: readonly PersistedAgent[]) => Promise<void>;
}

// Throttle on process pressure, not on the lock; past a small number the per-repo worktree lock is the real ceiling
// anyway.
const TEARDOWN_CONCURRENCY = 4;

// Runs `worker` over `[0, count)` with at most `TEARDOWN_CONCURRENCY` in flight, off a shared cursor rather than fixed
// chunks, so one slow agent only holds up its own slot.
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

// What an archive did, and what it could not: failures are reported here rather than only logged, since a silent drop
// reads to the board as `nothing to archive` when a card plainly refused.
export interface AgentArchiveResult {
    // In the order the caller named them, so an undo lists what the user picked.
    readonly archived: string[];
    readonly failed: { readonly id: string; readonly reason: string }[];
}

// The teardown's own failure sentence, for the board's strip; trimmed to one line, since git's stderr is a paragraph
// and the strip is not.
const reasonOf = (error: unknown): string => {
    const text = errorMessage(error);
    return (
        text
            .split(`\n`)
            .find((line) => line.trim() !== ``)
            ?.trim() ?? `the checkout could not be released`
    );
};

// Retires each checkout before stamping the marker, so a mid-way failure leaves the agent on the board, worktree
// intact. Retires run concurrently; the marker is still one persist and broadcast for the batch.
export const archiveAgents = async (deps: AgentArchiveDeps, ids: readonly string[], now: number): Promise<AgentArchiveResult> => {
    const pending = ids.filter((id) => deps.agents.entry(id) !== undefined);
    // Written by slot, not pushed, so out-of-order workers still leave the result in the order the caller picked.
    const done: (string | undefined)[] = Array.from({ length: pending.length });
    const refused: ({ id: string; reason: string } | undefined)[] = Array.from({ length: pending.length });
    const retire = async (index: number): Promise<void> => {
        const id = pending[index];
        const entry = id === undefined ? undefined : deps.agents.entry(id);
        if (id === undefined || entry === undefined) {
            return;
        }
        // A workspace conversation has no checkout to retire; archiving it is only the registry's presentation change.
        if (entry.branch === undefined) {
            done[index] = id;
            return;
        }
        try {
            await deps.agentWorktrees.retire(id, entry.repos, entry.title);
            done[index] = id;
        } catch (error) {
            deps.logger.warn({ err: error, id }, "agents: archive skipped, worktree retire failed");
            refused[index] = { id, reason: reasonOf(error) };
        }
    };
    await pooled(pending.length, retire);
    const archived = done.filter((id) => id !== undefined);
    if (archived.length > 0) {
        await deps.agents.setArchived(archived, now);
        // After the registry write on purpose, so a half-failed archive can't kill shells of agents still on the board.
        for (const id of archived) {
            await deps.reaper?.reapConversation(id, { force: true });
        }
    }
    return { archived, failed: refused.filter((entry) => entry !== undefined) };
};

// Empties the archive, `discard` applied to everything filed away, the fleet's only irreversible bulk action; drops the
// branch too. Scoped to the archive alone, so one confirmation for the whole pile is honest.
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
            deps.logger.warn({ err: error, id: entry.id }, "agents: purge skipped, worktree removal failed");
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

// The unattended pass: archives everything finished longer than the retention window; `updatedAt` is the clock, so
// ongoing activity never ages out.
export const sweepAgedAgents = async (deps: AgentArchiveDeps, now: number, retentionMs: number): Promise<string[]> => {
    const aged = deps.agents
        .list()
        .filter((agent) => archivableByAge(agent, now, retentionMs))
        .map((agent) => agent.id);
    if (aged.length === 0) {
        return [];
    }
    const { archived, failed } = await archiveAgents(deps, aged, now);
    deps.logger.info({ count: archived.length, failed: failed.length }, "agents: archived aged-out agents");
    return archived;
};
