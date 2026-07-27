import type { AgentSummary } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { openAgentConversation, useChat } from "../chat/useChat";
import { sandboxJson } from "../sandbox/sandboxClient";
import { errorMessage } from "../useAsyncAction";

/* The fleet store — the daemon's agent registry mirrored into the browser. Fed two ways: the /events stream's
 * `agents` roster snapshots (last frame wins, the presence pattern — see useSandboxLiveness) and an explicit
 * refresh() from GET /agents on the reachable seam. The FLEET view merges the registry (authoritative:
 * status/branch/cost, agents this tab never opened) with the open Conversation tabs by conversationId (live:
 * in-browser streaming state). Module-level singleton, like useChat. */

const registry = ref<AgentSummary[]>([]);

/* --- Roster ordering ----------------------------------------------------------------------------------------
 * The fleet is published as full snapshots, and THREE sources produce them: the /events stream, an explicit
 * refresh() (GET /agents), and this browser's own optimistic archive/restore. A plain full-replace lets whichever
 * lands last win regardless of when it was TRUE, which is what put an archived card back on the board and
 * bounced the user off its detail page.
 *
 * So every snapshot carries the registry revision it was read at (see AgentsListSchema), and:
 *   - a snapshot older than the one already applied is dropped outright; and
 *   - a local add/remove is held as a pending intent until a snapshot at or past the revision that APPLIED it
 *     arrives — at which point the server's own account is authoritative and the intent retires itself.
 *
 * The second rule is what a revision alone can't do: between sending an archive and the daemon applying it, an
 * unrelated change (a running turn ticks updatedAt about once a second) legitimately produces a NEWER snapshot
 * that still contains the agent. Dropping by revision would accept it; the pending intent is what keeps the card
 * off the board across that window. */

// The highest revision applied so far. -1 until the first snapshot: a fresh connection adopts whatever it is
// handed, including revision 0 from a daemon that just restarted.
let appliedRev = -1;

// Ids this browser has locally added to or removed from the board, each held until `untilRev` is applied.
// `present` is the summary to show for a restore; a removal carries none.
interface PendingMove {
    readonly untilRev: number;
    readonly present?: AgentSummary;
}
const pending = new Map<string, PendingMove>();

// Project a server snapshot through the still-unconfirmed local moves.
const withPending = (agents: AgentSummary[]): AgentSummary[] => {
    if (pending.size === 0) {
        return agents;
    }
    const kept = agents.filter((agent) => !pending.has(agent.id));
    const restored = [...pending.values()].flatMap((move) => (move.present === undefined ? [] : [move.present]));
    return [...kept, ...restored];
};

// Retire every intent the server has now demonstrably absorbed, then re-project what remains.
const applySnapshot = (agents: AgentSummary[], rev: number): void => {
    for (const [id, move] of pending) {
        if (rev >= move.untilRev) {
            pending.delete(id);
        }
    }
    registry.value = withPending(agents);
};

// Record a local move and paint it immediately. `rev` is the revision the daemon reported for the mutation, so
// the intent survives exactly until a roster that includes it arrives — no timers, no fixed windows.
const holdPending = (moves: readonly { id: string; present?: AgentSummary }[], rev: number): void => {
    for (const move of moves) {
        pending.set(move.id, move.present === undefined ? { untilRev: rev } : { untilRev: rev, present: move.present });
    }
    registry.value = withPending(registry.value.filter((agent) => !pending.has(agent.id)));
};

// Roster snapshot from the events stream or an explicit read. Dropped when it predates what we already hold —
// an out-of-order answer is not news, it is a regression.
export const setAgents = (agents: AgentSummary[], rev: number): void => {
    if (rev < appliedRev) {
        return;
    }
    appliedRev = rev;
    applySnapshot(agents, rev);
};

// A disconnected roster is meaningless; the reconnect's immediate snapshot repaints it. The revision goes with
// it: the next daemon we speak to may be a restarted one whose counter began again at 0, and holding onto a
// higher number would make us reject its every frame. Pending moves are dropped for the same reason — they were
// promises about a revision line that no longer exists.
export const resetAgents = (): void => {
    registry.value = [];
    pending.clear();
    appliedRev = -1;
    // An undo is a promise to a particular daemon about particular ids; the next one we speak to may be a
    // restart that has never heard of them. The reports offering it go with it.
    undoable.value = [];
    receipt.value = undefined;
    notice.value = undefined;
};

// Unread tracking: an agent whose updatedAt outruns the last time it was OPENED, while it isn't running, "has
// something for you". The read marker itself lives on the daemon entry (AgentSummary.seenAt), not in this
// browser — read state is a fact about the work, so clearing site data, opening an incognito window, or
// switching to the phone must not resurrect a board full of "New" badges.
//
// Writes are optimistic: stamp the roster in place (the card repaints instantly — `registry` is a deep ref),
// then persist through the daemon, whose broadcast re-lands the same value on every other connected surface.
// Best-effort: a failed write only means the badge returns on the next roster frame, and a card with no
// registry entry is a draft — nothing to mark, nothing unread.
const markSeen = (id: string): void => {
    const entry = registry.value.find((agent) => agent.id === id);
    if (entry === undefined) {
        return;
    }
    entry.seenAt = Date.now();
    void sandboxJson(`/agents/${encodeURIComponent(id)}/seen`, { method: `POST` }).catch(() => undefined);
};

// The escape hatch a notification surface owes the user: clear the whole board at once instead of clicking
// through every card to silence the rail badge.
const markAllSeen = (): void => {
    const now = Date.now();
    for (const agent of registry.value) {
        agent.seenAt = now;
    }
    void sandboxJson(`/agents/seen`, { method: `POST` }).catch(() => undefined);
};

// One fleet entry. Two sources merged by conversationId: the registry (authoritative once a turn has run) and
// the open tabs — an open ISOLATED conversation with no registry entry yet is a DRAFT card, so "New agent" has
// a visible result on the board the instant it's pressed. `status` widens the wire enum with that
// client-only draft state; the registry wins the merge the moment the first turn registers the conversation.
export interface FleetAgent extends Omit<AgentSummary, "status"> {
    readonly status: AgentSummary["status"] | "draft";
    readonly open: boolean;
    readonly unread: boolean;
}

// How many finished agents the lane shows before the rest collapse behind one row. The lane's job is to
// CONFIRM what just completed, not to be the sandbox's permanent record — everything older is still one click
// away, and the daemon's retention sweep is what eventually retires it. Also the thing standing between the
// board and a TransitionGroup running FLIP over several hundred cards.
export const FINISHED_WINDOW = 6;

// "Blocked on you" — the agent literally cannot go on (or has failed) until you act. Deliberately NOT the same
// thing as unread, which only says you haven't looked at it yet: a board that tells the user seven finished
// agents "need you" teaches them to ignore the word.
const blocked = (agent: Pick<FleetAgent, "status" | "attention">): boolean =>
    agent.attention.plan || agent.attention.question || agent.attention.permission || agent.attention.conflict || agent.status === `error`;

// Attention first, then running + fresh drafts, then most recently active.
const weight = (entry: FleetAgent): number =>
    blocked(entry) ? 0 : entry.status === `running` || entry.status === `awaiting` || entry.status === `draft` ? 1 : 2;

const fleet = computed<FleetAgent[]>(() => {
    const { conversations } = useChat();
    const openIds = new Set(conversations.value.map((conversation) => conversation.conversationId));
    const registered = new Set(registry.value.map((agent) => agent.id));
    const drafts = conversations.value
        .filter((conversation) => conversation.isolated.value && !registered.has(conversation.conversationId))
        .map((conversation): FleetAgent => {
            const draft: FleetAgent = {
                id: conversation.conversationId,
                // A draft racing its first turn (begin → roster frame) already reads as running.
                status: conversation.streaming.value ? `running` : `draft`,
                provider: conversation.provider.value,
                harness: conversation.harness.value,
                updatedAt: 0,
                attention: { plan: false, question: false, permission: false, conflict: false },
                open: true,
                unread: false,
            };
            if (conversation.title.value !== null) {
                draft.title = conversation.title.value;
            }
            return draft;
        });
    return [
        ...registry.value.map((agent) => ({
            ...agent,
            open: openIds.has(agent.id),
            unread: agent.status !== `running` && agent.updatedAt > (agent.seenAt ?? 0),
        })),
        ...drafts,
    ].toSorted((a, b) => weight(a) - weight(b) || b.updatedAt - a.updatedAt);
});

// The board's two headline counts, kept apart on purpose (the header renders both): agents BLOCKED on the
// user, and agents merely unread.
const blocking = computed(() => fleet.value.filter(blocked).length);
const unread = computed(() => fleet.value.filter((agent) => agent.unread).length);
// The single aggregate the rail tile and mobile tab badge render — "there is something for you on the board",
// counted per AGENT so one that is both blocked and unread badges once.
const attention = computed(() => fleet.value.filter((agent) => blocked(agent) || agent.unread).length);

// A turn that finishes while you are WATCHING its conversation is not news — the reply is already on your
// screen, so the card must not flip to "New" under your cursor (and the rail must not badge it). Gated on the
// tab being VISIBLE: an agent that finishes while the app sits in a background tab or a locked phone is
// exactly what the badge exists for, even though its conversation is still technically the active one.
// (Guarded like the store read it replaced: this module also evaluates in the node test env.)
const visible = ref(true);
if (typeof document !== `undefined`) {
    const syncVisible = (): void => {
        visible.value = document.visibilityState === `visible`;
    };
    syncVisible();
    document.addEventListener(`visibilitychange`, syncVisible);
}
watch(
    () => {
        if (!visible.value) {
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

// The kanban lanes — pure projections of the status machine, so "finished" needs no explicit action or
// timer: the auto-land flow flips a cleanly-completed turn to landed/idle within ms of it ending, and any
// follow-up message animates the card straight back to active. Unread stays a card badge, not a promotion.
export type FleetLane = "attention" | "active" | "finished";
export const laneOf = (agent: Pick<FleetAgent, "status" | "attention">): FleetLane => {
    if (blocked(agent) || agent.status === `awaiting` || agent.status === `conflict`) {
        return `attention`;
    }
    if (agent.status === `running` || agent.status === `draft`) {
        return `active`;
    }
    return `finished`; // landed | idle — the work is in the workspace (or there was none).
};

const lanes = computed<Record<FleetLane, FleetAgent[]>>(() => {
    const grouped: Record<FleetLane, FleetAgent[]> = { attention: [], active: [], finished: [] };
    for (const agent of fleet.value) {
        grouped[laneOf(agent)].push(agent);
    }
    // Fresh drafts lead the active lane (they're what the user just created). Below them, order by startedAt —
    // a turn's start is FIXED for its whole life, so a running agent holds its slot instead of jumping to the
    // top on every activity frame (updatedAt ticks every second, which churns the lane when many run at once).
    // Oldest-running leads; a draft has no startedAt, so it falls back to updatedAt but is already sorted ahead.
    grouped.active.sort(
        (a, b) => Number(b.status === `draft`) - Number(a.status === `draft`) || (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt),
    );
    grouped.attention.sort((a, b) => b.updatedAt - a.updatedAt);
    grouped.finished.sort((a, b) => b.updatedAt - a.updatedAt);
    return grouped;
});

// Explicit registry pull — the reachable seam and pull-to-refresh use it; steady-state updates ride /events.
const refresh = async (): Promise<void> => {
    try {
        const body = await sandboxJson<{ agents: AgentSummary[]; rev: number }>(`/agents`);
        // Through setAgents, not a raw assignment: this read races the stream, and a slow one that started
        // before the newest frame must not be allowed to undo it.
        setAgents(body.agents, body.rev);
    } catch {
        // Leave the last roster; the events stream repaints on reconnect.
    }
};

/* --- Archive ---------------------------------------------------------------------------------------------
 * The board's exit. Archiving takes an agent off the lanes and reclaims its worktree checkout, keeping the
 * branch, the transcript and every counter — so it is the ROUTINE action (no confirmation, undoable, bulk),
 * and discard stays the destructive one. See the daemon's agents/archive.ts for what it actually costs.
 *
 * Archived agents are absent from the roster the /events stream carries, which is the point: the board's live
 * state stays the size of the work in flight. They load on demand instead, when the archive is opened. */
const archived = ref<FleetAgent[]>([]);
const archiveLoading = ref(false);

const loadArchived = async (): Promise<void> => {
    archiveLoading.value = true;
    try {
        const body = await sandboxJson<{ agents: AgentSummary[] }>(`/agents/archived`);
        // Widened to FleetAgent here rather than at render: an archived agent has no open tab and nothing
        // unread by construction (it left the board), so the two card fields are constants, not a merge.
        // Object.assign, not a spread — this array is this call's own freshly-parsed JSON.
        archived.value = body.agents.map((agent) => Object.assign(agent, { open: false, unread: false }));
    } catch {
        // Leave whatever was listed last; the view reports its own emptiness.
    } finally {
        archiveLoading.value = false;
    }
};

/* --- What an archive says ------------------------------------------------------------------------------------
 * Feedback proportional to consequence. Archiving is the action a user performs dozens of times a session, and
 * it is lossless (branch, transcript and counters all stay), so what it says has to be worth what it costs:
 *
 *   · ONE card archived → nothing. The card visibly leaves its lane and the Finished header's archive counter
 *     ticks up, so a strip that repeats the animation is chrome paid for on every press and read on none. It
 *     also SHIFTED the board, which is how a routine action came to feel like an interruption.
 *   · A BULK sweep      → a receipt, because the thing that vouches for a single archive — watching the card
 *     go — is exactly what clearing twelve at once denies you. It floats over the board instead of shifting
 *     it, and it retires itself.
 *   · A FAILURE         → the persistent strip. An error has to be read, so it must not expire on a timer.
 *
 * None of them OWNS the undo. The way back is a fact about the store (`undoable`), so Mod+Z reaches the last
 * archive whether a receipt was ever raised or has long since faded. */

// The board's must-read strip: an action that failed (a drop, an archive, a restore). No timer — an error the
// user never saw is one that surprises them later.
const notice = ref<string | undefined>(undefined);

// The self-retiring report a bulk archive raises. The VIEW owns its expiry (a hovered receipt must not vanish
// under the cursor that came for its Undo), which also keeps this module timer-free.
export interface FleetReceipt {
    readonly message: string;
    readonly undo?: () => Promise<void>;
}
const receipt = ref<FleetReceipt | undefined>(undefined);

// The ids an undo would put back. Consecutive archives MERGE: clicking down the Finished lane is one intent,
// and a stack remembering only the newest press would silently drop the way back to everything before it —
// which is the whole reason archiving is allowed to skip its confirmation. Unbounded in time on purpose: undo
// means "undo what I did", and putting a card back costs no more than taking it off did.
const undoable = ref<readonly string[]>([]);

// Bumped by every archive that moved something — the ambient signal the archive counter pulses on. A counter
// rather than a flag because it is the EVENT that matters: two archives in a row owe the user two pulses.
const archivedFlash = ref(0);

// Which cards are mid-action. A COUNTER per id, not a list: archiving is something the user does card by card
// as fast as they can click, so two calls overlap constantly, and a shared "the ids in flight" ref meant the
// first one to finish cleared the second one's spinner — the card went quiet while its request was still open.
// Each call now releases only what it claimed.
const busyCounts = ref<Record<string, number>>({});
const busyIds = computed(() => Object.keys(busyCounts.value));
const claimBusy = (ids: readonly string[]): (() => void) => {
    for (const id of ids) {
        busyCounts.value = { ...busyCounts.value, [id]: (busyCounts.value[id] ?? 0) + 1 };
    }
    return () => {
        const next = { ...busyCounts.value };
        for (const id of ids) {
            const held = (next[id] ?? 0) - 1;
            if (held > 0) {
                next[id] = held;
            } else {
                delete next[id];
            }
        }
        busyCounts.value = next;
    };
};

const dismissNotice = (): void => {
    notice.value = undefined;
};

const dismissReceipt = (): void => {
    receipt.value = undefined;
};

// Archive the named agents, or — with no ids — every finished agent that is archivable right now (the lane
// header's "Clear"). The daemon answers with the agents that actually moved: "everything finished" cannot be
// re-derived once the lane is empty, and the summaries are what the archive list renders.
const archive = async (ids?: readonly string[]): Promise<void> => {
    // The bulk press has no ids of its own, so it borrows the lane's — otherwise "Clear" would sit silent
    // through the round-trip while the cards it is about to take carried on looking untouched.
    const release = claimBusy(ids ?? lanes.value.finished.map((agent) => agent.id));
    // A sweep is the archive with no per-card animation to vouch for it, so it is the archive that reports.
    const sweep = ids === undefined || ids.length > 1;
    try {
        const { moved, rev } = await sandboxJson<{ moved: AgentSummary[]; rev: number }>(`/agents/archive`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify(ids === undefined ? {} : { ids }),
        });
        if (moved.length === 0) {
            // A press that changed nothing always says so, however few cards it aimed at: silence is the one
            // reading the user can't distinguish from a broken button.
            receipt.value = { message: `Nothing to archive — every finished agent is already off the board.` };
            return;
        }
        // A DELTA, not the roster the daemon happens to hold now: two archives in flight would otherwise race,
        // and the slower response would put the faster one's cards back on the board. Applying only what moved
        // also means the archive list is correct without a second round-trip to re-read it — which matters most
        // for the agent detail page, whose id lookup spans both halves (agentById).
        //
        // Held as a pending move until the daemon publishes a roster at `rev`: the delta alone still lost to any
        // snapshot already in flight, which is how a just-archived card reappeared for a beat (or for good, if
        // nothing changed after it).
        const gone = new Set(moved.map((agent) => agent.id));
        holdPending(
            moved.map((agent) => ({ id: agent.id })),
            rev,
        );
        archived.value = [
            // Object.assign, not a spread — `moved` is this call's own freshly-parsed JSON.
            ...moved.map((agent) => Object.assign(agent, { open: false, unread: false })),
            ...archived.value.filter((agent) => !gone.has(agent.id)),
        ];
        // Archiving several cards in a row is ONE intent, so consecutive archives merge into one undo (see
        // `undoable`). The receipt counts that merged set rather than this press alone — it is the number the
        // Undo beside it would put back, and a receipt whose count disagrees with its own button is a lie.
        undoable.value = [...moved.map((agent) => agent.id), ...undoable.value.filter((id) => !gone.has(id))];
        archivedFlash.value += 1;
        // The archive worked, so whatever failure the strip was still holding is stale.
        notice.value = undefined;
        if (sweep) {
            const count = undoable.value.length;
            receipt.value = { message: `${count} agent${count === 1 ? `` : `s`} archived`, undo: undoArchive };
        }
    } catch (error) {
        notice.value = errorMessage(error, `Couldn't archive that.`);
    } finally {
        release();
    }
};

// Put agents back on the board — a per-card restore, and the inverse an archive's undo runs. The checkout is
// not rebuilt here (the daemon does that lazily on the agent's next turn), so this is as cheap for a hundred
// agents as for one.
const restore = async (ids: readonly string[]): Promise<void> => {
    const release = claimBusy(ids);
    try {
        const { moved, rev } = await sandboxJson<{ moved: AgentSummary[]; rev: number }>(`/agents/unarchive`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ ids }),
        });
        // The same delta, in the other direction — and held the same way, so a snapshot in flight can't take the
        // restored card straight back off the board.
        const back = new Set(moved.map((agent) => agent.id));
        archived.value = archived.value.filter((agent) => !back.has(agent.id));
        holdPending(
            moved.map((agent) => ({ id: agent.id, present: agent })),
            rev,
        );
        // What is back on the board is no longer anyone's to undo — including when the user restored it card
        // by card from the archive view rather than through the undo itself.
        undoable.value = undoable.value.filter((id) => !back.has(id));
        receipt.value = undefined;
        notice.value = undefined;
    } catch (error) {
        notice.value = errorMessage(error, `Couldn't restore that.`);
    } finally {
        release();
    }
};

// The ONE undo, so the two affordances offering it — a sweep's receipt and Mod+Z — can never come to mean
// different things. A no-op with nothing to put back, which is also what lets the keybinding stay out of the
// way of everything else Mod+Z means (see AgentsView's `when` gate).
const undoArchive = async (): Promise<void> => {
    if (undoable.value.length === 0) {
        return;
    }
    await restore(undoable.value);
};

// Resolve one agent by id across BOTH halves of the fleet. The board's roster deliberately drops archived
// agents, but a surface addressed by id — the /agents/:id detail and its review — must still find one: an
// archived agent keeps its branch, its diff and its transcript, so its detail page is a real destination and
// not a 404. (The archive half is only populated once loadArchived has run; callers that can be deep-linked
// into ask for it themselves.)
const agentById = (id: string): FleetAgent | undefined =>
    fleet.value.find((agent) => agent.id === id) ?? archived.value.find((agent) => agent.id === id);

// Rename an agent: sync the open conversation's title ref first (docked tab, detail header, and the
// localStorage tab snapshot all follow it), then write the registry through the daemon. A card with no
// registry entry is a draft — its title lives client-side and rides the next turn body — but the POST still
// fires best-effort to cover the send→first-roster-frame window where the entry exists but hasn't painted.
// Registered agents update optimistically; on failure both sides revert (re-resolved against the CURRENT
// roster — an SSE frame may have replaced it mid-flight) and the error propagates to the caller's inline UI.
const rename = async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim();
    const { conversations } = useChat();
    const conversation = conversations.value.find((candidate) => candidate.conversationId === id);
    const previousTitle = conversation?.title.value ?? null;
    if (conversation !== undefined) {
        conversation.title.value = trimmed;
    }
    const post = (): Promise<AgentSummary> =>
        sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/rename`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ title: trimmed }),
        });
    const previous = registry.value.find((agent) => agent.id === id);
    if (previous === undefined) {
        void post().catch(() => undefined);
        return;
    }
    const revertTitle = previous.title;
    previous.title = trimmed; // registry is a deep ref — the in-place write repaints the fleet
    try {
        const summary = await post();
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        // Revert on whatever the roster holds NOW — an SSE frame may have replaced the array (and `previous`).
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.title = revertTitle;
        }
        if (conversation !== undefined) {
            conversation.title.value = previousTitle;
        }
        throw error;
    }
};

// Open (or focus) an agent's conversation tab and mark it seen. Takes just the identity fields so registry
// cards and client-only draft cards both route through it.
const open = (agent: Pick<FleetAgent, "id" | "provider" | "harness" | "sessionId" | "title" | "account">): void => {
    openAgentConversation({
        id: agent.id,
        provider: agent.provider,
        harness: agent.harness,
        ...(agent.sessionId !== undefined ? { sessionId: agent.sessionId } : {}),
        ...(agent.title !== undefined ? { title: agent.title } : {}),
        ...(agent.account !== undefined ? { account: agent.account } : {}),
    });
    markSeen(agent.id);
};

export function useAgents() {
    return {
        fleet,
        lanes,
        attention,
        blocking,
        unread,
        refresh,
        open,
        markSeen,
        markAllSeen,
        rename,
        agentById,
        archived,
        archiveLoading,
        loadArchived,
        archive,
        restore,
        undoArchive,
        undoable,
        archivedFlash,
        notice,
        dismissNotice,
        receipt,
        dismissReceipt,
        busyIds,
    };
}
