import type { AgentSummary, AutomationApproval } from "@intentic/sandbox-contract";
import { errorMessage, useNow } from "@intentic/ui/async";
import { computed, effectScope, ref, shallowRef, watch } from "vue";
import { awaitingUser, blocked, type ClientAgentStatus, type FleetLane, laneOf, limited, turnInFlight, unregistered } from "./agentStatus";
import type { Conversation } from "../chat/conversation";
import { invalidateAgentTranscript } from "../chat/agentTranscript";
import { closedDrafts, forgetClosedDraft } from "../chat/closedDrafts";
import { draftPreview, drawsChat, elsewhereDrafts } from "../chat/draftEcho";
import type { StoredTab } from "../chat/tabSnapshot";
import { rememberedProviderFor } from "../chat/turnDefaults";
import { agentTabOf, type AgentTabSeed, useChat } from "../chat/useChat";
import { summonChat } from "../chat/summon";
import { commandShortcut } from "../commands/useCommands";
import { useNotifications } from "../notifications";
import { onScreen } from "../onScreen";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { useSandbox } from "../sandbox/useSandbox";
import { AGENTS } from "../queryKeys";

/* The fleet store, the daemon's agent registry mirrored into the browser. Fed two ways: the /events stream's
 * `agents` roster snapshots (last frame wins, the presence pattern, see useSandboxLiveness) and an explicit
 * refresh() from GET /agents on the reachable seam. The FLEET view merges the registry (authoritative:
 * status/branch/cost, agents this tab never opened) with the open Conversation tabs by conversationId (live:
 * in-browser streaming state). Module-level singleton, like useChat. */

// shallowRef, for the same reason Conversation.state is: every write below REPLACES this array (a roster is a
// snapshot, never a patch, see the ordering note beneath), so there is no in-place mutation for deep
// reactivity to observe. A deep ref would instead re-proxy every summary in the fleet on each snapshot, and the
// daemon re-frames the roster about once a second for every running turn, so the board's cost scaled with
// agents × turns × their fields, which is exactly when the /agents view was reported to get sticky.
const registry = shallowRef<AgentSummary[]>([]);

// The OTHER half of the fleet, the agents filed away. Declared here, beside the roster it is the counterpart
// of, because `fleet` reads it: an archived session whose tab holds unsent words is lifted back onto the board.
// What the list is, when it is read, and why it is pull-only rather than streamed is under "--- Archive" below.
//
// shallowRef for the roster's reason, which applies here twice over: every write below REPLACES this array, and
// this is the half that GROWS WITHOUT BOUND, the board's live roster is bounded by what the user is working
// on, while the archive is everything they ever finished. A deep ref re-proxied every filed-away summary on
// each write, so opening the archive on a fleet with a thousand sessions in it paid for a thousand proxies
// before it drew anything.
const archived = shallowRef<FleetAgent[]>([]);
const archiveLoading = ref(false);

/* The wakes HELD at the door, the daemon's approvals queue, projected onto the board so "waiting for you"
 * sits beside "running" instead of in a page nobody opens. Separate state from the roster on purpose: the
 * /events stream repaints `registry` and knows nothing of holds, so a stream frame must not clobber this.
 * Pull-fed by refresh() (board mount, the reachable seam, pull-to-refresh) and by the approve/reject actions
 * below, a hold appearing while the board sits open lands on the next pull.
 *
 * Declared up here rather than beside those actions for two reasons: `attention` counts it, the rail's badge
 * is the only thing that can tell an owner a wake is waiting while they are anywhere else in the app, and
 * `desync` drops it, which is what keeps one sandbox's held wakes out of another sandbox's count. */
const heldWakes = shallowRef<AutomationApproval[]>([]);

/* --- Roster ordering ----------------------------------------------------------------------------------------
 * The fleet is published as full snapshots, and THREE sources produce them: the /events stream, an explicit
 * refresh() (GET /agents), and this browser's own optimistic archive/restore. A plain full-replace lets whichever
 * lands last win regardless of when it was TRUE, which is what put an archived card back on the board and
 * bounced the user off its detail page.
 *
 * So every snapshot carries the registry revision it was read at (see AgentsListSchema), and:
 *   - a snapshot older than the one already applied is dropped outright; and
 *   - a local add/remove is held as a pending intent until a snapshot at or past the revision that APPLIED it
 *     arrives, at which point the server's own account is authoritative and the intent retires itself.
 *
 * The second rule is what a revision alone can't do: between sending an archive and the daemon applying it, an
 * unrelated change (a running turn ticks updatedAt about once a second) legitimately produces a NEWER snapshot
 * that still contains the agent. Dropping by revision would accept it; the pending intent is what keeps the card
 * off the board across that window. */

// The highest revision applied so far. -1 until the first snapshot: a fresh connection adopts whatever it is
// handed, including revision 0 from a daemon that just restarted.
let appliedRev = -1;

/* WHICH CONNECTION THE REVISION LINE BELONGS TO. The counter above is only comparable within one daemon
 * PROCESS, it lives in that process's memory and starts again at 0 when it restarts, so every reset of it
 * (desync, which the hello frame of every connection performs) opens a new line, and reads issued against the
 * old one must not land on the new. A GET /agents that left before a rebuild and answers after it carries the
 * old daemon's high-water number, and applying it would re-poison the guard the reset had just cleared: the
 * new daemon's every snapshot would be dropped as "older than what we have", which is the freeze this whole
 * mechanism exists to avoid. Reads capture the epoch they were issued in and drop their own answer if it
 * moved; frames need no such check, because a frame IS its connection. */
let epoch = 0;

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

// Every conversation in this roster is one the fleet KNOWS, so its open tab is no longer a draft, latched on
// the conversation (see Conversation.registered) rather than re-derived from the roster, because the whole
// point is to outlive the entry: archiving takes it off the roster, and so does a dropped stream.
// Latched off the server's own list, before the pending projection: a snapshot that still carries an agent
// this browser has locally archived is nonetheless proof the daemon registered it.
const latchRegistered = (agents: readonly AgentSummary[]): void => {
    const known = new Set(agents.map((agent) => agent.id));
    for (const conversation of useChat().conversations.value) {
        if (known.has(conversation.conversationId)) {
            conversation.registered.value = true;
        }
    }
};

// Retire every intent the server has now demonstrably absorbed, then re-project what remains.
const applySnapshot = (agents: AgentSummary[], rev: number): void => {
    for (const [id, move] of pending) {
        if (rev >= move.untilRev) {
            pending.delete(id);
        }
    }
    latchRegistered(agents);
    registry.value = withPending(agents);
};

// Record a local move and paint it immediately. `rev` is the revision the daemon reported for the mutation, so
// the intent survives exactly until a roster that includes it arrives, no timers, no fixed windows.
const holdPending = (moves: readonly { id: string; present?: AgentSummary }[], rev: number): void => {
    for (const move of moves) {
        pending.set(move.id, move.present === undefined ? { untilRev: rev } : { untilRev: rev, present: move.present });
    }
    registry.value = withPending(registry.value.filter((agent) => !pending.has(agent.id)));
};

/* THE SAME REMOVAL, TAKEN BEFORE THE DAEMON HAS ANSWERED, and the way back if it never does.
 *
 * Archiving is the board's one safe exit: nothing is destroyed, the branch and the conversation are kept, and
 * the counter it lands in is one press from opening. What it is NOT is quick, behind the press sit a commit
 * of whatever the worktree held, a checkout teardown and a ref park, per repo. So the press held its card in
 * place for as long as the git took, which on a board carrying a thousand sessions reads as a button that did
 * nothing, and the honest response to a button that did nothing is to press it again.
 *
 * The card therefore leaves on the press and the request runs behind it. Everything that CANNOT be taken back
 * cheaply still waits for the answer, the chat tab stays open, the archive list is written from what actually
 * moved, the undo set counts what actually moved, so a refusal costs the user a card sliding back into its
 * lane under the error strip, and nothing else.
 *
 * Held at POSITIVE_INFINITY because at this moment there is no revision to hold to: no roster may retire this
 * intent, only the answer that replaces it (holdPending at the rev that applied it) or the rollback below.
 * Returns the rollback, which puts back every card it took but the ones named `keep`, the daemon's own
 * account of what moved, since an aimed-at agent it declined is a card that must come back. */
const takeOffBoard = (ids: readonly string[]): ((keep?: ReadonlySet<string>) => void) => {
    const held = new Map(registry.value.filter((agent) => ids.includes(agent.id)).map((agent) => [agent.id, agent]));
    holdPending(
        ids.map((id) => ({ id })),
        Number.POSITIVE_INFINITY,
    );
    return (keep) => {
        const back = [...held].filter(([id]) => keep?.has(id) !== true);
        for (const [id] of back) {
            // Only ever this call's OWN unanswered intent: an overlapping press that has since re-held the same
            // id at a real revision is holding it against a roster in flight, and dropping that would let the
            // card it archived flicker back onto the board.
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

/* The review panel's diff query (the per-file landed flags behind "Land now", and the conflict report) is
 * pull-only, while this roster is push-fed, so a land this browser didn't perform itself (the auto-land at
 * turn completion, another device's manual land) used to flip the header badge to "Landed" while the panel
 * kept its pre-land answer: every file "not landed" under an armed Land now button, until a remount or a
 * window refocus happened to refetch. A status change is exactly "the daemon settled something about this
 * agent's work", so it is the diff's invalidation signal. An id this roster has never seen counts as a
 * change: the first snapshot of a (re)connection may be carrying the outcome of a turn that finished while
 * no stream was up. Unobserved queries are only marked stale, so a closed panel costs no request. */
const invalidateStaleWork = (agents: readonly AgentSummary[]): void => {
    const held = new Map(registry.value.map((agent) => [agent.id, agent.status]));
    for (const agent of agents) {
        if (held.get(agent.id) !== agent.status) {
            void queryClient.invalidateQueries({ queryKey: AGENTS.of(agent.id, `diff`) });
            /* AND THE TRANSCRIPT WITH IT, on exactly the same signal and for the same reason one step further
             * along. The daemon writes a conversation's record as each turn SETTLES, so a status change is the
             * one moment that record can have grown, and the copy this browser warmed ahead of the click was
             * read before it did. Without this the board would hand a clicked card a transcript ending one turn
             * early, which is a worse answer than the round trip it saved. */
            invalidateAgentTranscript(agent.id);
        }
    }
};

// Roster snapshot from the events stream or an explicit read. Dropped when it predates what we already hold,
// an out-of-order answer is not news, it is a regression.
export const setAgents = (agents: AgentSummary[], rev: number): void => {
    if (rev < appliedRev) {
        return;
    }
    invalidateStaleWork(agents);
    /* WHAT LEFT THE ROSTER BY ANOTHER HAND THAN THIS BROWSER'S, the daemon's retention sweep, an archive or
     * discard on another device. Local moves are excluded: they already wrote both halves, and `pending` is
     * exactly the set of them still unconfirmed. A reset board has no ids to depart, so the reconnect's first
     * snapshot stays quiet.
     *
     * It is the one signal the pull-only archive list ever gets that it changed, so it is its invalidation,
     * without it the Finished header's count (and the door it gates) kept whatever the last visit read until
     * the next one. And it takes the departed agents' CHAT TABS with it, for the same reason archiving from
     * this board does (see the archive note below): one agent is a card and a tab, and the sweep that keeps
     * the board clean was leaving the chat list to grow for the life of the sandbox. */
    const incoming = new Set(agents.map((agent) => agent.id));
    const departed = new Set(registry.value.filter((agent) => !incoming.has(agent.id) && !pending.has(agent.id)).map((agent) => agent.id));
    if (departed.size > 0) {
        void loadArchived();
        useChat().closeRetired(departed);
    }
    appliedRev = rev;
    applySnapshot(agents, rev);
    /* AND WHAT STARTED WORKING BY ANOTHER HAND THAN THIS BROWSER'S, the other half of the same reading. A
     * workflow's steps, an automation's wake, a turn sent from a phone: their tabs may already be open here,
     * opened before the turn existed and therefore showing nothing. This roster is the daemon saying the turn
     * is up, which is the moment those tabs can attach to it (useChat.attachStarted). */
    useChat().attachStarted(new Set(agents.filter((agent) => agent.status === `running`).map((agent) => agent.id)));
};

/* Drop everything that is a promise to a PARTICULAR daemon, keeping (or not) the painted roster.
 *
 * The revision always goes: the next daemon we speak to may be a restarted one whose counter began again at
 * 0, and holding onto a higher number would make us reject its every frame. Pending moves and undo offers are
 * promises about ids and revision lines that daemon may never have heard of, dropped with it.
 *
 * The roster itself is the split. A sandbox SWITCH clears it (another sandbox's agents must never paint), but
 * a mere disconnect KEEPS it: the chat list blanking for the length of a reconnect turned every stall into a
 * visible outage, and the reconnect's immediate snapshot overwrites whatever staleness survived.
 *
 * Held wakes take the roster's side of that split, not the unconditional side, and for the roster's own reason:
 * they are PAINTED (the rail's Agents badge counts them, which is the only way an owner learns a wake is waiting
 * while they are elsewhere), so blanking them for the length of a reconnect would be the same visible outage. On
 * a switch they must go, they name run ids in a workspace the reader has left, and leaving them in made the
 * tile claim work waiting in the box they had just closed. */
const desync = (keepRoster: boolean): void => {
    if (!keepRoster) {
        registry.value = [];
        heldWakes.value = [];
    }
    pending.clear();
    appliedRev = -1;
    epoch += 1;
    undoable.value = [];
    notice.value = undefined;
};
export const resetAgents = (): void => desync(false);
// The disconnect flavor: stale-while-reconnecting.
export const desyncAgents = (): void => desync(true);

// Unread tracking: an agent whose updatedAt outruns the last time it was OPENED, while no turn of its own is
// in flight, "has
// something for you". The read marker itself lives on the daemon entry (AgentSummary.seenAt), not in this
// browser, read state is a fact about the work, so clearing site data, opening an incognito window, or
// switching to the phone must not resurrect a board full of "New" badges.
//
// Writes are optimistic: stamp the roster in place (the card repaints instantly, `registry` is a deep ref),
// then persist through the daemon, whose broadcast re-lands the same value on every other connected surface.
// Best-effort: a failed write only means the badge returns on the next roster frame, and a card with no
// registry entry is a draft, nothing to mark, nothing unread.
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
// the open tabs, an open conversation the fleet has NEVER registered is a DRAFT card, so a newly created
// workspace or isolated conversation appears immediately and is replaced by its registry row at begin.
// `status` widens the wire enum with that client-only draft state; the registry wins the merge the moment the
// first turn registers the conversation.
export interface FleetAgent extends Omit<AgentSummary, "status"> {
    readonly status: AgentSummary["status"] | ClientAgentStatus;
    /* WHICH SANDBOX THIS CARD'S AGENT LIVES IN, set only when that is NOT the one the app is pointed at.
     *
     * Absent is the ordinary case and the ordinary meaning: this store's own fleet, reachable through the
     * active daemon, addressable by every action on the board. A card that carries an id came from another
     * box's roster (composables/sandbox/fleetAcross) and is on screen because the reader asked for the
     * All-sandboxes scope, so it wears that box's name and its actions are addressed by id instead.
     *
     * Optional rather than always-set, deliberately. Every existing reader of a FleetAgent is about the active
     * sandbox and stays correct by ignoring this field, and a card with no id can be handed to the chat, the
     * router and the mutation helpers exactly as before. `undefined` means "here", which is the only default
     * that leaves the common path untouched. */
    readonly sandboxId?: string;
    readonly open: boolean;
    readonly unread: boolean;
    /* The user has words in this chat that have not gone out (Conversation.unsent). A fact about an OPEN TAB in
     * THIS BROWSER, this window's own or one of its other windows' (draftEcho, which is what makes a popped-out
     * chat's composer visible to the board it is no longer beside). False for a chat being written to on
     * another device, whose composer nothing here has an account of. */
    readonly unsent: boolean;
    /* THE OPENING WORDS OF THAT UNSENT MESSAGE, read twice on the card and by two readers with different needs.
     *
     * It NAMES a card that has nothing else to be called: a draft is named by the first turn it sends, so until
     * then the message is the only name it has (AgentCard.displayTitle, where a real title outranks it).
     *
     * And it is the whole content of the unsent MARK's hover (UnsentMark), on every card that wears one — the
     * named and the nameless alike. That is why it is not confined to the untitled ones: the mark's own label
     * can only say that a message exists, and which message it is, is the thing the reader needs to decide
     * whether to go back to it.
     *
     * Absent for a chat whose unsent something is an attachment or a queued message rather than typed text. */
    readonly preview?: string;
    // When that composer first held something unsent (Conversation.draftAt), so the mark can say how long the
    // message has been standing. Absent on a tab restored from a snapshot that carried no stamp.
    readonly draftAt?: number;
}

// How many finished entries a Finished lane shows before the rest collapse behind one row. The lane's job is
// to CONFIRM what just completed, not to be the sandbox's permanent record, everything older is still one
// click away, and the daemon's retention sweep is what eventually retires it. It also keeps several hundred
// card components off screen.
export const FINISHED_WINDOW = 7;

/* The window applied, as ONE answer: the cards on screen and the number the row beneath them collapses. They
 * are computed together because they are rendered a line apart, "N earlier" miscounting the cards above is the
 * lane contradicting itself, and because of the exception below, which changes both.
 *
 * THE CARD THE USER IS READING IS NEVER CULLED. The window caps BROWSING; it is not a claim about which agents
 * exist. The board's selection ring is a cross-reference between two panes, this card is what the docked chat
 * is pointing at, so applying it to a card the lane dropped leaves the ring nowhere, and the board reads as
 * "this chat is not an agent" rather than "that card is further down". Same argument the FILTER already wins
 * (see cardsFor): hiding a card the user themselves named is the board deciding they meant a different one.
 *
 * It is pinned at the TAIL, beside the row it came from, so the lane's own recency order is otherwise intact,
 * and counted OUT of that row, which is the whole reason this is one function rather than two.
 *
 * BOTH FINISHED LANES RUN THROUGH IT, the board's, and the chat list's (ChatTabList), whose lane is the same
 * lane one card wide and grew without bound while this one stayed capped. Generic over the entry rather than
 * duplicated for it: the two lanes hold different things (fleet agents there, open chats here) and the same
 * rule, and a second copy of the pin-the-selected exception is how the two surfaces start to disagree. */
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

/* WHERE A CARD WITH NO REGISTRY ENTRY STANDS. Three answers, and the order of the tests is the whole of it:
 *   · streaming, a turn has gone but the daemon has not filed it yet, which is `starting`. NOT the wire's
 *     `running`, which this used to answer and which claims the registry's account of an agent the registry has
 *     never heard of: every guard that asks "does the daemon know this card" then said yes, so clicking one
 *     latched the tab as registered and the card left the board with nothing to replace it (see the standing's
 *     own note in agentStatus.ts);
 *   · an error, the refusal that kept it off the roster in the first place (the daemon turned the request
 *     away, so no entry was ever made): not a draft waiting to be typed into but a card for work that never
 *     started, which is what `failed` says;
 *   · a TRANSCRIPT or a session, this conversation has a past, so it was reopened from History rather than
 *     newly made. `resumed`, and the reason that standing exists: it used to answer `draft` here, which put a
 *     three-week-old chat at the head of the Active lane dressed as work about to begin.
 * Everything left is what "draft" was always meant to mean, an empty tab the user is about to type into. */
const clientStatus = (conversation: Conversation): ClientAgentStatus => {
    if (conversation.streaming.value) {
        return `starting`;
    }
    if (conversation.error.value !== null) {
        return `failed`;
    }
    return conversation.messages.value.length > 0 || conversation.session.value !== undefined ? `resumed` : `draft`;
};

/* ONE CHAT THAT WAS CLOSED WITH ITS MESSAGE STILL IN IT (chat/closedDrafts), as a card.
 *
 * Everything here comes off the tab that was set aside, because there is nowhere else to ask: the conversation
 * has no tab in any window and the daemon never registered it. That includes its BOX — a draft prepared against
 * another sandbox is still this browser's draft and belongs on this board, and the card has to carry the
 * address or opening it would ask the wrong daemon (the same rule the live draft cards state).
 *
 * `updatedAt` is when the message was first left standing, so the lanes sort it by the age its own mark
 * reports, and a card the reader has not touched for a week does not sit above this morning's work. */
const closedCard = (tab: StoredTab, unsent: UnsentTab | undefined): FleetAgent => ({
    id: tab.conversationId,
    status: tab.session === undefined ? `draft` : `resumed`,
    // A tab persisted before it had picked anything (or by a build that stored neither) still opens somewhere:
    // the same fallbacks a fresh conversation is born with, rather than a card that cannot say what it runs on.
    provider: tab.provider ?? rememberedProviderFor(),
    harness: tab.harness ?? `native`,
    updatedAt: tab.draftAt ?? 0,
    attention: { plan: false, question: false, permission: false, service: false, capability: false, conflict: false },
    // No tab anywhere: that is the whole state this card describes, and what its × forgets rather than closes.
    open: false,
    unread: false,
    unsent: true,
    preview: unsent?.preview,
    draftAt: tab.draftAt,
    // What the message will be spent on, the pick the composer was standing on when it was closed. Named for
    // the reason the live draft cards name it: a prepared message is queued work, and its model is a decision
    // the user has already made about it.
    ...(tab.model === undefined ? {} : { model: tab.model }),
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.session === undefined ? {} : { sessionId: tab.session.id }),
    ...(tab.box === undefined ? {} : { sandboxId: tab.box }),
});

/* ONE COMPOSER'S UNSENT CONTENTS, as the board reads them: the opening words of the message standing in it and
 * the instant it first held something. Both optional and for different reasons — there are no words when what is
 * unsent is an attachment or a message queued behind a running turn, and no instant on a tab restored from a
 * snapshot that predates the stamp — so every card that carries one is drawn to be true without either. */
interface UnsentTab {
    readonly preview?: string;
    readonly at?: number;
}

/* WHAT THIS BROWSER KNOWS ABOUT A TURN THE DAEMON HAS NOT FILED YET, which is the whole of what a `starting`
 * card can honestly say, and it is not nothing.
 *
 * Such a card used to be built from its four identity fields alone, so a sent turn appeared as a title under a
 * spinner and nothing else: no model, no elapsed, no reason. That is a fair drawing of an untouched draft
 * (there is nothing to say about a tab nobody has typed in) and a bad one of work in flight, because every
 * fact it was missing was sitting on the conversation the card is made of. The settings are the ones the send
 * actually went out under, the elapsed runs from the moment of the send rather than from whenever the entry
 * appears, and the usage is this tab's own running total, each of them replaced by the registry's version the
 * moment it lands.
 *
 * Zero tokens and zero cost are "nothing counted yet" rather than measurements, and a stat row of zeroes is the
 * kind of readout people learn to distrust, so they are left off until the turn's first `usage` frame. */
const startedTurnFacts = (conversation: Conversation): Partial<FleetAgent> => ({
    model: conversation.model.value,
    effort: conversation.effort.value,
    thinking: conversation.thinking.value,
    fast: conversation.fast.value,
    ...(conversation.turnStartedAt.value === undefined ? {} : { startedAt: conversation.turnStartedAt.value }),
    ...(conversation.inputTokens.value > 0
        ? { inputTokens: conversation.inputTokens.value, outputTokens: conversation.outputTokens.value }
        : {}),
    ...(conversation.costUsd.value > 0 ? { costUsd: conversation.costUsd.value } : {}),
});

// Attention first, then live turns + fresh drafts, then most recently active.
const weight = (entry: FleetAgent): number =>
    blocked(entry) ? 0 : turnInFlight(entry) || entry.status === `awaiting` || entry.status === `draft` ? 1 : 2;

const fleet = computed<FleetAgent[]>(() => {
    const { conversations } = useChat();
    const openIds = new Set(conversations.value.map((conversation) => conversation.conversationId));
    const carded = new Set(registry.value.map((agent) => agent.id));
    /* The tabs holding words that have not gone out, the one thing the daemon's roster cannot know, and the
     * reason the halves below are joined against it rather than against `openIds` alone.
     *
     * ASKED OF WHICHEVER WINDOW DRAWS THE CHAT, and of that one only (draftEcho): this window's own composers
     * while the chat is docked here, the echo from the window holding it while it is popped out. Without the
     * echo the board went blind exactly when it was the only surface left showing the work, the chat popped out
     * onto another screen and the card over here claiming there was nothing in it. Taking BOTH, which is what
     * this used to do, fails the other way round and is the bug it replaces: a window that is not drawing the
     * chat keeps its tab objects frozen at the moment the panel left, so a message sent out in the floating
     * window cleared its mark out there and left this board wearing an unsent chip for words that no longer
     * existed anywhere. */
    const elsewhere = elsewhereDrafts.value;
    const typing: ReadonlyMap<string, UnsentTab> = drawsChat.value
        ? new Map(
              conversations.value
                  .filter((conversation) => conversation.unsent.value)
                  .map((conversation): [string, UnsentTab] => [
                      conversation.conversationId,
                      { preview: draftPreview(conversation.draft.value), at: conversation.draftAt.value },
                  ]),
          )
        : new Map(
              // The publisher has already folded its previews (draftEcho), so the empty string here means the
              // same as an absent one: unsent, but an attachment or a queued message rather than typed words.
              [...elsewhere].map(([id, draft]): [string, UnsentTab] => [id, { preview: draft.preview || undefined, at: draft.at }]),
          );
    /* ...AND THE ONES NOBODY IS TYPING IN ANY MORE, because their chat was CLOSED with the message still in it
     * (chat/closedDrafts). Those words are set aside rather than destroyed, so they are as unsent as the ones
     * in an open composer, and the card is the only way back to them: it wears the mark, it is named by the
     * message, and opening it puts the words back where they were written.
     *
     * Merged UNDER the composers above, which is the direction that cannot go stale: an entry is taken out the
     * moment its chat is reopened, so the only way to hold both is a window that reopened one without this one
     * hearing yet, and in that race the live composer is the account being typed into. */
    const unsent: ReadonlyMap<string, UnsentTab> = new Map([
        ...closedDrafts.value.map((tab): [string, UnsentTab] => [tab.conversationId, { preview: draftPreview(tab.draft), at: tab.draftAt }]),
        ...typing,
    ]);
    // A draft is a conversation the fleet has never heard of. NOT one that is merely absent from the live
    // roster, which is also true of every agent the user has archived and of every agent at all while the
    // events stream is down. `carded` is the join's own guard: an id the registry half already rendered must
    // not be rendered a second time by this one, whatever the latch says.
    const drafts = conversations.value
        .filter((conversation) => !conversation.registered.value && !carded.has(conversation.conversationId))
        .map((conversation): FleetAgent => {
            /* WHAT THE CARD IS CALLED BEFORE ANYTHING HAS NAMED IT: the opening words of the message waiting in
             * its composer, read from this window's own conversation, or from the window holding the chat panel
             * when that is another one. A board of drafts otherwise says "New agent" as many times as there are
             * cards, at the one moment the reader is trying to tell them apart.
             *
             * The same source as the mark, never a fallback from one to the other: a stale local draft is exactly
             * as wrong as a name as it is as a mark, so both come out of the one join above. That is also what
             * turns "unsent, but an attachment rather than words" into no name at all: such a card wears the mark
             * and keeps its "New agent". */
            const tab = unsent.get(conversation.conversationId);
            const draft: FleetAgent = {
                id: conversation.conversationId,
                status: clientStatus(conversation),
                provider: conversation.provider.value,
                harness: conversation.harness.value,
                updatedAt: 0,
                attention: { plan: false, question: false, permission: false, service: false, capability: false, conflict: false },
                open: true,
                unread: false,
                unsent: tab !== undefined,
                preview: tab?.preview,
                draftAt: tab?.at,
                /* WHERE THIS DRAFT WILL RUN, when it is not here. A tab aimed at another sandbox
                 * (Conversation.box) is still a draft in THIS browser and belongs on this board, since a draft
                 * exists nowhere else, but the card has to carry the box or every action on it would address
                 * the wrong daemon and its chip would claim work about to happen somewhere else. From its first
                 * turn on, the card comes from that box's own roster instead (fleetScope.otherFleet), which is
                 * what the ack-time registration latch hands over (Conversation.latchRemoteRegistration). */
                ...(conversation.box.value === undefined ? {} : { sandboxId: conversation.box.value }),
            };
            if (conversation.title.value !== null) {
                draft.title = conversation.title.value;
            }
            // The session a RESUMED card stands for. Named here so nothing else reports it a second time: the
            // board's search lists conversations no card carries ("In earlier chats"), and without this the
            // chat the user just opened from that very list went on being offered underneath its own card.
            if (conversation.session.value !== undefined) {
                draft.sessionId = conversation.session.value.id;
            }
            /* Everything this browser knows about a turn already in flight (startedTurnFacts). Only for
             * `starting`: on an untouched draft those fields would describe a turn that has not happened, and
             * on a `resumed` card the composer's current picks are not an account of the conversation's past. */
            if (draft.status === `starting`) {
                Object.assign(draft, startedTurnFacts(conversation));
            }
            /* WHAT A PREPARED DRAFT WILL RUN ON, which is the one of those facts that is already true before the
             * send. A message standing in a composer is queued work, and the model it will be spent on is a
             * decision the user has already made about it, so the card names it — read from the same
             * conversation the words themselves come from, and so on the same tick the pick is made rather than
             * after a reload.
             *
             * Gated on there being something unsent, which is the line between the two kinds of draft: a card
             * for a tab nobody has typed in is a placeholder for work not yet described, and naming a model on
             * it would put a spend on the board for a turn nobody has decided to take. */
            if (draft.status === `draft` && tab !== undefined) {
                draft.model = conversation.model.value;
            }
            return draft;
        });
    /* ARCHIVED, AND BACK ON THE BOARD ANYWAY, the sessions the user has started writing in.
     *
     * Reading an agent out of the archive opens its chat by design, and typing there is the most ordinary thing
     * to do next. But the board had no card for it (the roster drops archived agents), so clearing the search
     * that found it left the half-written message with nowhere to be seen from, the user's own words, filed
     * away under a query they no longer remember. It is lifted for exactly as long as the words are there and
     * files itself back the moment they are sent or cleared.
     *
     * NOTHING IS WRITTEN. Typing does not un-archive, re-register, or touch the entry's recency, the daemon's
     * account of this agent is the same before and after. The card is a view of an open tab, no more, and it
     * says "archived" on its face (AgentCard reads archivedAt) so it can't be mistaken for live work. */
    const held: FleetAgent[] = [];
    const archivedIds = new Set(archived.value.map((agent) => agent.id));
    for (const agent of archived.value) {
        const tab = unsent.get(agent.id);
        if (tab !== undefined && !carded.has(agent.id)) {
            // A COPY, never the archive list's own entry: `unsent` is true of the words this browser is holding
            // and not of the filed-away agent, and writing it onto the stored row would leave the archive
            // claiming it long after they are sent. The words and the age ride along for the same reason: they
            // describe the composer, not the filed-away agent. `open` is asked of the strip rather than assumed,
            // since the message may be one a close set aside, which has no tab anywhere (closedDrafts).
            held.push({ ...agent, open: openIds.has(agent.id), unsent: true, preview: tab.preview, draftAt: tab.at });
        }
    }
    /* A CHAT THAT IS NOTHING BUT ITS UNSENT MESSAGE, closed with the words in it and never registered, so no
     * roster row, no archive entry and no open tab draws it. Without this the fleet's own rule ("a draft is a
     * conversation the fleet has never heard of") would quietly except the drafts most worth keeping: the ones
     * whose tab is gone are exactly the ones nothing else can show.
     *
     * It stands where the tab stood, `draft` unless the chat had a session behind it, in which case reopening
     * it resumes rather than begins (the same reading clientStatus takes of a live tab). */
    const setAside = closedDrafts.value
        .filter((tab) => !openIds.has(tab.conversationId) && !carded.has(tab.conversationId) && !archivedIds.has(tab.conversationId))
        .map((tab): FleetAgent => closedCard(tab, unsent.get(tab.conversationId)));
    return [
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
});

/* THE BOARD'S SECOND HAND, and the only reason this store needs one at all.
 *
 * Every other lane rule is a pure function of a roster frame: a card moves because the daemon said something
 * about it. A spent allowance is the first that moves because TIME PASSED and nothing else, the window the
 * provider named reopens and the card owes a press it did not owe a second earlier. Without a tick, the lanes
 * and the badge would be right whenever a frame happened to arrive and stale in between, which on a quiet board
 * (nothing running, so nothing framing) is exactly the situation this is for.
 *
 * ARMED ON THE ROSTER, NOT ON THE CLOCK, which is what keeps it from chasing its own tail: the gate asks
 * whether any card is stranded on an allowance at all, a question a roster frame answers, and never whether one
 * has reopened, which is the question the tick exists to re-ask. On a board with none, and that is nearly every
 * board, `useNow` runs no interval and this costs nothing.
 *
 * A DETACHED SCOPE, like shellModelPicking's: this is app-lifetime state in a module singleton, and `useNow`
 * registers its disposal with whatever scope is current. Owned by the first component that happened to read the
 * store, the timer would be torn down when that component unmounted and the board would silently stop moving. */
const boardScope = effectScope(true);
// `run()` only answers undefined for a STOPPED scope, and this one is never stopped.
const boardNow = boardScope.run(() => useNow(() => fleet.value.some(limited)))!;

// The board's two headline counts, kept apart on purpose (the header renders both): agents BLOCKED on the
// user, and agents merely unread.
const blocking = computed(() => fleet.value.filter((agent) => blocked(agent, boardNow.value)).length);
const unread = computed(() => fleet.value.filter((agent) => agent.unread).length);
/* The single aggregate the rail tile and mobile tab badge render, "there is something for you on the board",
 * counted per AGENT so one that is both blocked and unread badges once.
 *
 * HELD WAKES COUNT TOO, and they are the reason this is not just a filter over the fleet. An automation set to
 * require approval fires at 3am and parks a wake in the queue; the board has always shown it in the Attention
 * lane, but the rail stayed silent, so the one surface visible from every other area said nothing was owed. A
 * hold is not an agent, it has no conversation, no transcript and no turn until it is approved, which is
 * exactly why it needs the badge: nothing else about it is on screen. */
const attention = computed(
    () => fleet.value.filter((agent) => blocked(agent, boardNow.value) || agent.unread).length + heldWakes.value.length,
);

// A turn that finishes while you are WATCHING its conversation is not news, the reply is already on your
// screen, so the card must not flip to "New" under your cursor (and the rail must not badge it). Gated on THIS
// window being on screen with that chat focused (onScreen.ts); a floating chat runs its own copy of the app and
// answers the same question for itself. An agent that finishes with the window hidden, a background tab, a
// locked phone, is exactly what the badge exists for, even though its conversation is still technically the
// active one.
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

/* An open conversation adopts the roster's name for it.
 *
 * A tab seeds its title once, at open (openAgentConversation), and then owns it, which held while the only
 * thing that ever renamed a conversation was the user typing on this device. It no longer does: the daemon
 * promotes a title on its own when a plan names the job the opening prompt only hinted at, and a rename from
 * the phone has always had to reach the desktop. The registry is the authority, so a tab follows it.
 *
 * Following it UNCONDITIONALLY is what makes this safe rather than a race: the daemon refuses every promotion
 * that would overwrite a rename (see promoteTitle), so a title arriving here has already been judged better
 * than the one it replaces, and the browser needs no second opinion. Renames stay instant because rename()
 * writes the registry entry optimistically before it posts, this watch sees the new name on the tick the
 * user typed it, not a round trip later.
 *
 * The roster ARRAY is replaced on every frame it pushes, usage counters tick several times a second through a
 * running turn, so its identity says nothing about whether a title moved, and reconciling on it directly would
 * walk every open tab several times a second to write nothing. The filter below is what makes that cheap. */
const appliedTitles = new Map<string, string | undefined>();

/* Did any entry's title move since the last frame? A map lookup per entry and NO allocation in the steady
 * state, which is the whole point: this replaces a change key built by allocating a string per agent and
 * joining them on every roster frame, to catch a change that happens a handful of times per conversation.
 *
 * A SHRUNKEN roster is the one thing a per-entry sweep cannot see, so it is settled by the count, and the
 * rebuild that follows runs when an agent actually leaves the fleet, never on the usage frames that are almost
 * all of this traffic. A reset (the registry emptied) lands here too and leaves the memo correctly empty. */
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
        // An entry with no title yet (a turn that has not begun) must not blank a tab that named itself.
        if (agent.title !== undefined && conversation !== undefined && conversation.title.value !== agent.title) {
            conversation.title.value = agent.title;
        }
    }
});

/* May this card be archived from the board? NOT the same question as "is it in the Finished lane", which is
 * what the affordance used to be gated on, and the gate that left an errored agent with no exit at all: its
 * only offered drop is a land onto Finished, so a turn that failed with nothing landable sat in Attention
 * permanently, un-archivable because it wasn't finished and unable to finish because there was nothing to land.
 *
 * The daemon is the wrong thing to mirror here too. Its `archivable()` (agents/archive.ts) is the guard on the
 * UNATTENDED retention sweep, which is properly conservative; the named-id archive this button calls takes
 * anything that exists and isn't mid-turn. So the real question is a product one, would archiving DISCARD
 * something the agent is still waiting on?, and that is `awaitingUser`:
 *   · running/stopping, no (the worktree is the live turn's working state, right through the unwind of a
 *                       Stop; the daemon refuses it too)
 *   · draft        , no registry entry to archive
 *   · awaiting/plan/question/permission, archiving would bury the question instead of answering it
 *   · error/conflict/stopped. YES: a dead end is exactly what wants taking off the board
 *   · landed/idle  , yes, the routine case */
export const canArchive = (agent: Pick<FleetAgent, "status" | "attention" | "archivedAt">): boolean =>
    agent.archivedAt === undefined && !unregistered(agent.status) && !turnInFlight(agent) && !awaitingUser(agent);

/* THE LAST WORD IN EVERY LANE'S ORDER, and the only thing it is for: a comparator that can return 0 hands the
 * tie to the input order, and this board's input is `fleet`, re-sorted by `updatedAt` descending on every
 * frame. That clock ticks per agent, a second at a time and out of step with the others, so a tie is not a
 * settled draw but a coin flipped again every second: tied cards traded places in the column for as long as
 * they ran.
 *
 * Ties are not the exotic case they sound like. Agents resumed TOGETHER, a batch that came back after one
 * credential renewal, begin within the same millisecond and carry the same `startedAt` for the rest of the
 * turn, which is exactly the report this fixes.
 *
 * The id is arbitrary and that is fine: the requirement is not a meaningful order for cards nothing else
 * distinguishes, it is the SAME order next frame. */
const byId = (a: FleetAgent, b: FleetAgent): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/* THE BOARD'S THREE LANES OUT OF A FLAT LIST, as a function of the list rather than of this store's own fleet.
 *
 * Taken out of the computed below so that the ALL-SANDBOXES board can put the same rule over a wider set: its
 * cards are this sandbox's fleet plus the summaries read from every other box (composables/sandbox/fleetAcross),
 * and the whole point of that board is that a card sorts by what it needs, never by which machine it is on. A
 * second copy of these comparators over there would be a board whose columns order differently depending on
 * which scope you were in, which is the one thing a scope control must not change. */
export const laneGroups = (agents: readonly FleetAgent[], now: number = Date.now()): Record<FleetLane, FleetAgent[]> => {
    const grouped: Record<FleetLane, FleetAgent[]> = { attention: [], active: [], finished: [] };
    for (const agent of agents) {
        grouped[laneOf(agent, now)].push(agent);
    }
    /* Fresh drafts lead the active lane (they're what the user just created). Below them, order by startedAt,
     * a turn's start is FIXED for its whole life, so a running agent holds its slot instead of jumping to the
     * top on every activity frame (updatedAt ticks every second, which churns the lane when many run at once).
     * Oldest-running leads; a draft has no startedAt, so it falls back to updatedAt but is already sorted ahead.
     *
     * AND WORK IN FLIGHT OUTRANKS WORK THAT IS WAITING, which the startedAt reading alone gets backwards. A
     * card parked on a watch or a shut allowance window has no `startedAt` at all, so it falls back to an
     * `updatedAt` that stopped moving when its turn ended — which is OLDER than any running turn's start, so
     * every waiting card sorted above every working one. On a board that hit an account-wide wall, that is the
     * whole lane: five cards doing nothing, above the three that are. Both halves keep their own order within
     * the split, so nothing else about this changes. */
    grouped.active.sort(
        (a, b) =>
            Number(b.status === `draft`) - Number(a.status === `draft`) ||
            Number(turnInFlight(b)) - Number(turnInFlight(a)) ||
            (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt) ||
            byId(a, b),
    );
    grouped.attention.sort((a, b) => b.updatedAt - a.updatedAt || byId(a, b));
    /* UNSENT FIRST, then ready-to-land, then recency. Both exceptions are the same argument, made about the
     * fold: this lane windows to a handful (FINISHED_WINDOW), and recency alone lets whatever finished a minute
     * ago push either kind of card behind it, where "waiting for you" quietly becomes "forgotten".
     *
     * A ready card is owed a press. An UNSENT one is owed a sentence, and it goes first because it is the more
     * easily lost of the two: the press is on a card the daemon will keep offering for as long as the branch
     * exists, while the half-written message lives in this window alone. Ordering them this way is also what
     * makes the promise cheap to keep, a card holding words the user wrote can only fall behind the fold when
     * MORE THAN A WINDOW'S WORTH of such cards exist, at which point they are hiding each other rather than
     * being hidden by unrelated work. */
    grouped.finished.sort(
        (a, b) =>
            Number(b.unsent) - Number(a.unsent) ||
            Number(b.status === `ready`) - Number(a.status === `ready`) ||
            b.updatedAt - a.updatedAt ||
            byId(a, b),
    );
    return grouped;
};

const lanes = computed<Record<FleetLane, FleetAgent[]>>(() => laneGroups(fleet.value, boardNow.value));

/* Explicit registry pull, the reachable seam and pull-to-refresh use it; steady-state updates ride /events.
 *
 * Exported as `refreshAgents` for sandboxScope, which calls it on the seam where a switch lands. The roster
 * itself needs no such help, the new daemon's stream frames one on connect, but HELD WAKES do, for the
 * reason they are separate state at all: the stream knows nothing of holds, so this read is the only thing
 * that ever fills them. A switch drops them (desync) and without this they would stay dropped until someone
 * opened the board, which is exactly the surface the rail's badge exists to save them from having to open. */
export const refreshAgents = async (): Promise<void> => refresh();

const refresh = async (): Promise<void> => {
    const issuedAt = epoch;
    try {
        const body = await sandboxJson<{ agents: AgentSummary[]; rev: number; held?: AutomationApproval[] }>(`/agents`);
        // Answered on a revision line nobody is on any more, the daemon this read left for has since been
        // replaced (see `epoch`). Its number would land as a high-water mark the successor cannot beat.
        if (issuedAt !== epoch) {
            return;
        }
        // Through setAgents, not a raw assignment: this read races the stream, and a slow one that started
        // before the newest frame must not be allowed to undo it.
        setAgents(body.agents, body.rev);
        heldWakes.value = body.held ?? [];
    } catch {
        // Leave the last roster; the events stream repaints on reconnect.
    }
};

/* COMING BACK TO THE APP RE-READS THE BOARD.
 *
 * Steady state is pushed and needs nothing: the daemon frames a roster as agents start, park and finish. The
 * gap is at the EDGES of that, a laptop that slept, a phone whose tab was evicted from the foreground, a
 * stream that half-opened and died without a FIN. The connection heals itself, but only once the watchdog has
 * noticed the silence, and until then the board sits showing the moment the user walked away from. Someone
 * looking at it again is the one signal that the delay is now being WATCHED, so it is answered with a read
 * rather than waited out.
 *
 * Asked of this window (onScreen.ts), which every window of the app does for itself. Gated on the daemon being
 * reachable: with the stream down this would fail anyway, and the reconnect brings its own roster with it. One
 * request per return, not per second; a refresh that fails leaves the roster exactly where it stood.
 *
 * Module scope, like the unread watch above: this is a fact about the SESSION, not about whether the board
 * happens to be the open route, the rail's badge is drawn from the same roster on every page in the app. */
const { reachable } = useSandbox();
watch([onScreen, reachable] as const, ([looking, live], [wasLooking]) => {
    if (looking && !wasLooking && live) {
        void refresh();
    }
});

/* Release or drop a held wake, the automations routes' own verbs, so the board and any other surface cannot
 * come to mean different things by the same press. The entry leaves the list optimistically (the daemon
 * removes it before the detached turn runs); the trailing refresh() repaints whatever else moved. */
const releaseHeld = async (id: string, verb: `approve` | `reject`): Promise<void> => {
    await sandboxJson(`/automations/pending/${encodeURIComponent(id)}/${verb}`, { method: `POST` });
    heldWakes.value = heldWakes.value.filter((entry) => entry.id !== id);
    void refresh();
};

/* --- Archive ---------------------------------------------------------------------------------------------
 * The board's exit. Archiving takes an agent off the lanes and reclaims its worktree checkout, keeping the
 * branch, the transcript and every counter, so it is the ROUTINE action (no confirmation, undoable, bulk),
 * and discard stays the destructive one. See the daemon's agents/archive.ts for what it actually costs.
 *
 * Archived agents are absent from the roster the /events stream carries, which is the point: the board's live
 * state stays the size of the work in flight. The list is PULL-ONLY instead, read where something can have
 * changed it: at the board's mount, when the archive is opened, when the active daemon (re)appears
 * (sandboxScope's reachable watch, a daemon that just booted may have filed agents away itself), and when an
 * id leaves the roster by another hand than this browser's (see setAgents).
 *
 * Archiving TAKES THE AGENT'S CHAT TAB WITH IT. One agent is one thing under two skins, a card on the board and
 * a tab in the strip, so filing it away has to move both, or the strip keeps a row for work the board says is
 * over and the user is left closing everything twice. Nothing is lost with the tab: the transcript, the branch
 * and the diff all survive daemon-side, and opening the agent from the archive brings the tab straight back.
 *
 * The undo does NOT reopen what it closed. It puts the CARD back, which is the thing the archive took away,
 * and opening a chat is the user's own action, one click from the restored card. Reopening tabs on the user's
 * behalf would also have to guess which of a swept dozen were open before, and be wrong about most of them.
 *
 * A tab CAN still show an archived agent: reading one from the archive view opens it by design, and a follow-up
 * message un-archives it (see the daemon's registry.begin). Such a tab says what it is, with the way back on it
 * (ChatTabs, ChatPanel), and if the user has started WRITING in it, its card comes back to the board for as
 * long as those words are there (see `fleet`).
 *
 * The two refs the list lives in are declared far above, next to the roster, because `fleet` reads them. */

// A sandbox SWITCH is the one thing the archive list must not survive: another daemon's archive on this board
// would offer restores of agents this one has never heard of. Deliberately NOT folded into resetAgents, that
// also runs on every stream failure, and blanking the count (and the archive door it gates) on a network blip
// is a disappearing button; the last list is better company for a reconnect than an empty one, and the
// reachable seam re-reads it the moment the daemon answers again.
export const resetArchive = (): void => {
    archived.value = [];
};

/* CONCURRENT CALLERS ARE THE NORMAL CASE, so they share one request. The reachable seam asks for this list, and
 * so does every mounted chat pane's own reachable watch, a three-pane split therefore asked four times in the
 * same flush, and each answer replaced the array and repainted every reader of it. They all want the same list
 * at the same instant, which is exactly what one shared promise is.
 *
 * Only for the length of the flight: a caller arriving after it settles is asking a new question (the daemon
 * archives on its own, a boot sweep, a retention pass), and gets its own request. */
let archiveInFlight: Promise<void> | undefined;

export const loadArchived = async (): Promise<void> => {
    archiveInFlight ??= (async () => {
        archiveLoading.value = true;
        try {
            const body = await sandboxJson<{ agents: AgentSummary[] }>(`/agents/archived`);
            // Widened to FleetAgent here rather than at render: an archived agent has nothing unread by
            // construction (it left the board), and the archive list's own rows are drawn for agents that are
            // not open, the one archived agent that IS open, because the user is writing in it, is rebuilt by
            // `fleet` with those two fields answered live. Object.assign, not a spread, this array is this
            // call's own freshly-parsed JSON.
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

/* --- What an archive says ------------------------------------------------------------------------------------
 * Feedback proportional to consequence. Archiving is the action a user performs dozens of times a session, and
 * it is lossless (branch, transcript and counters all stay), so what it says has to be worth what it costs:
 *
 *   · ONE card archived → nothing. The card visibly leaves its lane and the Finished header's archive counter
 *     ticks up, so a strip that repeats the animation is chrome paid for on every press and read on none. It
 *     also SHIFTED the board, which is how a routine action came to feel like an interruption.
 *   · A BULK sweep      → a receipt, because the thing that vouches for a single archive, watching the card
 *     go, is exactly what clearing twelve at once denies you. It floats over the board instead of shifting
 *     it, and it retires itself.
 *   · A FAILURE         → the persistent strip. An error has to be read, so it must not expire on a timer.
 *
 * None of them OWNS the undo. The way back is a fact about the store (`undoable`), so Mod+Z reaches the last
 * archive whether a receipt was ever raised or has long since faded.
 *
 * THE RECEIPT IS THE APP'S, NOT THE BOARD'S. This module used to keep a second copy of the whole idea — its own
 * `FleetReceipt` type, its own ref, and a pill in AgentsView with its own dwell timer and its own transition
 * CSS — sitting forty lines from the shared one it was cloned from and drifting from it. There is one receipt
 * channel now (composables/notifications.ts) and this reports into it like every other completion in the app. */

// The board's must-read strip: an action that failed (a drop, an archive, a restore). No timer, an error the
// user never saw is one that surprises them later. In flow, in the board's own column: it is about THIS view
// and it waits to be read, which is the two things the floating lane is not for.
const notice = ref<string | undefined>(undefined);

const { say } = useNotifications();

// What the Undo beside a sweep's receipt says on hover. Mod+Z does the same thing from anywhere on the board,
// and a user who learns it from the tooltip stops needing the button.
const undoHint = (): string => {
    const shortcut = commandShortcut(`agents.undoArchive`);
    return shortcut === undefined ? `Put them back on the board` : `Put them back on the board (${shortcut})`;
};

// The ids an undo would put back. Consecutive archives MERGE: clicking down the Finished lane is one intent,
// and a stack remembering only the newest press would silently drop the way back to everything before it,
// which is the whole reason archiving is allowed to skip its confirmation. Unbounded in time on purpose: undo
// means "undo what I did", and putting a card back costs no more than taking it off did.
const undoable = ref<readonly string[]>([]);

// Bumped by every archive that moved something, the ambient signal the archive counter pulses on. A counter
// rather than a flag because it is the EVENT that matters: two archives in a row owe the user two pulses.
const archivedFlash = ref(0);

// Which cards are mid-action. A COUNTER per id, not a list: archiving is something the user does card by card
// as fast as they can click, so two calls overlap constantly, and a shared "the ids in flight" ref meant the
// first one to finish cleared the second one's spinner, the card went quiet while its request was still open.
// Each call now releases only what it claimed.
const busyCounts = ref<ReadonlyMap<string, number>>(new Map());
const busyIds = computed(() => [...busyCounts.value.keys()]);
const claimBusy = (ids: readonly string[]): (() => void) => {
    const claimed = new Map(busyCounts.value);
    for (const id of ids) {
        claimed.set(id, (claimed.get(id) ?? 0) + 1);
    }
    busyCounts.value = claimed;
    return () => {
        const next = new Map(busyCounts.value);
        for (const id of ids) {
            const held = (next.get(id) ?? 0) - 1;
            if (held > 0) {
                next.set(id, held);
            } else {
                next.delete(id);
            }
        }
        busyCounts.value = next;
    };
};

const dismissNotice = (): void => {
    notice.value = undefined;
};

// Archive the named agents, or, with no ids, every finished agent that is archivable right now (the lane
// header's "Clear"). The daemon answers with the agents that actually moved: "everything finished" cannot be
// re-derived once the lane is empty, and the summaries are what the archive list renders.
const archive = async (ids?: readonly string[]): Promise<void> => {
    // The bulk press has no ids of its own, so it borrows the lane's, the Finished lane IS the archivable set
    // (it is landed-or-idle by construction), so this is the same set the daemon will pick, and any card it
    // declines is handed back by the rollback below.
    const aimed = ids ?? lanes.value.finished.map((agent) => agent.id);
    const release = claimBusy(aimed);
    // A sweep is the archive with no per-card animation to vouch for it, so it is the archive that reports.
    const sweep = ids === undefined || ids.length > 1;
    // The cards leave here, not on the answer, see takeOffBoard for why, and for what `restore` puts back.
    const restore = takeOffBoard(aimed);
    try {
        const { moved, failed, rev } = await sandboxJson<{ moved: AgentSummary[]; failed: { id: string; reason: string }[]; rev: number }>(
            `/agents/archive`,
            jsonBody(`POST`, ids === undefined ? {} : { ids }),
        );
        /* WHAT THE DAEMON REFUSED, said in its own words, on the strip that does not expire. Releasing a working
         * copy is git work and it can fail for good (the repository behind a checkout was deleted from the
         * workspace, a checkout is locked), and those cards stay on the board. This branch is the fix to the
         * report that sent people here: a refusal answered 200 with nothing moved, so the board read it as
         * "there was nothing to archive" and said so, about the very card the user was looking at, every press,
         * with the reason nowhere but the daemon's log. */
        if (failed.length > 0) {
            const first = failed[0];
            notice.value =
                failed.length === 1
                    ? `Couldn't archive that one: ${first?.reason ?? `its working copy could not be released`}`
                    : `Couldn't archive ${failed.length} of them: ${first?.reason ?? `their working copies could not be released`}`;
        }
        if (moved.length === 0) {
            // A press that changed nothing always says so, however few cards it aimed at: silence is the one
            // reading the user can't distinguish from a broken button. And every card it took on spec goes back,
            // because "nothing moved" is exactly the case the optimistic removal guessed wrong about. The
            // "already off the board" reading belongs to the press that found nothing to do and NOTHING ELSE:
            // a refusal has already said its piece above, and it would be contradicted by it.
            restore();
            if (failed.length === 0) {
                say(`Nothing to archive, every finished agent is already off the board.`);
            }
            return;
        }
        // A DELTA, not the roster the daemon happens to hold now: two archives in flight would otherwise race,
        // and the slower response would put the faster one's cards back on the board. Applying only what moved
        // also means the archive list is correct without a second round-trip to re-read it, which matters most
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
        // …and the rest of what the press aimed at comes back: the removal was taken on spec, and this is the
        // daemon's account of which of it was right.
        restore(gone);
        archived.value = [
            // Object.assign, not a spread, `moved` is this call's own freshly-parsed JSON.
            ...moved.map((agent) => Object.assign(agent, { open: false, unread: false, unsent: false })),
            ...archived.value.filter((agent) => !gone.has(agent.id)),
        ];
        // Archiving several cards in a row is ONE intent, so consecutive archives merge into one undo (see
        // `undoable`). The receipt counts that merged set rather than this press alone, it is the number the
        // Undo beside it would put back, and a receipt whose count disagrees with its own button is a lie.
        undoable.value = [...moved.map((agent) => agent.id), ...undoable.value.filter((id) => !gone.has(id))];
        archivedFlash.value += 1;
        // The board and the strip are two views of one fleet, so the cards that just left take their tabs with
        // them (see the archive note above). Driven off `moved` like every other effect here: a press that aimed
        // at an agent the daemon declined to archive must not close its chat.
        useChat().closeTabs(gone);
        // The archive worked, so whatever failure the strip was still holding is stale, unless THIS press is
        // what put it there: a mixed answer (nine cards away, one refused) has to keep the sentence about the
        // one that stayed, which is the only card on the board the user still has a question about.
        if (failed.length === 0) {
            notice.value = undefined;
        }
        if (sweep) {
            const count = undoable.value.length;
            say(`${count} agent${count === 1 ? `` : `s`} archived`, undoArchive, undoHint());
        }
    } catch (error) {
        // The press failed, so the cards it took slide back into their lane, under the strip that says why.
        restore();
        notice.value = errorMessage(error, `Couldn't archive that.`);
    } finally {
        release();
    }
};

// Put agents back on the board, a per-card restore, and the inverse an archive's undo runs. The checkout is
// not rebuilt here (the daemon does that lazily on the agent's next turn), so this is as cheap for a hundred
// agents as for one.
const restore = async (ids: readonly string[]): Promise<void> => {
    const release = claimBusy(ids);
    try {
        const { moved, rev } = await sandboxJson<{ moved: AgentSummary[]; rev: number }>(`/agents/unarchive`, jsonBody(`POST`, { ids }));
        // The same delta, in the other direction, and held the same way, so a snapshot in flight can't take the
        // restored card straight back off the board.
        const back = new Set(moved.map((agent) => agent.id));
        archived.value = archived.value.filter((agent) => !back.has(agent.id));
        holdPending(
            moved.map((agent) => ({ id: agent.id, present: agent })),
            rev,
        );
        // What is back on the board is no longer anyone's to undo, including when the user restored it card
        // by card from the archive view rather than through the undo itself.
        undoable.value = undoable.value.filter((id) => !back.has(id));
        say(`${back.size} agent${back.size === 1 ? `` : `s`} back on the board`);
        notice.value = undefined;
    } catch (error) {
        notice.value = errorMessage(error, `Couldn't restore that.`);
    } finally {
        release();
    }
};

/* Empty the archive, the fleet's ONE irreversible action, and the reason the archive is a filing cabinet
 * rather than a one-way door: every other exit on this board keeps the branch, so without this the only way to
 * ever get rid of an agent was to discard it card by card before it was archived.
 *
 * Everything about it is the inverse of `archive`'s grammar, and deliberately so:
 *   · it CONFIRMS first (the view's dialog), there is no undo to fall back on
 *   · it always reports, even for one agent, and the receipt carries NO Undo. The missing button is the honest
 *     signal that this press was not like the archiving that precedes it
 *   · `undoable` is cleared of what went: an undo that names a deleted agent would fail on the round trip, and
 *     Mod+Z promising work back that no longer exists is worse than not offering it
 * The daemon answers with what it actually deleted, so an agent whose teardown failed stays in the list and is
 * counted out of the report rather than vanishing from a board that never removed it. */
const purgeArchived = async (): Promise<void> => {
    const aimedAt = archived.value.length;
    const release = claimBusy(archived.value.map((agent) => agent.id));
    try {
        const { removed } = await sandboxJson<{ removed: string[] }>(`/agents/purge`, { method: `POST` });
        const gone = new Set(removed);
        archived.value = archived.value.filter((agent) => !gone.has(agent.id));
        undoable.value = undoable.value.filter((id) => !gone.has(id));
        // A tab reading a deleted agent has nothing left to read: its branch, its worktree and its conversation
        // are gone. Same rule as archiving, which closes them for the far gentler reason.
        useChat().closeTabs(gone);
        /* ...and the ONE thing a close normally keeps goes too (chat/closedDrafts). Setting a message aside is a
         * promise that the chat can be opened again on it, and after this press there is no chat: the entry
         * would come back as a card for a conversation the daemon has deleted, offering to resume a session
         * that no longer exists. This is the fleet's one irreversible press, and it is irreversible here too. */
        for (const id of gone) {
            forgetClosedDraft(id);
        }
        notice.value =
            removed.length < aimedAt ? `Deleted ${removed.length} of ${aimedAt} archived agents, the rest are still in use and stayed.` : undefined;
        say(`${removed.length} archived agent${removed.length === 1 ? `` : `s`} deleted`);
    } catch (error) {
        notice.value = errorMessage(error, `Couldn't delete the archive.`);
    } finally {
        release();
    }
};

// The ONE undo, so the two affordances offering it, a sweep's receipt and Mod+Z, can never come to mean
// different things. A no-op with nothing to put back, which is also what lets the keybinding stay out of the
// way of everything else Mod+Z means (see AgentsView's `when` gate).
const undoArchive = async (): Promise<void> => {
    if (undoable.value.length === 0) {
        return;
    }
    await restore(undoable.value);
};

// Resolve one agent by id across BOTH halves of the fleet. The board's roster deliberately drops archived
// agents, but a surface addressed by id, the /agents/:id detail and its review, must still find one: an
// archived agent keeps its branch, its diff and its transcript, so its detail page is a real destination and
// not a 404. (The archive half is only populated once loadArchived has run; callers that can be deep-linked
// into ask for it themselves.)
const agentById = (id: string): FleetAgent | undefined =>
    fleet.value.find((agent) => agent.id === id) ?? archived.value.find((agent) => agent.id === id);

// Rename an agent: sync the open conversation's title ref first (docked tab, detail header, and the
// localStorage tab snapshot all follow it), then write the registry through the daemon. A card with no
// registry entry is a draft, its title lives client-side and rides the next turn body, but the POST still
// fires best-effort to cover the send→first-roster-frame window where the entry exists but hasn't painted.
// Registered agents update optimistically; on failure both sides revert (re-resolved against the CURRENT
// roster, an SSE frame may have replaced it mid-flight) and the error propagates to the caller's inline UI.
const rename = async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim();
    const { conversations } = useChat();
    const conversation = conversations.value.find((candidate) => candidate.conversationId === id);
    const previousTitle = conversation?.title.value ?? null;
    if (conversation !== undefined) {
        conversation.title.value = trimmed;
    }
    const post = (): Promise<AgentSummary> =>
        sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/rename`, jsonBody(`POST`, { title: trimmed }));
    const previous = registry.value.find((agent) => agent.id === id);
    if (previous === undefined) {
        void post().catch(() => undefined);
        return;
    }
    const revertTitle = previous.title;
    previous.title = trimmed; // registry is a deep ref: the in-place write repaints the fleet
    try {
        const summary = await post();
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        // Revert on whatever the roster holds NOW, an SSE frame may have replaced the array (and `previous`).
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

// Set or clear (null ⇒ inherit the sandbox setting) an agent's auto-land override, whether ITS clean turns
// keep applying to the workspace at completion, or wait on the branch for a deliberate Land. Same optimistic
// grammar as rename: the registry entry flips in place (every surface stating the posture repaints on the
// tick of the click), the daemon's summary replaces it, and a failure reverts against the CURRENT roster and
// propagates for the caller's inline reporting.
const setAutoLand = async (id: string, autoLand: boolean | null): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous?.autoLand;
    if (previous !== undefined) {
        previous.autoLand = autoLand ?? undefined;
    }
    try {
        const summary = await sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/auto-land`, jsonBody(`POST`, { autoLand }));
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.autoLand = revert;
        }
        throw error;
    }
};

/* Set or clear (null ⇒ inherit the sandbox setting) THIS conversation's outage-resume override, whether a
 * turn the model provider killed is picked back up by itself. Identical optimistic grammar to setAutoLand
 * above, and deliberately a sibling of it rather than a call into settings: the press this serves is made
 * inside one chat about one dead turn, and writing the sandbox-wide toggle for it, which is what used to
 * happen, armed every other agent on the board without ever saying so. */
const setResumeAfterOutage = async (id: string, resumeAfterOutage: boolean | null): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous?.resumeAfterOutage;
    if (previous !== undefined) {
        previous.resumeAfterOutage = resumeAfterOutage ?? undefined;
    }
    try {
        const summary = await sandboxJson<AgentSummary>(
            `/agents/${encodeURIComponent(id)}/resume-after-outage`,
            jsonBody(`POST`, { resumeAfterOutage }),
        );
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.resumeAfterOutage = revert;
        }
        throw error;
    }
};

/* The same override for the blocker that comes back on a clock: whether the turn a spent allowance refused is
 * sent again by itself when the window reopens. Same optimistic grammar as its neighbour above, and the same
 * scope argument, one card's press speaks for one card.
 *
 * The press this serves is on the BOARD as well as in the chat, which is the one thing that differs and the
 * reason it matters: an outage is over in minutes and is met by whoever is in the room, while an allowance
 * reopens hours later, so the person deciding is usually looking at a lane of stranded cards rather than at the
 * transcript of any one of them. */
const setResumeAfterLimit = async (id: string, resumeAfterLimit: boolean | null): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous?.resumeAfterLimit;
    if (previous !== undefined) {
        previous.resumeAfterLimit = resumeAfterLimit ?? undefined;
    }
    try {
        const summary = await sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/resume-after-limit`, jsonBody(`POST`, { resumeAfterLimit }));
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.resumeAfterLimit = revert;
        }
        throw error;
    }
};

/* SEND A STRANDED TURN AGAIN, the board's half of the chat's pick-up strip: the daemon is still holding the
 * turn a spent allowance refused, so this re-RUNS that turn rather than appending a message saying "carry on"
 * (agent.contract's `resume`, and events.ts's `held` for the transcript full of the word "Continue" that
 * argument was won with).
 *
 * NOT optimistic, unlike its neighbours above. Those write a posture, where the honest thing to show while the
 * request is in flight is the value the user just chose; this starts a TURN, and the card that says so is the
 * one the daemon frames a moment later. Guessing would put a running card on the board over a request that may
 * yet answer NOT_FOUND, which is exactly what a hold lost to a daemon restart does. */
const resumeHeldTurn = async (id: string): Promise<void> => {
    await sandboxJson<{ run: string }>(`/agent/resume`, jsonBody(`POST`, { conversationId: id }));
};

/* DISARM EVERY OUTSIDE CONDITION THIS CONVERSATION IS PARKED ON (AgentSummary.watches), the user's way out of
 * an arrangement the agent entered into on their behalf.
 *
 * Optimistic like its two neighbours above, and for a sharper reason than symmetry: this press moves the card
 * across the board. Dropping the watches is what takes the conversation out of Active (agentStatus.laneOf), so
 * a press that waited on the round trip would leave the card sitting in the lane it was pressed out of, wearing
 * a readout that says it is still waiting. Reverted the same way if the daemon refuses, since a card that
 * quietly stopped mentioning a watch that is still armed is the exact failure this whole feature exists to
 * remove. */
const stopWatching = async (id: string): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous?.watches;
    if (previous !== undefined) {
        previous.watches = undefined;
    }
    try {
        const summary = await sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/stop-watching`, jsonBody(`POST`, {}));
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.watches = revert;
        }
        throw error;
    }
};

// Open (or focus) an agent's conversation tab and mark it seen. Takes just the identity fields so registry
// cards and client-only draft cards both route through it.
// A card, as the seed every window can rebuild its tab from (useChat.agentTabOf takes it from here).
export const agentSeed = (
    agent: Pick<
        FleetAgent,
        | "id"
        | "provider"
        | "harness"
        | "sessionId"
        | "title"
        | "account"
        | "model"
        | "effort"
        | "thinking"
        | "fast"
        | "tier"
        | "tierHold"
        | "status"
        | "branch"
        | "sandboxId"
    >,
): AgentTabSeed => ({
    id: agent.id,
    provider: agent.provider,
    harness: agent.harness,
    // The box the card came from, so a tab opened for an agent in another sandbox is addressed there rather
    // than asking this daemon about a conversation it has never heard of (AgentTabSeed.sandboxId).
    ...(agent.sandboxId !== undefined ? { sandboxId: agent.sandboxId } : {}),
    ...(agent.branch !== undefined ? { branch: agent.branch } : {}),
    /* A client-only card, a draft, a refused send, a turn the daemon has not filed yet, is NOT a
     * registered conversation, and claiming so here would erase the card under the click and pin the empty
     * tab open past the focus-leave sweep.
     *
     * The erasure is not hypothetical: while a sent-but-unfiled turn reported the wire's `running`, this
     * read it as registered and latched the tab, and the card left the board on the very click meant to open
     * it, the drafts half skips a registered conversation and the registry has no entry to draw instead, so
     * the agent was on no lane at all until a reload re-derived it. See `starting` in agentStatus.ts. */
    registered: !unregistered(agent.status),
    ...(agent.sessionId !== undefined ? { sessionId: agent.sessionId } : {}),
    ...(agent.title !== undefined ? { title: agent.title } : {}),
    ...(agent.account !== undefined ? { account: agent.account } : {}),
    // The settings this agent's turns ran under, so the composer opens describing THIS agent rather than
    // the last pick made in some other tab. Absent on a draft, it has run nothing to describe.
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
    ...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
    ...(agent.fast !== undefined ? { fast: agent.fast } : {}),
    ...(agent.tier !== undefined ? { tier: agent.tier } : {}),
    ...(agent.tierHold !== undefined ? { tierHold: agent.tierHold } : {}),
});

// Opening a card is a SUMMONS, not a store call: the chat panel showing the result may be another window's (the
// chat can be floating in a window of its own), so the reveal is broadcast and every window, this one included,
// applies the same thing (summon.ts).
const open = (agent: Parameters<typeof agentSeed>[0]): void => {
    const seed = agentSeed(agent);
    summonChat({ kind: `reveal`, verb: `show`, entries: [agentTabOf(seed)], focus: seed.id, caret: false });
    markSeen(agent.id);
};

export function useAgents() {
    return {
        fleet,
        lanes,
        attention,
        blocking,
        unread,
        heldWakes,
        releaseHeld,
        refresh,
        open,
        markSeen,
        markAllSeen,
        rename,
        setAutoLand,
        setResumeAfterOutage,
        setResumeAfterLimit,
        resumeHeldTurn,
        stopWatching,
        agentById,
        archived,
        archiveLoading,
        loadArchived,
        archive,
        restore,
        purgeArchived,
        undoArchive,
        undoable,
        archivedFlash,
        notice,
        dismissNotice,
        busyIds,
    };
}
