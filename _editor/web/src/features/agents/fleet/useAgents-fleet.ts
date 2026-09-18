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

// Landed work the workspace no longer holds; the card offers Land again, not a receipt.
export const finishedNeedsReland = (agent: Pick<FleetAgent, "landedPresence">): boolean =>
    agent.landedPresence !== undefined && agent.landedPresence.present < agent.landedPresence.landed;

// Every finished card that still owes a press or has words at risk; the window must never fold these away.
export const finishedNeedsAction = (
    agent: Pick<FleetAgent, "unsent" | "unfinished" | "status" | "landedPresence">,
): boolean =>
    agent.unsent || agent.unfinished !== undefined || agent.status === `ready` || agent.status === `landing` || finishedNeedsReland(agent);

// Nothing left for the reader to do with this chat: settled in Finished, owing no press, and already looked at.
// The rail is a working set, so this is what lets a tab leave it without a press (useChat-tabs.releaseDone); the
// board is the record and keeps its card either way.
// Unread is the grace, and it does most of the work: a chat that finished while the reader was elsewhere keeps its
// row until they have read it. A workflow step waives it, since a step is read through its run's row and never had
// a row of its own to be read in. An unregistered card is excluded outright: with no registry entry there is no
// account of whether the work is over, only this browser's guess.
export const doneWith = (agent: FleetAgent): boolean =>
    !unregistered(agent.status) && laneOf(agent) === `finished` && !finishedNeedsAction(agent) && (!agent.unread || agent.workflow !== undefined);

// When the turn ended, not the last observe frame; `updatedAt` on a settled card is finish/land time only.
const finishedRecency = (agent: FleetAgent): number => agent.unfinished?.at ?? agent.updatedAt;

// Caps browsing, not existence: every actionable card stays in the window, receipts fill what is left, and a selected
// card beyond the fold is prepended when it still owes a press (never demoted to the tail). Shared by both Finished lanes.
export const windowFinished = <T>(
    finished: readonly T[],
    selectedId: string | undefined,
    idOf: (entry: T) => string,
    needsAction: (entry: T) => boolean = () => false,
): { shown: T[]; hidden: number } => {
    const acting = finished.filter(needsAction);
    const receipts = finished.filter((entry) => !needsAction(entry));
    const room = Math.max(FINISHED_WINDOW, acting.length);
    const shown = [...acting, ...receipts.slice(0, Math.max(0, room - acting.length))];
    const shownIds = new Set(shown.map(idOf));
    const hidden = finished.length - shown.length;
    if (selectedId === undefined || shownIds.has(selectedId)) {
        return { shown, hidden };
    }
    const pinned = finished.find((entry) => idOf(entry) === selectedId);
    if (pinned === undefined) {
        return { shown, hidden };
    }
    if (needsAction(pinned)) {
        return { shown: [pinned, ...shown], hidden: hidden - 1 };
    }
    return { shown: [...shown, pinned], hidden: hidden - 1 };
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

// A turn this browser sent that the roster cannot have answered for yet, returning the instant it went. The board's
// one client-side reading of a registered agent's status: a send is known here a whole round trip (POST → begin →
// persist → /events) before the frame that would move the card, and a card that stays in Finished after the press
// reads as a press that missed. Refusal needs no rollback — `standingOf` stops saying `starting` the moment the local
// turn ends, and the roster's own status is what the card falls back to.
// Bounded two ways: the daemon must believe the conversation settled (a parked card keeps its lane, whatever this
// window is streaming), and the turn must be newer than the roster's last word about it, so a strip left behind by a
// dead window can never hold a card in Active.
const sendingNow = (agent: AgentSummary, tab: TabFacts | undefined): number | undefined => {
    if (tab?.standing !== `starting` || turnInFlight(agent) || awaitingUser(agent)) {
        return undefined;
    }
    const startedAt = tab.turn?.startedAt;
    return startedAt !== undefined && startedAt > agent.updatedAt ? startedAt : undefined;
};

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
    // Every open tab by conversation, for what only this browser knows about a registered agent: that a turn just went
    // (`sendingNow`).
    const live: ReadonlyMap<string, TabFacts> = new Map(strip.tabs.map((tab) => [tab.id, tab]));
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
            // `running`, not the client-only `starting`: this agent IS registered, and `starting` would seed its next
            // tab as unregistered. The turn's own start rides with it, or the card's elapsed clock would count from
            // the previous turn.
            const startedAt = sendingNow(agent, live.get(agent.id));
            return {
                ...agent,
                ...(startedAt === undefined ? {} : { status: `running` as const, startedAt }),
                open: openIds.has(agent.id),
                unread: startedAt === undefined && !turnInFlight(agent) && agent.updatedAt > (agent.seenAt ?? 0),
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

// Chats the roster is done with, handed to the tab store so its own sweep can take them without a press
// (useChat-tabs.releaseDone). The whole verdict each frame rather than what changed in it: the store is the only
// side that knows which of them the reader has pinned, put in a column, or is about to give a column back.
watch(
    () => fleet.value.filter(doneWith).map((agent) => agent.id),
    (ids) => useChat().releaseDone(new Set(ids)),
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

// One ordering for every Finished lane: what is easiest to lose or miss rises to the top before recency.
export const compareFinishedLane = (a: FleetAgent, b: FleetAgent): number =>
    Number(b.unsent) - Number(a.unsent) ||
    Number(b.unfinished !== undefined) - Number(a.unfinished !== undefined) ||
    Number(b.status === `ready`) - Number(a.status === `ready`) ||
    Number(finishedNeedsReland(b)) - Number(finishedNeedsReland(a)) ||
    finishedRecency(b) - finishedRecency(a) ||
    byId(a, b);

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
    grouped.finished.sort(compareFinishedLane);
    return grouped;
};

export const lanes = computed<Record<FleetLane, FleetAgent[]>>(() => laneGroups(fleet.value));

// Resolves an id across both the live roster and the archive, since a detail page addressed by id must still find
// an archived agent. Archive half only populates once loadArchived has run.
export const agentById = (id: string): FleetAgent | undefined =>
    fleet.value.find((agent) => agent.id === id) ?? archived.value.find((agent) => agent.id === id);
