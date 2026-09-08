import type { AgentSummary } from "@intentic/sandbox-contract";
import { computed, watch } from "vue";
import { awaitingUser, blocked, type ClientAgentStatus, type FleetLane, laneOf, NO_ATTENTION, turnInFlight, unregistered } from "./agentStatus";
import { closedDrafts } from "../../chat/drafts/closedDrafts";
import { draftPreview } from "../../chat/drafts/draftPreview";
import { type TabFacts, unasked } from "../../chat/tabs/tabFacts";
import type { StoredTab } from "../../chat/tabs/tabSnapshot";
import { rememberedProviderFor } from "../../chat/run/turnDefaults";
import { useChat } from "../../chat/run/useChat";
import { chatStrip } from "../../chat/panel/useChat-strip";
import { onScreen } from "../../../shell/window/onScreen";
import { archived, heldWakes, markSeen, registry, sameEntries, snapshotFingerprint } from "./useAgents-registry";

// Fleet view: registry (authoritative status/branch/cost) merged with open tabs by conversationId (live state),
// producing the lanes and counts the board draws. Derived only; the roster lives in useAgents-registry.

// Merge of the registry and open tabs by conversationId; an open, unregistered conversation is a draft card until
// its first turn registers it. `status` widens the wire enum with that client-only draft state.
export interface FleetAgent extends Omit<AgentSummary, "status"> {
    readonly status: AgentSummary["status"] | ClientAgentStatus;
    // Sandbox this card's agent is in; absent means the active one, set only for another box's roster entry.
    readonly sandboxId?: string;
    readonly open: boolean;
    readonly unread: boolean;
    // Unsent words in this open tab (any window of this browser); false for a draft written on another device.
    readonly unsent: boolean;
    // Opening words of the unsent message; names the card and backs the unsent mark's tooltip.
    readonly preview?: string;
    // When the composer first held something unsent, so the mark can show how long it's been standing.
    readonly draftAt?: number;
}

// How many finished entries show before the rest collapse behind one row; older ones remain reachable.
// Six rather than seven: Finished is the only self-filling lane, so it decides how tall the board reads, and the
// fold below it is one press away. The number is small on purpose — the lane is a ledger you skim, not the work.
export const FINISHED_WINDOW = 6;

// Caps browsing, not existence: the currently open card is never culled even past the window, pinned at the tail
// and excluded from the hidden count. Shared by both Finished lanes (board and chat list) so they can't disagree.
export const windowFinished = <T>(
    finished: readonly T[],
    selectedId: string | undefined,
    idOf: (entry: T) => string,
): { shown: T[]; hidden: number } => {
    const shown = finished.slice(0, FINISHED_WINDOW);
    const beyond = finished.slice(FINISHED_WINDOW);
    const pinned = selectedId === undefined ? undefined : beyond.find((entry) => idOf(entry) === selectedId);
    if (pinned === undefined) {
        return { shown, hidden: beyond.length };
    }
    return { shown: [...shown, pinned], hidden: beyond.length - 1 };
};

// Built from the stored tab alone, since no daemon row or open tab exists for it; carries its origin sandbox so
// actions address the right daemon. `updatedAt` is 0, since being set aside isn't activity.
const closedCard = (tab: StoredTab, unsent: UnsentTab | undefined): FleetAgent => ({
    id: tab.conversationId,
    status: tab.session === undefined ? `draft` : `resumed`,
    // Falls back the same as a fresh conversation, so a tab persisted before picking anything can still open.
    provider: tab.provider ?? rememberedProviderFor(),
    harness: tab.harness ?? `native`,
    updatedAt: 0,
    attention: NO_ATTENTION,
    // No tab anywhere for this card; its × forgets it rather than closing it.
    open: false,
    unread: false,
    unsent: true,
    preview: unsent?.preview,
    draftAt: tab.draftAt,
    // Model the composer held when closed: queued work whose spend is already decided.
    ...(tab.model === undefined ? {} : { model: tab.model }),
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.session === undefined ? {} : { sessionId: tab.session.id }),
    ...(tab.box === undefined ? {} : { sandboxId: tab.box }),
});

// One composer's unsent contents: opening words and the instant it first held something. Both optional (no words
// for an attachment/queued message, no instant on a pre-stamp snapshot restore).
interface UnsentTab {
    readonly preview?: string;
    readonly at?: number;
}

// One open tab the fleet has never registered (from the strip, tabFacts.ts), named only by its own unsent
// preview, never a title fallback. `turn` fields exist only on a `starting` card, until the registry lands it.
const draftCard = (tab: TabFacts, held: UnsentTab | undefined): FleetAgent => ({
    id: tab.id,
    status: tab.standing,
    provider: tab.provider,
    harness: tab.harness,
    updatedAt: 0,
    attention: NO_ATTENTION,
    open: true,
    unread: false,
    unsent: held !== undefined,
    preview: held?.preview,
    draftAt: held?.at,
    ...(tab.box === undefined ? {} : { sandboxId: tab.box }),
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.sessionId === undefined ? {} : { sessionId: tab.sessionId }),
    ...(tab.turn === undefined ? {} : { model: tab.model, ...tab.turn }),
    ...(tab.standing === `draft` && held !== undefined ? { model: tab.model } : {}),
});

// Sort weight: attention first, then in-flight turns and fresh drafts, then most recent activity.
const weight = (entry: FleetAgent): number =>
    blocked(entry) ? 0 : turnInFlight(entry) || entry.status === `awaiting` || entry.status === `draft` ? 1 : 2;

// Same stabilization as the roster: reuses the previous FleetAgent when its derived fields are unchanged, so Vue
// can skip re-rendering cards whose agent didn't move.
const fleetStable = new Map<string, FleetAgent>();
let stableFleet: FleetAgent[] = [];

const stabilizeFleetEntry = (entry: FleetAgent): FleetAgent => {
    const cached = fleetStable.get(entry.id);
    if (cached !== undefined && snapshotFingerprint(cached) === snapshotFingerprint(entry)) {
        return cached;
    }
    fleetStable.set(entry.id, entry);
    return entry;
};

// Clears the memo tied to the previous daemon's roster; its cached cards are that daemon's objects.
export const forgetFleet = (): void => {
    fleetStable.clear();
    stableFleet = [];
};

export const fleet = computed<FleetAgent[]>(() => {
    // Single source for open tabs, titles and unsent state; never this window's own tab list.
    const strip = chatStrip.value;
    const openIds = new Set(strip.tabs.map((tab) => tab.id));
    const carded = new Set(registry.value.map((agent) => agent.id));
    // Unsent words: open composers plus chats closed with the message still in them; composers win any race.
    const unsent: ReadonlyMap<string, UnsentTab> = new Map([
        ...closedDrafts.value.map((tab): [string, UnsentTab] => [tab.conversationId, { preview: draftPreview(tab.draft), at: tab.draftAt }]),
        ...strip.tabs.filter((tab) => tab.unsent).map((tab): [string, UnsentTab] => [tab.id, { preview: tab.preview, at: tab.draftAt }]),
    ]);
    // Draft = unregistered tab; `carded` stops an id the registry already rendered from rendering twice.
    // Excludes an empty placeholder tab (`unasked`); it joins the board itself once anything happens in it.
    const drafts = strip.tabs
        .filter((tab) => !tab.registered && !carded.has(tab.id) && !unasked(tab))
        .map((tab): FleetAgent => draftCard(tab, unsent.get(tab.id)));
    // An archived agent's own unsent words surface it back onto the board; the card still marks itself archived and
    // drops away once the words are sent or cleared.
    const held: FleetAgent[] = [];
    const archivedIds = new Set(archived.value.map((agent) => agent.id));
    for (const agent of archived.value) {
        const tab = unsent.get(agent.id);
        if (tab !== undefined && !carded.has(agent.id)) {
            // A copy, not the archive's own entry: unsent/preview/draftAt describe the composer, not the filed-away
            // agent.
            held.push({ ...agent, open: openIds.has(agent.id), unsent: true, preview: tab.preview, draftAt: tab.at });
        }
    }
    // Chats closed with nothing but their unsent message: no roster row, archive entry, or open tab draws them
    // otherwise. Stands as `draft` unless the closed chat had a session, in which case reopening resumes it.
    const setAside = closedDrafts.value
        .filter((tab) => !openIds.has(tab.conversationId) && !carded.has(tab.conversationId) && !archivedIds.has(tab.conversationId))
        .map((tab): FleetAgent => closedCard(tab, unsent.get(tab.conversationId)));
    const built = [
        ...registry.value.map((agent): FleetAgent => {
            const tab = unsent.get(agent.id);
            return {
                ...agent,
                open: openIds.has(agent.id),
                unread: !turnInFlight(agent) && agent.updatedAt > (agent.seenAt ?? 0),
                unsent: tab !== undefined,
                preview: tab?.preview,
                draftAt: tab?.at,
            };
        }),
        ...held,
        ...drafts,
        ...setAside,
    ].toSorted((a, b) => weight(a) - weight(b) || b.updatedAt - a.updatedAt);
    const next = built.map(stabilizeFleetEntry);
    const nextIds = new Set(next.map((agent) => agent.id));
    for (const id of fleetStable.keys()) {
        if (!nextIds.has(id)) {
            fleetStable.delete(id);
        }
    }
    if (sameEntries(stableFleet, next)) {
        return stableFleet;
    }
    stableFleet = next;
    return next;
});

// Two headline counts, kept apart since the header renders both: blocked-on-user vs. merely unread.
export const blocking = computed(() => fleet.value.filter(blocked).length);
export const unread = computed(() => fleet.value.filter((agent) => agent.unread).length);
// Badge total: blocked-or-unread agents, plus held wakes, which have no conversation yet but need attention.
export const attention = computed(() => fleet.value.filter((agent) => blocked(agent) || agent.unread).length + heldWakes.value.length);

// Marks the focused conversation seen the moment it updates, but only while this window is on screen and watching
// it; otherwise it stays unread for the badge.
watch(
    () => {
        if (!onScreen.value) {
            return undefined;
        }
        const watched = fleet.value.find((agent) => agent.id === useChat().active.value.conversationId);
        return watched?.unread === true ? watched.id : undefined;
    },
    (id) => {
        if (id !== undefined) {
            markSeen(id);
        }
    },
);

// Whether the board may archive this card; not the same as being Finished, which trapped an errored agent with
// nothing to land in Attention forever. True unless the agent has a live turn or is still awaiting the user:
// - running/stopping: no, it's the live turn's worktree
// - draft: no registry entry to archive
// - awaiting/plan/question/permission: would bury the question
// - error/conflict/stopped/landed/idle: yes
export const canArchive = (agent: Pick<FleetAgent, "status" | "attention" | "archivedAt">): boolean =>
    agent.archivedAt === undefined && !unregistered(agent.status) && !turnInFlight(agent) && !awaitingUser(agent);

// Final tiebreaker for every lane's sort: without one, cards with equal `updatedAt` (common after a batch resume)
// swap places every tick. The id itself is arbitrary, chosen only to stay the same next frame.
const byId = (a: FleetAgent, b: FleetAgent): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Splits a flat list into the board's three lanes, factored out of `fleet` so the all-sandboxes board can apply
// the same rule to a wider list (this fleet plus other boxes' summaries) without duplicating the sort.
export const laneGroups = (agents: readonly FleetAgent[]): Record<FleetLane, FleetAgent[]> => {
    const grouped: Record<FleetLane, FleetAgent[]> = { attention: [], active: [], finished: [] };
    for (const agent of agents) {
        grouped[laneOf(agent)].push(agent);
    }
    // Fresh drafts lead, then by startedAt (fixed for a turn's life) so a running agent won't jump every tick.
    grouped.active.sort(
        (a, b) =>
            Number(b.status === `draft`) - Number(a.status === `draft`) || (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt) || byId(a, b),
    );
    grouped.attention.sort((a, b) => b.updatedAt - a.updatedAt || byId(a, b));
    // Unsent first (words at risk of being lost), then unfinished, then ready-to-land, then recency: this lane is
    // windowed (FINISHED_WINDOW), and pure recency would let a fold push a waiting card out of view.
    grouped.finished.sort(
        (a, b) =>
            Number(b.unsent) - Number(a.unsent) ||
            Number(b.unfinished !== undefined) - Number(a.unfinished !== undefined) ||
            Number(b.status === `ready`) - Number(a.status === `ready`) ||
            b.updatedAt - a.updatedAt ||
            byId(a, b),
    );
    return grouped;
};

export const lanes = computed<Record<FleetLane, FleetAgent[]>>(() => laneGroups(fleet.value));

// Resolves an id across both the live roster and the archive, since a detail page addressed by id must still find
// an archived agent. Archive half only populates once loadArchived has run.
export const agentById = (id: string): FleetAgent | undefined =>
    fleet.value.find((agent) => agent.id === id) ?? archived.value.find((agent) => agent.id === id);
