import type { AgentSummary, AutomationApproval } from "@intentic/sandbox-contract";
import { sandboxRef, sandboxScopeGuard, sandboxShallowRef, sandboxValue } from "@intentic/extension-api";
import { computed, watch } from "vue";
import { invalidateAgentTranscript } from "../../chat/transcript/agentTranscript";
import { useChat } from "../../chat/run/useChat";
import { reportClient } from "../../../app/clientDiagnostics";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { onScreen } from "../../../shell/window/onScreen";
import { AGENT_REVIEW, rpcKey, rpcKeyAt } from "../../../lib/queryKeys";
import { queryClient, UNPERSISTED } from "../../../lib/queryPersistence";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { useSandbox } from "../../sandbox/client/useSandbox";
import type { FleetAgent } from "./useAgents-fleet";

// Daemon's agent registry mirrored: the roster pushed by /events, the archived half pulled separately, ordered by
// a revision line. Bottom of the fleet store's module graph; nothing here reads a module above it. All of it belongs
// to the daemon it came from, so it is sandbox-scoped: another daemon's archive must never offer restores here.

// Shallow: writes replace the array wholesale; a deep ref would re-proxy every summary each frame.
export const registry = sandboxShallowRef<AgentSummary[]>(() => []);

// Archive half of the fleet; shallow like `registry`, and unbounded in size unlike the live roster.
export const archived = sandboxShallowRef<FleetAgent[]>(() => []);
export const archiveLoading = sandboxRef(() => false);

// Daemon's approvals queue as last read; kept separate since the stream never carries holds.
const heldRead = sandboxShallowRef<AutomationApproval[]>(() => []);

// Holds a press here released that a read may still list; each retires on the first read without it (releaseHeld).
const releasing = sandboxShallowRef<ReadonlySet<string>>(() => new Set());

// The approvals queue as the board draws it: what the daemon holds, less what a press here has already let go.
export const heldWakes = computed<AutomationApproval[]>(() =>
    releasing.value.size === 0 ? heldRead.value : heldRead.value.filter((wake) => !releasing.value.has(wake.id)),
);

// Roster snapshots come from three sources (the stream, refresh(), local archive/restore); a full-replace lets
// whichever lands last win regardless of truth. Each snapshot carries the revision it was read at:
// - a snapshot older than the one already applied is dropped
// - a local add/remove holds as a pending intent until a snapshot at or past its own revision arrives

// Highest applied revision; -1 until the first snapshot, so a fresh connection accepts revision 0.
const appliedRev = sandboxValue(() => -1);

// Tags which connection the revision counter belongs to; a reconnect bumps it so a stale late read can't reapply it.
let epoch = 0;

// Ids locally added/removed from the board, held until `untilRev` applies. `present` is the summary to restore; a
// removal carries none.
interface PendingMove {
    readonly untilRev: number;
    readonly present?: AgentSummary;
}
const pending = sandboxValue(() => new Map<string, PendingMove>());

// Applies still-pending local moves on top of a server snapshot.
const withPending = (agents: AgentSummary[]): AgentSummary[] => {
    if (pending.value.size === 0) {
        return agents;
    }
    const kept = agents.filter((agent) => !pending.value.has(agent.id));
    const restored = [...pending.value.values()].flatMap((move) => (move.present === undefined ? [] : [move.present]));
    return [...kept, ...restored];
};

// Latches `registered` from the server's own list (before pending projection), so a tab stops being a draft even
// after archiving or a dropped stream removes the roster entry.
const latchRegistered = (agents: readonly AgentSummary[]): void => {
    const known = new Set(agents.map((agent) => agent.id));
    for (const conversation of useChat().conversations.value) {
        if (known.has(conversation.conversationId)) {
            conversation.registered.value = true;
        }
    }
};

// Recompute fresh every frame; never cache the fingerprint string. In-place optimistic writes (markSeen, rename,
// ...) mutate the held entry, so a cached string would compare stale and mask a declined write.
export const snapshotFingerprint = (value: unknown): string => JSON.stringify(value);

const registryStable = sandboxValue(() => new Map<string, AgentSummary>());

const stabilizeRegistry = (incoming: readonly AgentSummary[]): AgentSummary[] => {
    const nextIds = new Set<string>();
    const stabilized = incoming.map((agent) => {
        nextIds.add(agent.id);
        const cached = registryStable.value.get(agent.id);
        if (cached !== undefined && snapshotFingerprint(cached) === snapshotFingerprint(agent)) {
            return cached;
        }
        registryStable.value.set(agent.id, agent);
        return agent;
    });
    for (const id of registryStable.value.keys()) {
        if (!nextIds.has(id)) {
            registryStable.value.delete(id);
        }
    }
    return stabilized;
};

// Element-wise identity: true when a stabilized array holds exactly the same objects as before, so the ref (and
// its readers) is left untouched. Generic since useAgents-fleet asks the same question of its card view-models.
export const sameEntries = <T>(left: readonly T[], right: readonly T[]): boolean =>
    left.length === right.length && left.every((entry, at) => entry === right[at]);

// Single writer for the held list, holding it to the rule `registry` keeps: a re-read carrying the same holds
// leaves the array alone, since identity is the only change signal its readers get.
const setHeldWakes = (held: AutomationApproval[]): void => {
    if (releasing.value.size > 0) {
        const listed = new Set(held.map((wake) => wake.id));
        const still = [...releasing.value].filter((id) => listed.has(id));
        if (still.length < releasing.value.size) {
            releasing.value = new Set(still);
        }
    }
    if (snapshotFingerprint(held) !== snapshotFingerprint(heldRead.value)) {
        heldRead.value = held;
    }
};

const unrelease = (id: string): void => {
    if (!releasing.value.has(id)) {
        return;
    }
    const rest = new Set(releasing.value);
    rest.delete(id);
    releasing.value = rest;
};

// Retires every intent the server has now absorbed, then re-projects what remains.
const applySnapshot = (agents: AgentSummary[], rev: number): void => {
    for (const [id, move] of pending.value) {
        if (rev >= move.untilRev) {
            pending.value.delete(id);
        }
    }
    latchRegistered(agents);
    const next = stabilizeRegistry(withPending(agents));
    if (sameEntries(registry.value, next)) {
        return;
    }
    registry.value = next;
};

// Records a local move and paints it immediately; held until a roster reaching `rev` (the daemon's own revision
// for the mutation) arrives, no timers or fixed windows.
export const holdPending = (moves: readonly { id: string; present?: AgentSummary }[], rev: number): void => {
    for (const move of moves) {
        pending.value.set(move.id, move.present === undefined ? { untilRev: rev } : { untilRev: rev, present: move.present });
    }
    registry.value = withPending(registry.value.filter((agent) => !pending.value.has(agent.id)));
};

// Optimistic remove: the card leaves before the daemon answers, held at +Infinity since there's no revision yet
// to retire it. Returns a rollback that restores everything except ids in `keep` (confirmed as moved).
export const takeOffBoard = (ids: readonly string[]): ((keep?: ReadonlySet<string>) => void) => {
    const held = new Map(registry.value.filter((agent) => ids.includes(agent.id)).map((agent) => [agent.id, agent]));
    holdPending(
        ids.map((id) => ({ id })),
        Number.POSITIVE_INFINITY,
    );
    return (keep) => {
        const back = [...held].filter(([id]) => keep?.has(id) !== true);
        for (const [id] of back) {
            // Only this call's own pending intent; dropping a since-reheld one would flicker an archived card back.
            if (pending.value.get(id)?.untilRev === Number.POSITIVE_INFINITY) {
                pending.value.delete(id);
            }
        }
        const returning = back.filter(([id]) => !pending.value.has(id)).map(([, agent]) => agent);
        if (returning.length > 0) {
            registry.value = withPending([...registry.value, ...returning]);
        }
    };
};

// takeOffBoard's inverse: the cards join the board before the daemon answers, held at +Infinity until its revision.
// Returns a rollback taking back all but the ids in `keep` (confirmed as moved), and only what this call put there.
export const putOnBoard = (agents: readonly AgentSummary[]): ((keep?: ReadonlySet<string>) => void) => {
    holdPending(
        agents.map((agent) => ({ id: agent.id, present: agent })),
        Number.POSITIVE_INFINITY,
    );
    return (keep) => {
        const back = new Set(agents.filter((agent) => keep?.has(agent.id) !== true).map((agent) => agent.id));
        for (const id of back) {
            // Only this call's own intent: a hold since replaced by a revision is the daemon's confirmation, not ours.
            if (pending.value.get(id)?.untilRev === Number.POSITIVE_INFINITY && pending.value.get(id)?.present !== undefined) {
                pending.value.delete(id);
            }
        }
        const leaving = [...back].filter((id) => !pending.value.has(id));
        if (leaving.length > 0) {
            registry.value = withPending(registry.value.filter((agent) => !leaving.includes(agent.id)));
        }
    };
};

// One agent's review (AGENT_REVIEW) in the box `at` names, undefined for the active one. `{ id }` partially matches every
// file diff's input; those are filed UNPERSISTED, and the mark sits before the box in the key, so it must be named.
export const agentReviewKeys = (id: string, at?: string): readonly unknown[][] =>
    AGENT_REVIEW.map((procedure) => {
        const marks = procedure === `agents.fileDiff` ? [UNPERSISTED] : [];
        return at === undefined ? rpcKey(procedure, { id }, ...marks) : rpcKeyAt(at, procedure, { id }, ...marks);
    });

// Invalidates the pull-only review on any status change, since that is the daemon settling something about the
// agent's work. An id never seen before also counts, in case its outcome landed while no stream was up.
const invalidateStaleWork = (agents: readonly AgentSummary[]): void => {
    const held = new Map(registry.value.map((agent) => [agent.id, agent.status]));
    for (const agent of agents) {
        if (held.get(agent.id) !== agent.status) {
            for (const queryKey of agentReviewKeys(agent.id)) {
                void queryClient.invalidateQueries({ queryKey });
            }
            // Same signal invalidates the transcript too: the daemon writes a turn's record only once it settles.
            invalidateAgentTranscript(agent.id);
        }
    }
};

// Applies a roster snapshot from the stream or an explicit read; dropped if it predates what's already held,
// since an out-of-order answer is a regression, not news.
export const setAgents = (agents: AgentSummary[], rev: number): void => {
    if (rev < appliedRev.value) {
        return;
    }
    invalidateStaleWork(agents);
    // Ids that left the roster by another hand than this browser's (daemon sweep, another device); local moves are
    // excluded via `pending`. Triggers an archive-list refresh and closes their chat tabs.
    const incoming = new Set(agents.map((agent) => agent.id));
    const departed = new Set(registry.value.filter((agent) => !incoming.has(agent.id) && !pending.value.has(agent.id)).map((agent) => agent.id));
    if (departed.size > 0) {
        void loadArchived();
        useChat().closeRetired(departed);
    }
    appliedRev.value = rev;
    applySnapshot(agents, rev);
    // Attaches a tab opened before its turn existed to the turn now running (workflow step, wake, another device).
    useChat().attachStarted(new Set(agents.filter((agent) => agent.status === `running`).map((agent) => agent.id)));
};

// Drops per-connection state on a mere disconnect: the revision line and pending moves, keeping the painted roster
// until the reconnect's snapshot overwrites it. A sandbox switch drops everything here with the scope.
export const desyncRegistry = (): void => {
    pending.value.clear();
    registryStable.value.clear();
    appliedRev.value = -1;
    epoch += 1;
};

// Marks an agent seen: stamps `seenAt` on the daemon's own entry optimistically, then persists; a failed write
// only means the badge returns next frame.
export const markSeen = (id: string): void => {
    const entry = registry.value.find((agent) => agent.id === id);
    if (entry === undefined) {
        return;
    }
    entry.seenAt = Date.now();
    void sandboxRpc.agents.seen({ id }).catch(() => undefined);
};

// Clears every unread badge at once, instead of requiring a click through each card.
export const markAllSeen = (): void => {
    const now = Date.now();
    for (const agent of registry.value) {
        agent.seenAt = now;
    }
    void sandboxRpc.agents.seenAll().catch(() => undefined);
};

// An open tab adopts the registry's title unconditionally: the daemon never promotes a title that would overwrite
// a rename. rename() writes the registry optimistically, so a rename lands here the same tick, not a round trip later.
const appliedTitles = new Map<string, string | undefined>();

// Detects a title change via per-entry lookup, no per-frame allocation. A shrunk roster isn't caught by lookups
// alone, so a count mismatch forces a full rebuild of the memo (also correct for a reset to empty).
const titlesMoved = (entries: readonly AgentSummary[]): boolean => {
    let moved = false;
    for (const agent of entries) {
        if (!appliedTitles.has(agent.id) || appliedTitles.get(agent.id) !== agent.title) {
            appliedTitles.set(agent.id, agent.title);
            moved = true;
        }
    }
    if (appliedTitles.size === entries.length) {
        return moved;
    }
    appliedTitles.clear();
    for (const agent of entries) {
        appliedTitles.set(agent.id, agent.title);
    }
    return true;
};

watch(registry, (entries) => {
    if (!titlesMoved(entries)) {
        return;
    }
    const { conversations } = useChat();
    for (const agent of entries) {
        const conversation = conversations.value.find((candidate) => candidate.conversationId === agent.id);
        // An entry with no title yet (turn not started) must not blank a tab that already named itself.
        if (agent.title !== undefined && conversation !== undefined && conversation.title.value !== agent.title) {
            conversation.title.value = agent.title;
        }
    }
});

// A roster snapshot can be lost silently (revision guard, a dead consumer, a hot reload), freezing the board until
// reload. The heartbeat carries the daemon's last-sent revision; any mismatch triggers one refresh() and adopts
// the daemon's line. Free when they already agree; at most one audit runs at a time.
let auditing: Promise<void> | undefined;

export const auditRoster = (rev: number): void => {
    if (rev === appliedRev.value) {
        return;
    }
    // Logged once per occurrence (deduped) so a silent repair leaves a trace in logs/client.jsonl.
    reportClient(`fleet.roster-behind`, `the roster missed a snapshot and was read back`, {
        level: `warn`,
        fields: { held: appliedRev.value, beat: rev },
    });
    if (rev < appliedRev.value) {
        appliedRev.value = -1;
    }
    auditing ??= refresh().finally(() => {
        auditing = undefined;
    });
};

// Explicit registry pull for the hello and pull-to-refresh; steady state rides /events. Exported separately since the
// hello (systemEvents) calls it, mainly to refill held wakes, which the stream never populates.
export const refreshAgents = async (): Promise<void> => refresh();

export const refresh = async (): Promise<void> => {
    const issuedAt = epoch;
    const current = sandboxScopeGuard();
    try {
        const body = await sandboxRpc.agents.list();
        // Stale: issued to a connection since replaced (`epoch`) or to another sandbox; its revision can't be trusted as
        // a high-water mark.
        if (issuedAt !== epoch || !current()) {
            return;
        }
        // Goes through setAgents, not a raw assignment, so a slow read can't undo a newer frame from the stream.
        setAgents(body.agents, body.rev);
        setHeldWakes(body.held);
    } catch {
        // Leave the last roster; the events stream repaints on reconnect.
    }
};

// Re-reads the roster when this window regains focus (onScreen) while the daemon is reachable: connection gaps at
// sleep or backgrounding otherwise sit unnoticed until the watchdog reconnects. One request per return;
// module-scoped like the unread watch, since the badge is a session-wide fact, not a per-route one.
const { reachable } = useSandbox();
watch([onScreen, reachable] as const, ([looking, live], [wasLooking]) => {
    if (looking && !wasLooking && live) {
        void refresh();
    }
});

// Approves or rejects a held wake through the automations routes' own verbs; the row leaves on the press and a refusal
// puts it back. The trailing refresh() is the read that retires the release, and repaints whatever else moved.
export const releaseHeld = async (id: string, verb: `approve` | `reject`): Promise<void> => {
    releasing.value = new Set(releasing.value).add(id);
    try {
        await sandboxRpc.automations[verb]({ id });
    } catch (error) {
        unrelease(id);
        throw error;
    }
    void refresh();
};

// Archived agents are absent from the live /events roster on purpose, keeping it scoped to in-flight work. Pulled
// instead, at points something could have changed it: board mount, opening the archive, the daemon reconnecting,
// or an id leaving the roster by another hand (setAgents).

// Concurrent callers (several mounted panes asking at once) share one in-flight request instead of each replacing
// the array. A caller arriving after it settles gets its own fresh request, and so does the first one after a switch:
// joining the outgoing sandbox's read would hand this one that daemon's archive.
const archiveInFlight = sandboxValue<Promise<void> | undefined>(() => undefined);

export const loadArchived = async (): Promise<void> => {
    const current = sandboxScopeGuard();
    archiveInFlight.value ??= (async () => {
        archiveLoading.value = true;
        try {
            const { agents } = await sandboxRpc.agents.archived();
            if (!current()) {
                return;
            }
            // Widened to FleetAgent here: nothing archived is unread; an open entry gets its live fields from `fleet`
            // instead.
            archived.value = agents.map((agent) => Object.assign(agent, { open: false, unread: false, unsent: false }));
        } catch {
            // Leave whatever was listed last; the view reports its own emptiness.
        } finally {
            if (current()) {
                archiveLoading.value = false;
                archiveInFlight.value = undefined;
            }
        }
    })();
    await archiveInFlight.value;
};

// One roster per window: a hot update re-executes this module while the stream keeps writing to the old instance,
// freezing the board. The revision audit can't fix this since the heartbeat reaches that same stale object; only a
// reload can.
reloadOnHotUpdate(import.meta);
