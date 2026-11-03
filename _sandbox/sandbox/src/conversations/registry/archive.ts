import { errorMessage } from "@intentic/base/errors";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { parentOfActor } from "../../auth/principal.js";
import type { Logger } from "pino";
import type { Family, FamilyDeps } from "../../agent/subagents/children.js";
import type { FamilyEnd } from "../../agent/subagents/family-cancel.js";
import type { TurnEngine } from "../../seams/turn-engine.js";
import type { TurnStarter } from "../../seams/turn-starter.js";
import type { ResourceReaper } from "../../system/boot/reaper.js";
import type { ConversationActors } from "../actor/conversation-actors.js";
import { isBooked } from "../actor/conversation-queue.js";
import type { AgentsRegistry } from "./agents-registry.js";
import { type IsolatedAgent, isIsolated, type PersistedAgent } from "./agents-store.js";
import { type PruneOptions, type PruneScope, pruneBuildOutputs, removeQuietly } from "../worktrees/build-outputs/build-outputs.js";
import { releaseWarmLayers } from "../worktrees/cargo-warm.js";
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
// it has sat idle; a person pressing Clear decides for themselves. A home conversation is never finished: it is the one
// chat its owner keeps coming back to (conversations/home/home-conversation.ts).
export const archivableByAge = (agent: AgentSummary, now: number, retentionMs: number): boolean =>
    retentionMs > 0 && agent.home !== true && archivable(agent) && agent.unsentAt === undefined && now - agent.updatedAt >= retentionMs;

export interface AgentArchiveDeps {
    readonly agents: AgentsRegistry;
    // What a purge disposes through, the one way a conversation's in-memory state and entry leave together; and where
    // the children of a conversation leaving are read and stopped.
    readonly conversations: Pick<ConversationActors, "running" | "dispose" | "holdings" | "state" | "send" | "queued">;
    readonly agentWorktrees: AgentWorktrees;
    readonly logger: Logger;
    // Hard stop for everything the conversation still runs (terminals, viewers); archiving already committed its work,
    // so nothing is owed a grace window.
    readonly reaper?: Pick<ResourceReaper, "reapConversation">;
    readonly purgeConversationState?: (removed: readonly PersistedAgent[], retained: readonly PersistedAgent[]) => Promise<void>;
    // What stops the children a conversation leaving spawned, their running turns and booked re-runs (children.ts
    // cancelFamily). A suite that spawns nothing leaves it out.
    readonly turns?: Pick<TurnStarter, "stop">;
    // What ends the children and watches of a conversation leaving; a suite that arms and spawns nothing leaves it out.
    readonly turnEngine?: Pick<TurnEngine, "familyOf" | "cancelFamily" | "cancelWatchersFor">;
}

// The deps a family's end runs on, where these can stop a turn.
const familyDeps = (deps: AgentArchiveDeps): FamilyDeps | undefined =>
    deps.turns === undefined ? undefined : { agents: deps.agents, conversations: deps.conversations, turns: deps.turns, logger: deps.logger };

// Read while the heads are still on the board, since a dispose takes the records of the children they supervise.
const familyBelow = (deps: AgentArchiveDeps, heads: readonly string[]): Family | undefined => {
    const family = familyDeps(deps);
    return family === undefined ? undefined : deps.turnEngine?.familyOf(family, heads);
};

// Cancels what the family below them still runs or has booked; their conversations stay.
const endFamily = async (deps: AgentArchiveDeps, family: Family | undefined, why: FamilyEnd): Promise<void> => {
    const door = familyDeps(deps);
    if (door !== undefined && family !== undefined) {
        await deps.turnEngine?.cancelFamily(door, family, why);
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

// Drops every message booked for later in the conversation, each as it reads now; what waits unbooked (held by a stop or
// a refusal) stays, since it goes only when somebody presses for it.
const cancelBookings = (deps: AgentArchiveDeps, id: string): void => {
    const booked = deps.conversations.queued(id).items.filter(isBooked);
    for (const item of booked) {
        deps.conversations.send(id, { kind: "queue-removed", id: item.id, revision: item.revision });
    }
    if (booked.length > 0) {
        deps.logger.info({ id, messages: booked.length }, "agents: archived with messages scheduled in it, which were cancelled");
    }
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
        // A message booked for later would go out by itself at its time, into a conversation it would find archived
        // and be refused there. Filing the conversation away says it is done with, so its bookings are cancelled, before
        // the checkout goes, so none fires into a checkout being retired. The aged sweep never reaches one (archivable).
        cancelBookings(deps, id);
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
            await deps.turnEngine?.cancelWatchersFor(id);
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
// flag raised, no land that broke, nothing carrying it on by itself (`next`), no watch armed, no message unsent). Left behind, it would stand
// alone on the board once its parent is gone, an error card in Attention days after the work it belonged to landed.
// The board reads the same line (agentStatus.heardByParent) to keep such a child from calling the reader.
export const goesWithParent = (child: AgentSummary, parent: AgentSummary): boolean =>
    child.archivedAt === undefined &&
    SETTLED_CHILD.has(child.status) &&
    child.updatedAt < parent.updatedAt &&
    !Object.values(child.attention).some((flag) => flag === true) &&
    child.landFailure === undefined &&
    child.next === undefined &&
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

// Held work stays on the board. Review and land read the parked refs without a checkout, and ensure unparks them
// and brings the working copy back on the next turn. Watches, queued words and unsent drafts still need their working copy.
export const heldCheckoutByAge = (agent: AgentSummary, now: number, retentionMs: number): boolean =>
    retentionMs > 0 &&
    agent.archivedAt === undefined &&
    ["ready", "error", "interrupted", "conflict"].includes(agent.status) &&
    (agent.watches ?? []).length === 0 &&
    (agent.queue?.items.length ?? 0) === 0 &&
    agent.unsentAt === undefined &&
    now - agent.updatedAt >= retentionMs;

// WHAT STILL WORKS IN A HELD CHECKOUT, which the reclaim must not pull the working copy out from under (2026-10-18). The
// card being quiet says nothing of what it left running: a background command kept for the person (a dev server, a
// preview) runs from that checkout, a child it spawned may still run, be paused on a wall or wait on a card, and lands
// into it when it ends, and a re-run booked for the conversation itself opens a turn in it. Any of these leaves the
// checkout for a later sweep; nothing is stopped for the disk's sake.
export const stillWorking = (deps: AgentArchiveDeps, runningJobs: RunningJobs, id: string): string | undefined => {
    if (runningJobs(id) > 0) {
        return "a background command still runs in it";
    }
    const booked = deps.conversations.state(id)?.resume.held;
    if (booked !== undefined && !booked.fired) {
        return "a re-run is booked for it";
    }
    const family = familyBelow(deps, [id]);
    const live = family?.members.find(({ child }) => {
        const kid = family.records.get(child);
        if (kid !== undefined && (kid.running || kid.held !== undefined || kid.paused !== undefined || kid.pending !== undefined)) {
            return true;
        }
        const held = deps.conversations.state(child)?.resume.held;
        return deps.conversations.running(child) || (held !== undefined && !held.fired);
    });
    return live === undefined ? undefined : `its child ${live.child} still has work under way`;
};

// How many of a conversation's background commands still run (agent/tools/jobs `runningJobsOf`), handed in by the
// composition: the registry does not reach into the agent's tools.
export type RunningJobs = (conversationId: string) => number;

export const sweepHeldCheckouts = async (deps: AgentArchiveDeps, now: number, retentionMs: number, runningJobs: RunningJobs): Promise<string[]> => {
    const reclaimed: string[] = [];
    for (const agent of deps.agents.list()) {
        if (!heldCheckoutByAge(agent, now, retentionMs) || deps.conversations.running(agent.id)) {
            continue;
        }
        const entry = deps.agents.entry(agent.id);
        if (entry === undefined || !isIsolated(entry) || (await deps.agentWorktrees.presence(agent.id)) !== "present") {
            continue;
        }
        // Earlier reclaims and the disk probe yield: somebody may have used this card since the pass began.
        const current = deps.agents.list().find((card) => card.id === agent.id);
        if (current === undefined || !heldCheckoutByAge(current, now, retentionMs) || deps.conversations.running(agent.id)) {
            continue;
        }
        const working = stillWorking(deps, runningJobs, agent.id);
        if (working !== undefined) {
            deps.logger.info({ id: agent.id, why: working }, "agents: held checkout kept for now: work still runs in it");
            continue;
        }
        try {
            await retireCheckout(deps, entry);
            reclaimed.push(agent.id);
            deps.logger.info({ id: agent.id }, "agents: reclaimed held conversation checkout and overlay; work kept on branch");
        } catch (error) {
            deps.logger.warn({ err: error, id: agent.id }, "agents: held checkout reclaim failed, left for the next sweep");
        }
    }
    return reclaimed;
};

// Nothing of its own runs now; what is left (an idle terminal, a viewer, a stray process) goes before its directory
// does. Not forced: a terminal a person is attached to right now stays theirs.
const retireCheckout = async (deps: AgentArchiveDeps, entry: IsolatedAgent): Promise<void> => {
    await deps.reaper?.reapConversation(entry.id);
    await deps.agentWorktrees.retire(entry.id, entry.placement.repos, entry.social.title?.text);
};

// A per-conversation press the conversation's state refuses; the route answers it as a conflict, with the reason.
export class CheckoutBusy extends Error {}

// FREEING ONE CHECKOUT ON A PERSON'S PRESS (2026-11-03). The held-checkout reclaim above, for any settled conversation
// and at any age: the Storage card's per-conversation row. Watches, queued words and unsent drafts still need the working
// copy, as for the reclaim; an archived conversation whose checkout outlived its archive may always go.
export const checkoutReleaseRefusal = (deps: AgentArchiveDeps, runningJobs: RunningJobs, id: string): string | undefined => {
    const agent = deps.agents.list().find((card) => card.id === id);
    const entry = deps.agents.entry(id);
    if (agent === undefined || entry === undefined) {
        return "no conversation by that id";
    }
    if (!isIsolated(entry)) {
        return "the conversation works in the main tree, not a checkout of its own";
    }
    if (deps.conversations.running(id) || (agent.archivedAt === undefined && !SETTLED.has(agent.status))) {
        return "a turn is under way in it";
    }
    if (agent.archivedAt === undefined && ((agent.watches ?? []).length > 0 || (agent.queue?.items.length ?? 0) > 0 || agent.unsentAt !== undefined)) {
        return "it waits on a watch, a queued message or an unsent draft, which need its checkout";
    }
    return stillWorking(deps, runningJobs, id);
};

export const releaseCheckout = async (deps: AgentArchiveDeps, runningJobs: RunningJobs, id: string): Promise<void> => {
    const refusal = checkoutReleaseRefusal(deps, runningJobs, id);
    const entry = deps.agents.entry(id);
    if (refusal !== undefined || entry === undefined || !isIsolated(entry)) {
        throw new CheckoutBusy(refusal ?? "the conversation has no checkout of its own");
    }
    if ((await deps.agentWorktrees.presence(id)) !== "present") {
        return;
    }
    await retireCheckout(deps, entry);
    deps.logger.info({ id }, "agents: freed a conversation checkout and overlay on request; work kept on branch");
};

// A checkout's build output goes once its card has been settled this long (worktrees/build-outputs/build-outputs.ts says what and
// why). Long enough that a follow-up the same working session still finds its warm build; short of the days a quiet
// card then waits for its archive or reclaim, which is where the disk went.
export const BUILD_OUTPUT_QUIET_MS = 6 * 60 * 60 * 1000;
// A landed card's work is on main: its own build is only wanted again if the owner sends it more, so it goes sooner.
export const LANDED_BUILD_OUTPUT_QUIET_MS = 60 * 60 * 1000;

// PER CHECKOUT, NOT PER SANDBOX (2026-11-03). The pass used to wait for a moment no turn ran anywhere; shinobi's twenty
// conversations kept one running 67% of the time with no quiet gap over 39 minutes, so it never ran, and 51 checkouts
// grew 424 GiB of Rust targets until the disk was full. A checkout is now judged on its own conversation alone: a live
// turn, a background command or a child at work in it keeps it, and every other settled checkout is swept, at low IO
// priority and paced (pruneBuildOutputs), so a running turn elsewhere is not starved by it.

// Settled: nothing in flight reads or writes the checkout. Landing reads it; a resume or a stop is about to.
const SETTLED: ReadonlySet<AgentSummary["status"]> = new Set(["idle", "stopped", "ready", "landed", "conflict", "error", "interrupted"]);

// Cargo's incremental caches, half of a Rust target, go sooner than the rest (build-outputs.ts INCREMENTAL FIRST).
export const INCREMENTAL_QUIET_MS = 60 * 60 * 1000;

export interface BuildOutputQuiet {
    readonly quietMs: number;
    readonly landedQuietMs: number;
    // Settled this long, only the incremental caches go; absent, nothing goes before `quietMs`.
    readonly incrementalQuietMs?: number;
}

export const NORMAL_QUIET: BuildOutputQuiet = {
    quietMs: BUILD_OUTPUT_QUIET_MS,
    landedQuietMs: LANDED_BUILD_OUTPUT_QUIET_MS,
    incrementalQuietMs: INCREMENTAL_QUIET_MS,
};
// Under disk pressure or a person's press, every settled checkout qualifies; the order decides which goes first.
export const NO_QUIET: BuildOutputQuiet = { quietMs: 0, landedQuietMs: 0 };

// The sweep's clock as the settings set it (`buildOutputIdleHours`); a landed card's and the incremental caches' hour
// stays an hour, unless the owner asked for less than that for everything.
export const quietOfSettings = (idleHours: number): BuildOutputQuiet => {
    const quietMs = idleHours * 60 * 60 * 1000;
    return {
        quietMs,
        landedQuietMs: Math.min(LANDED_BUILD_OUTPUT_QUIET_MS, quietMs),
        incrementalQuietMs: Math.min(INCREMENTAL_QUIET_MS, quietMs),
    };
};

// Settled, and waiting on nothing that would use the checkout's build again: the clock may run.
const sweepable = (agent: AgentSummary): boolean =>
    agent.archivedAt === undefined &&
    SETTLED.has(agent.status) &&
    (agent.watches ?? []).length === 0 &&
    (agent.queue?.items.length ?? 0) === 0 &&
    agent.unsentAt === undefined;

// How much of a checkout's build output is due now: all of it, only the incremental caches, or none.
export const buildOutputsDue = (agent: AgentSummary, now: number, quiet: BuildOutputQuiet = NORMAL_QUIET): PruneScope | undefined => {
    if (!sweepable(agent)) {
        return undefined;
    }
    const idle = now - agent.updatedAt;
    if (idle >= (agent.status === "landed" ? quiet.landedQuietMs : quiet.quietMs)) {
        return "all";
    }
    return quiet.incrementalQuietMs !== undefined && idle >= quiet.incrementalQuietMs ? "incremental" : undefined;
};

export const buildOutputsQuiet = (agent: AgentSummary, now: number, quiet: BuildOutputQuiet = NORMAL_QUIET): boolean =>
    buildOutputsDue(agent, now, quiet) === "all";

// Which goes first when not every checkout need go: landed work before work still to be landed, then the card that has
// sat idle longest.
export const reapOrder = (left: AgentSummary, right: AgentSummary): number =>
    Number(right.status === "landed") - Number(left.status === "landed") || left.updatedAt - right.updatedAt;

// Which card was last pruned at which `updatedAt`, and how far, so a quiet checkout is walked once per scope, not every
// hour; any activity moves `updatedAt` and earns it a fresh look. Lost with the daemon, which costs one walk per quiet
// checkout a boot.
export type PrunedAt = Map<string, { readonly updatedAt: number; readonly scope: PruneScope }>;

// Whether an earlier pass already did what this one would: at the same `updatedAt`, all of it, or the same scope.
const alreadyPruned = (prunedAt: PrunedAt, agent: AgentSummary, scope: PruneScope): boolean => {
    const earlier = prunedAt.get(agent.id);
    return earlier !== undefined && earlier.updatedAt === agent.updatedAt && (earlier.scope === "all" || earlier.scope === scope);
};

export interface BuildOutputSweep {
    readonly now: number;
    readonly quiet: BuildOutputQuiet;
    readonly runningJobs: RunningJobs;
    readonly prunedAt: PrunedAt;
    // Between folders: the IO of a big sweep spread out rather than taken in one burst.
    readonly paceMs?: number;
    // Asked after each checkout: true ends the pass (the disk has room again).
    readonly enough?: () => Promise<boolean>;
    readonly remove?: (path: string) => Promise<void>;
    // A conversation's overlays dir (isolation.ts overlaysDir), where a shared Cargo target's layers keep what its
    // builds wrote (cargo-warm.ts); absent, only the checkout itself is swept.
    readonly overlaysOf?: (id: string) => string;
}

export interface SweptCheckout {
    readonly id: string;
    readonly removed: readonly string[];
}

// The one checkout's pass: undefined when it is not this pass's to sweep.
const sweepOne = async (deps: AgentArchiveDeps, agent: AgentSummary, pass: BuildOutputSweep, scope: PruneScope): Promise<SweptCheckout | undefined> => {
    if (alreadyPruned(pass.prunedAt, agent, scope) || deps.conversations.running(agent.id)) {
        return undefined;
    }
    const entry = deps.agents.entry(agent.id);
    if (entry === undefined || !isIsolated(entry) || (await deps.agentWorktrees.presence(agent.id)) !== "present") {
        return undefined;
    }
    // A kept dev server or a child still at work may be running the very build output this would take.
    if (stillWorking(deps, pass.runningJobs, agent.id) !== undefined) {
        return undefined;
    }
    const removed: string[] = [];
    let unfinished = false;
    // A big `target/` takes a while to remove; a turn that opened meanwhile keeps whatever is left.
    const proceed = (): boolean => !deps.conversations.running(agent.id);
    const options: PruneOptions = { scope, proceed, paceMs: pass.paceMs ?? 0, remove: pass.remove ?? removeQuietly };
    for (const { repo } of entry.placement.repos) {
        const result = await pruneBuildOutputs(deps.agentWorktrees.worktreeDir(agent.id, repo), options);
        removed.push(...result.removed.map((path) => (repo === "root" ? path : `${repo}/${path}`)));
        unfinished ||= result.failed.length > 0 || result.skipped.length > 0;
    }
    if (pass.overlaysOf !== undefined) {
        const warm = await releaseWarmLayers(pass.overlaysOf(agent.id), { scope, proceed, remove: pass.remove ?? removeQuietly });
        removed.push(...warm.removed);
        unfinished ||= warm.failed.length > 0 || warm.skipped.length > 0;
    }
    if (!unfinished) {
        pass.prunedAt.set(agent.id, { updatedAt: agent.updatedAt, scope });
    }
    if (removed.length > 0) {
        deps.logger.info({ id: agent.id, removed }, "agents: removed build output from a settled checkout; the next build regenerates it");
    }
    return { id: agent.id, removed };
};

// Whether a checkout's build output may go right now, whatever its age: the question a person's Clean press and the
// Storage scan's "what a clean would free" ask of each conversation.
export const buildOutputsReapable = (deps: AgentArchiveDeps, runningJobs: RunningJobs, agent: AgentSummary, now: number): boolean => {
    const entry = deps.agents.entry(agent.id);
    return (
        buildOutputsQuiet(agent, now, NO_QUIET) &&
        !deps.conversations.running(agent.id) &&
        entry !== undefined &&
        isIsolated(entry) &&
        stillWorking(deps, runningJobs, agent.id) === undefined
    );
};

export const sweepBuildOutputs = async (deps: AgentArchiveDeps, pass: BuildOutputSweep): Promise<SweptCheckout[]> => {
    const swept: SweptCheckout[] = [];
    const due = deps.agents
        .list()
        .flatMap((agent) => {
            const scope = buildOutputsDue(agent, pass.now, pass.quiet);
            return scope === undefined ? [] : [{ agent, scope }];
        })
        .toSorted((left, right) => reapOrder(left.agent, right.agent));
    for (const { agent, scope } of due) {
        if (pass.enough !== undefined && (await pass.enough())) {
            break;
        }
        const one = await sweepOne(deps, agent, pass, scope);
        if (one !== undefined && one.removed.length > 0) {
            swept.push(one);
        }
    }
    return swept;
};

// One conversation's build output on a person's press, whatever its age (the Storage card's per-conversation row).
export const reapOneBuildOutput = async (
    deps: AgentArchiveDeps,
    runningJobs: RunningJobs,
    id: string,
    remove: (path: string) => Promise<void> = removeQuietly,
    overlaysOf?: (id: string) => string,
): Promise<SweptCheckout> => {
    const agent = deps.agents.list().find((card) => card.id === id);
    if (agent === undefined || !buildOutputsReapable(deps, runningJobs, agent, Date.now())) {
        throw new CheckoutBusy("something still runs in the conversation, or it waits on work that would build again");
    }
    const pass: BuildOutputSweep = { now: Date.now(), quiet: NO_QUIET, runningJobs, prunedAt: new Map(), remove, ...(overlaysOf === undefined ? {} : { overlaysOf }) };
    const one = await sweepOne(deps, agent, pass, "all");
    return one ?? { id, removed: [] };
};
