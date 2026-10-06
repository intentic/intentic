import { errorMessage } from "@intentic/base/errors";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { parentOfActor } from "../../auth/principal.js";
import type { Logger } from "pino";
import { cancelFamily, type Family, type FamilyDeps, familyOf } from "../../agent/subagents/children.js";
import type { FamilyEnd } from "../../agent/subagents/family-cancel.js";
import { cancelWatchersFor } from "../../agent/verification/watchers.js";
import type { TurnStarter } from "../../seams/turn-starter.js";
import type { ResourceReaper } from "../../system/boot/reaper.js";
import type { ConversationActors } from "../actor/conversation-actors.js";
import { isBooked } from "../actor/conversation-queue.js";
import type { AgentsRegistry } from "./agents-registry.js";
import { isIsolated, type PersistedAgent } from "./agents-store.js";
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
// - watching: an idle card parked on an armed watch is waiting for its wake, not finished
// - waiting words: a message booked for later (a time, another agent's land) or held by a stop or a refusal is work
//   still to come, which an archive would drop; a conversation a booking opened has no checkout or branch yet either,
//   which the boot's vanished-checkout pass must not read as one ended for good
export const archivable = (agent: AgentSummary): boolean =>
    agent.archivedAt === undefined &&
    (agent.status === "landed" || agent.status === "idle") &&
    (agent.watches ?? []).length === 0 &&
    (agent.queue?.items.length ?? 0) === 0;

// Aged out per the retention setting: the unattended sweep's rule, narrower than the board's Clear, which names its ids.
// A conversation somebody's composer still holds an unsent message for is waiting on them, not finished, however long
// it has sat idle; a person pressing Clear decides for themselves.
export const archivableByAge = (agent: AgentSummary, now: number, retentionMs: number): boolean =>
    retentionMs > 0 && archivable(agent) && agent.unsentAt === undefined && now - agent.updatedAt >= retentionMs;

export interface AgentArchiveDeps {
    readonly agents: AgentsRegistry;
    // What a purge disposes through, the one way a conversation's in-memory state and entry leave together; and where
    // the children of a conversation leaving are read and stopped.
    readonly conversations: Pick<ConversationActors, "running" | "dispose" | "holdings" | "state" | "send">;
    readonly agentWorktrees: AgentWorktrees;
    readonly logger: Logger;
    // Hard stop for everything the conversation still runs (terminals, viewers); archiving already committed its work,
    // so nothing is owed a grace window.
    readonly reaper?: Pick<ResourceReaper, "reapConversation">;
    readonly purgeConversationState?: (removed: readonly PersistedAgent[], retained: readonly PersistedAgent[]) => Promise<void>;
    // What stops the children a conversation leaving spawned, their running turns and booked re-runs (children.ts
    // cancelFamily). A suite that spawns nothing leaves it out.
    readonly turns?: Pick<TurnStarter, "stop">;
}

// The deps a family's end runs on, where these can stop a turn.
const familyDeps = (deps: AgentArchiveDeps): FamilyDeps | undefined =>
    deps.turns === undefined ? undefined : { agents: deps.agents, conversations: deps.conversations, turns: deps.turns, logger: deps.logger };

// Read while the heads are still on the board, since a dispose takes the records of the children they supervise.
const familyBelow = (deps: AgentArchiveDeps, heads: readonly string[]): Family | undefined => {
    const family = familyDeps(deps);
    return family === undefined ? undefined : familyOf(family, heads);
};

// Cancels what the family below them still runs or has booked; their conversations stay.
const endFamily = async (deps: AgentArchiveDeps, family: Family | undefined, why: FamilyEnd): Promise<void> => {
    const door = familyDeps(deps);
    if (door !== undefined && family !== undefined) {
        await cancelFamily(door, family, why);
    }
};

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
        // A message booked for later goes out by itself at its time, into a conversation it would find archived: the
        // person's words would be lost. It stays on the board until they send it, re-time it or take it back.
        if ((entry.queue?.items ?? []).some(isBooked)) {
            refused[index] = { id, reason: "a message is scheduled to send in it: send it now or take it back first" };
            return;
        }
        // A workspace conversation has no checkout to retire; archiving it is only the registry's presentation change.
        if (!isIsolated(entry)) {
            done[index] = id;
            return;
        }
        try {
            await deps.agentWorktrees.retire(id, entry.placement.repos, entry.social.title?.text);
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
        // A watch goes too: its checks ran in the checkout just retired.
        for (const id of archived) {
            await cancelWatchersFor(id);
            await deps.reaper?.reapConversation(id, { force: true });
        }
        // Their children stop with them, by hand, by the Clear and by the aged sweep alike: filed away first, so a child
        // stopped now tells its parent nothing and lands as any conversation does.
        await endFamily(deps, familyBelow(deps, archived), "archived");
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
        .filter((entry) => entry.archivedAt !== undefined && !deps.conversations.running(entry.id));
    const done: (string | undefined)[] = Array.from({ length: targets.length });
    await pooled(targets.length, async (index) => {
        const entry = targets[index];
        if (entry === undefined) {
            return;
        }
        if (!isIsolated(entry)) {
            done[index] = entry.id;
            return;
        }
        try {
            await deps.agentWorktrees.remove(entry.id, entry.placement.repos);
            done[index] = entry.id;
        } catch (error) {
            deps.logger.warn({ err: error, id: entry.id }, "agents: purge skipped, worktree removal failed");
        }
    });
    const removed = done.filter((id) => id !== undefined);
    if (removed.length > 0) {
        const removedSet = new Set(removed);
        // Anything their children took up again since the archive stops before the records go with the parents.
        await endFamily(deps, familyBelow(deps, removed), "purged");
        await forgetConversations(
            deps,
            targets.filter((entry) => removedSet.has(entry.id)),
        );
        deps.logger.info({ count: removed.length }, "agents: purged archived agents");
    }
    return removed;
};

// What leaves with conversations whose checkouts are already gone: what they left in layouts other owners dictate
// (session files in the shared store, uploads only they referenced), then, together, each one's actor, its rows in every
// table and its directory on the history volume (dispose).
export const forgetConversations = async (deps: AgentArchiveDeps, removed: readonly PersistedAgent[]): Promise<void> => {
    const gone = new Set(removed.map((entry) => entry.id));
    const retained = deps.agents
        .ids()
        .filter((id) => !gone.has(id))
        .map((id) => deps.agents.entry(id))
        .filter((entry) => entry !== undefined);
    await deps
        .purgeConversationState?.(removed, retained)
        .catch((error: unknown) => deps.logger.warn({ err: error, count: removed.length }, "agents: purge left some conversation state behind"));
    await deps.conversations.dispose([...gone]);
};

// How a child agent can stand and still be news its parent has had. Every settled turn of a child reaches the parent
// that started it (agent/subagents/child-report.ts), so a child that settled before its parent last moved was reported,
// and the parent's own ending is the account of it. Not `ready` or `conflict` (work not landed), nor anything still
// running or parked on an ask.
const SETTLED_CHILD: ReadonlySet<AgentSummary["status"]> = new Set(["landed", "idle", "error", "interrupted", "stopped"]);

// Whether a child goes when its parent is filed: settled before the parent last moved, and waiting on nothing (no
// flag raised, no land that broke, no re-run booked, no watch armed, no message unsent). Left behind, it would stand
// alone on the board once its parent is gone, an error card in Attention days after the work it belonged to landed.
// The board reads the same line (agentStatus.heardByParent) to keep such a child from calling the reader.
export const goesWithParent = (child: AgentSummary, parent: AgentSummary): boolean =>
    child.archivedAt === undefined &&
    SETTLED_CHILD.has(child.status) &&
    child.updatedAt < parent.updatedAt &&
    !Object.values(child.attention).some((flag) => flag === true) &&
    child.landFailure === undefined &&
    child.limitScheduled !== true &&
    (child.watches ?? []).length === 0 &&
    child.unsentAt === undefined;

// What the unattended pass files: every agent aged out on its own, and with each the children that go with it, a
// generation at a time, so a family leaves the board together as the board's own Archive takes it. A parent filed
// before is not walked again: a child somebody restored from under it was put back on purpose.
export const agedFamilies = (live: readonly AgentSummary[], now: number, retentionMs: number): string[] => {
    if (retentionMs <= 0) {
        return [];
    }
    const childrenOf = new Map<string, AgentSummary[]>();
    for (const agent of live) {
        const parent = parentOfActor(agent.startedBy);
        if (parent !== undefined) {
            childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), agent]);
        }
    }
    const filed = new Set<string>();
    const file = (parent: AgentSummary): void => {
        for (const child of childrenOf.get(parent.id) ?? []) {
            if (!filed.has(child.id) && goesWithParent(child, parent)) {
                filed.add(child.id);
                file(child);
            }
        }
    };
    for (const agent of live.filter((entry) => archivableByAge(entry, now, retentionMs))) {
        filed.add(agent.id);
        file(agent);
    }
    return [...filed];
};

// The unattended pass: archives everything finished longer than the retention window, with the children that go with
// it (agedFamilies); `updatedAt` is the clock, so ongoing activity never ages out.
export const sweepAgedAgents = async (deps: AgentArchiveDeps, now: number, retentionMs: number): Promise<string[]> => {
    const aged = agedFamilies(deps.agents.list(), now, retentionMs);
    if (aged.length === 0) {
        return [];
    }
    const { archived, failed } = await archiveAgents(deps, aged, now);
    deps.logger.info({ count: archived.length, failed: failed.length }, "agents: archived aged-out agents");
    return archived;
};
