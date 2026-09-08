import type { AgentSummary, AutomationApproval } from "@intentic/sandbox-contract";
import { ref, shallowRef, watch } from "vue";
import { invalidateAgentTranscript } from "../../chat/transcript/agentTranscript";
import { useChat } from "../../chat/run/useChat";
import { reportClient } from "../../../app/clientDiagnostics";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { onScreen } from "../../../shell/window/onScreen";
import { AGENT_DIFF } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { useSandbox } from "../../sandbox/client/useSandbox";
import type { FleetAgent } from "./useAgents-fleet";

// Daemon's agent registry mirrored: the roster pushed by /events, the archived half pulled separately, ordered by
// a revision line. Bottom of the fleet store's module graph; nothing here reads a module above it.

// shallowRef: writes replace the array wholesale; a deep ref would re-proxy every summary each frame.
export const registry = shallowRef<AgentSummary[]>([]);

// Archive half of the fleet; shallowRef like `registry`, and unbounded in size unlike the live roster.
export const archived = shallowRef<FleetAgent[]>([]);
export const archiveLoading = ref(false);

// Daemon's approvals queue, projected onto the board; kept separate since the stream never carries holds.
export const heldWakes = shallowRef<AutomationApproval[]>([]);

// Roster snapshots come from three sources (the stream, refresh(), local archive/restore); a full-replace lets
// whichever lands last win regardless of truth. Each snapshot carries the revision it was read at:
// - a snapshot older than the one already applied is dropped
// - a local add/remove holds as a pending intent until a snapshot at or past its own revision arrives

// Highest applied revision; -1 until the first snapshot, so a fresh connection accepts revision 0.
let appliedRev = -1;

// Tags which daemon the revision counter belongs to; a reset bumps it so a stale late read can't reapply it.
let epoch = 0;

// Ids locally added/removed from the board, held until `untilRev` applies. `present` is the summary to restore; a
// removal carries none.
interface PendingMove {
    readonly untilRev: number;
    readonly present?: AgentSummary;
}
const pending = new Map<string, PendingMove>();

// Applies still-pending local moves on top of a server snapshot.
const withPending = (agents: AgentSummary[]): AgentSummary[] => {
    if (pending.size === 0) {
        return agents;
    }
    const kept = agents.filter((agent) => !pending.has(agent.id));
    const restored = [...pending.values()].flatMap((move) => (move.present === undefined ? [] : [move.present]));
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

const registryStable = new Map<string, AgentSummary>();

const stabilizeRegistry = (incoming: readonly AgentSummary[]): AgentSummary[] => {
    const nextIds = new Set<string>();
    const stabilized = incoming.map((agent) => {
        nextIds.add(agent.id);
        const cached = registryStable.get(agent.id);
        if (cached !== undefined && snapshotFingerprint(cached) === snapshotFingerprint(agent)) {
            return cached;
        }
        registryStable.set(agent.id, agent);
        return agent;
    });
    for (const id of registryStable.keys()) {
        if (!nextIds.has(id)) {
            registryStable.delete(id);
        }
    }
    return stabilized;
};

// Element-wise identity: true when a stabilized array holds exactly the same objects as before, so the ref (and
// its readers) is left untouched. Generic since useAgents-fleet asks the same question of its card view-models.
export const sameEntries = <T>(left: readonly T[], right: readonly T[]): boolean =>
    left.length === right.length && left.every((entry, at) => entry === right[at]);

// Retires every intent the server has now absorbed, then re-projects what remains.
const applySnapshot = (agents: AgentSummary[], rev: number): void => {
    for (const [id, move] of pending) {
        if (rev >= move.untilRev) {
            pending.delete(id);
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
        pending.set(move.id, move.present === undefined ? { untilRev: rev } : { untilRev: rev, present: move.present });
    }
    registry.value = withPending(registry.value.filter((agent) => !pending.has(agent.id)));
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
            if (pending.get(id)?.untilRev === Number.POSITIVE_INFINITY) {
                pending.delete(id);
            }
        }
        const returning = back.filter(([id]) => !pending.has(id)).map(([, agent]) => agent);
        if (returning.length > 0) {
            registry.value = withPending([...registry.value, ...returning]);
        }
    };
};

// Invalidates the pull-only diff query on any status change, since that is the daemon settling something about
// the agent's work. An id never seen before also counts, in case its outcome landed while no stream was up.
const invalidateStaleWork = (agents: readonly AgentSummary[]): void => {
    const held = new Map(registry.value.map((agent) => [agent.id, agent.status]));
    for (const agent of agents) {
        if (held.get(agent.id) !== agent.status) {
            void queryClient.invalidateQueries({ queryKey: AGENT_DIFF.of(agent.id) });
            // Same signal invalidates the transcript too: the daemon writes a turn's record only once it settles.
            invalidateAgentTranscript(agent.id);
        }
    }
};

// Applies a roster snapshot from the stream or an explicit read; dropped if it predates what's already held,
// since an out-of-order answer is a regression, not news.
export const setAgents = (agents: AgentSummary[], rev: number): void => {
    if (rev < appliedRev) {
        return;
    }
    invalidateStaleWork(agents);
    // Ids that left the roster by another hand than this browser's (daemon sweep, another device); local moves are
    // excluded via `pending`. Triggers an archive-list refresh and closes their chat tabs.
    const incoming = new Set(agents.map((agent) => agent.id));
    const departed = new Set(registry.value.filter((agent) => !incoming.has(agent.id) && !pending.has(agent.id)).map((agent) => agent.id));
    if (departed.size > 0) {
        void loadArchived();
        useChat().closeRetired(departed);
    }
    appliedRev = rev;
    applySnapshot(agents, rev);
    // Attaches a tab opened before its turn existed to the turn now running (workflow step, wake, another device).
    useChat().attachStarted(new Set(agents.filter((agent) => agent.status === `running`).map((agent) => agent.id)));
};

// Drops per-daemon state: revision line and pending moves always; `keepRoster` keeps the roster on a mere
// disconnect but clears it (and held wakes, also painted) on a sandbox switch.
export const desyncRegistry = (keepRoster: boolean): void => {
    if (!keepRoster) {
        registry.value = [];
        heldWakes.value = [];
    }
    pending.clear();
    registryStable.clear();
    appliedRev = -1;
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
    void sandboxJson(`/agents/${encodeURIComponent(id)}/seen`, { method: `POST` }).catch(() => undefined);
};

// Clears every unread badge at once, instead of requiring a click through each card.
export const markAllSeen = (): void => {
    const now = Date.now();
    for (const agent of registry.value) {
        agent.seenAt = now;
    }
    void sandboxJson(`/agents/seen`, { method: `POST` }).catch(() => undefined);
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
    if (rev === appliedRev) {
        return;
    }
    // Logged once per occurrence (deduped) so a silent repair leaves a trace in logs/client.jsonl.
    reportClient(`fleet.roster-behind`, `the roster missed a snapshot and was read back`, {
        level: `warn`,
        fields: { held: appliedRev, beat: rev },
    });
    if (rev < appliedRev) {
        appliedRev = -1;
    }
    auditing ??= refresh().finally(() => {
        auditing = undefined;
    });
};

// Explicit registry pull for the reachable seam and pull-to-refresh; steady state rides /events. Exported
// separately since sandboxScope calls it on a switch, mainly to refill held wakes, which the stream never populates.
export const refreshAgents = async (): Promise<void> => refresh();

export const refresh = async (): Promise<void> => {
    const issuedAt = epoch;
    try {
        const body = await sandboxJson<{ agents: AgentSummary[]; rev: number; held?: AutomationApproval[] }>(`/agents`);
        // Stale: issued to a daemon since replaced (`epoch`); its revision can't be trusted as a high-water mark.
        if (issuedAt !== epoch) {
            return;
        }
        // Goes through setAgents, not a raw assignment, so a slow read can't undo a newer frame from the stream.
        setAgents(body.agents, body.rev);
        heldWakes.value = body.held ?? [];
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

// Approves or rejects a held wake through the automations routes' own verbs, so surfaces agree on meaning. Removed
// from the list optimistically; the trailing refresh() repaints whatever else moved.
export const releaseHeld = async (id: string, verb: `approve` | `reject`): Promise<void> => {
    await sandboxJson(`/automations/pending/${encodeURIComponent(id)}/${verb}`, { method: `POST` });
    heldWakes.value = heldWakes.value.filter((entry) => entry.id !== id);
    void refresh();
};

// Archived agents are absent from the live /events roster on purpose, keeping it scoped to in-flight work. Pulled
// instead, at points something could have changed it: board mount, opening the archive, the daemon reconnecting,
// or an id leaving the roster by another hand (setAgents).

// Cleared only on a sandbox switch, since another daemon's archive must never offer restores here. Not folded into
// resetAgents, which also fires on a mere stream failure, when keeping the last list beats blanking the door.
export const resetArchive = (): void => {
    archived.value = [];
};

// Concurrent callers (several mounted panes asking at once) share one in-flight request instead of each replacing
// the array. A caller arriving after it settles gets its own fresh request.
let archiveInFlight: Promise<void> | undefined;

export const loadArchived = async (): Promise<void> => {
    archiveInFlight ??= (async () => {
        archiveLoading.value = true;
        try {
            const body = await sandboxJson<{ agents: AgentSummary[] }>(`/agents/archived`);
            // Widened to FleetAgent here: nothing archived is unread; an open entry gets its live fields from `fleet`
            // instead.
            archived.value = body.agents.map((agent) => Object.assign(agent, { open: false, unread: false, unsent: false }));
        } catch {
            // Leave whatever was listed last; the view reports its own emptiness.
        } finally {
            archiveLoading.value = false;
            archiveInFlight = undefined;
        }
    })();
    await archiveInFlight;
};

// One roster per window: a hot update re-executes this module while the stream keeps writing to the old instance,
// freezing the board. The revision audit can't fix this since the heartbeat reaches that same stale object; only a
// reload can.
reloadOnHotUpdate(import.meta);
