import type { AgentSummary } from "@intentic/sandbox-contract";
import { computed, watch } from "vue";
import { awaitingUser, blocked, type ClientAgentStatus, type FleetLane, laneOf, turnInFlight, unregistered } from "./agentStatus";
import { closedDrafts } from "../../chat/drafts/closedDrafts";
import { draftPreview } from "../../chat/drafts/draftPreview";
import { type TabFacts, unasked } from "../../chat/tabs/tabFacts";
import type { StoredTab } from "../../chat/tabs/tabSnapshot";
import { rememberedProviderFor } from "../../chat/run/turnDefaults";
import { useChat } from "../../chat/run/useChat";
import { chatStrip } from "../../chat/panel/useChat-strip";
import { onScreen } from "../../../shell/window/onScreen";
import { archived, heldWakes, markSeen, registry, sameEntries, snapshotFingerprint } from "./useAgents-registry";

/* THE FLEET VIEW: the registry (authoritative: status/branch/cost, agents this tab never opened) merged with the
 * open Conversation tabs by conversationId (live: in-browser streaming state), then the lanes and the counts the
 * board and the rail draw from it. Derived state only; the roster it reads is useAgents-registry's. */

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

// What a card that is not the daemon's says about itself: no attention, nothing owed.
const NO_ATTENTION: FleetAgent["attention"] = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

/* ONE CHAT THAT WAS CLOSED WITH ITS MESSAGE STILL IN IT (chat/closedDrafts), as a card.
 *
 * Everything here comes off the tab that was set aside, because there is nowhere else to ask: the conversation
 * has no tab in any window and the daemon never registered it. That includes its BOX — a draft prepared against
 * another sandbox is still this browser's draft and belongs on this board, and the card has to carry the
 * address or opening it would ask the wrong daemon (the same rule the live draft cards state).
 *
 * `updatedAt` is zero, as on every card the daemon has no row for: a set-aside message is not activity, and a
 * card dating itself by the message's age read as "last active 2m ago" the moment its chat was closed, which
 * is the one thing about it that had NOT just happened. The mark carries the age (draftAt); the footer does not. */
const closedCard = (tab: StoredTab, unsent: UnsentTab | undefined): FleetAgent => ({
    id: tab.conversationId,
    status: tab.session === undefined ? `draft` : `resumed`,
    // A tab persisted before it had picked anything (or by a build that stored neither) still opens somewhere:
    // the same fallbacks a fresh conversation is born with, rather than a card that cannot say what it runs on.
    provider: tab.provider ?? rememberedProviderFor(),
    harness: tab.harness ?? `native`,
    updatedAt: 0,
    attention: NO_ATTENTION,
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

/* ONE OPEN TAB THE FLEET HAS NEVER HEARD OF, as a card: the DRAFT half of the board, drawn from the strip
 * (tabFacts.ts) rather than from a Conversation, so it draws the same card for a tab in this window and for one
 * in the window that popped the chat out.
 *
 * WHAT THE CARD IS CALLED BEFORE ANYTHING HAS NAMED IT: the opening words of the message waiting in its
 * composer. A board of drafts otherwise says "New agent" as many times as there are cards, at the one moment
 * the reader is trying to tell them apart. The same source as the mark, never a fallback from one to the other,
 * which is also what turns "unsent, but an attachment rather than words" into no name at all: such a card wears
 * the mark and keeps its "New agent".
 *
 * WHERE THIS DRAFT WILL RUN, when it is not here (`box`): a tab aimed at another sandbox is still a draft in
 * THIS browser and belongs on this board, since a draft exists nowhere else, but the card has to carry the box
 * or every action on it would address the wrong daemon. From its first turn on, the card comes from that box's
 * own roster instead (fleetScope.otherFleet), which is what the ack-time registration latch hands over.
 *
 * The session a RESUMED card stands for is named here so nothing else reports it a second time: the board's
 * search lists conversations no card carries ("In earlier chats"), and without this the chat the user just
 * opened from that very list went on being offered underneath its own card.
 *
 * A turn already in flight (`turn`, only ever on a `starting` card) is what this browser knows about work the
 * daemon has not filed yet, and it is not nothing: the settings the send went out under, the elapsed from the
 * send itself, the tab's own running counts, each replaced by the registry's version the moment it lands. Zero
 * tokens and zero cost are "nothing counted yet" rather than measurements, so the strip leaves them off until
 * the turn's first usage frame.
 *
 * WHAT A PREPARED DRAFT WILL RUN ON is the one of those facts already true before the send: a message standing
 * in a composer is queued work, and its model is a decision the user has already made about it, so the card
 * names it. Gated on there being something unsent, which is the line between the two kinds of draft: a card for
 * a tab nobody has typed in is a placeholder for work not yet described, and naming a model on it would put a
 * spend on the board for a turn nobody has decided to take. */
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

// Attention first, then live turns + fresh drafts, then most recently active.
const weight = (entry: FleetAgent): number =>
    blocked(entry) ? 0 : turnInFlight(entry) || entry.status === `awaiting` || entry.status === `draft` ? 1 : 2;

/* Same stabilization as the roster, one level up: `fleet` spreads every registry row into a card view-model on
 * every frame, and the board hands that object to dozens of AgentCards. Reuse the previous FleetAgent when its
 * derived fields are unchanged so Vue can skip cards whose agent did not move. */
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

// The memo goes with the roster it was derived from (desync, useAgents.ts): its cards are the old daemon's objects.
export const forgetFleet = (): void => {
    fleetStable.clear();
    stableFleet = [];
};

export const fleet = computed<FleetAgent[]>(() => {
    /* THE CHAT'S STRIP, from whichever window is drawing it (useChat.chatStrip): the one account of which chats
     * are open, what they are called and which hold words that have not gone out, the last being the one thing
     * the daemon's roster cannot know. Read from here and from nowhere else. The board used to read this
     * window's own tab list for the first two and an echo of the composers for the third, and every defect of
     * the popped-out chat was those two disagreeing: with the chat on another screen this window's tabs are a
     * frozen copy, so a draft card vanished because the copy looked empty, an unsent chip stayed because the
     * copy still held sent words, and a card closed from here disappeared and came back because the copy was
     * closed a beat before the drawing window said so. */
    const strip = chatStrip.value;
    const openIds = new Set(strip.tabs.map((tab) => tab.id));
    const carded = new Set(registry.value.map((agent) => agent.id));
    /* The tabs holding words that have not gone out, and the reason the halves below are joined against this
     * rather than against `openIds` alone...
     *
     * ...AND THE ONES NOBODY IS TYPING IN ANY MORE, because their chat was CLOSED with the message still in it
     * (chat/closedDrafts). Those words are set aside rather than destroyed, so they are as unsent as the ones
     * in an open composer, and the card is the only way back to them: it wears the mark, it is named by the
     * message, and opening it puts the words back where they were written.
     *
     * Merged UNDER the composers, which is the direction that cannot go stale: an entry is taken out the moment
     * its chat is reopened, so the only way to hold both is a window that reopened one without this one hearing
     * yet, and in that race the live composer is the account being typed into. */
    const unsent: ReadonlyMap<string, UnsentTab> = new Map([
        ...closedDrafts.value.map((tab): [string, UnsentTab] => [tab.conversationId, { preview: draftPreview(tab.draft), at: tab.draftAt }]),
        ...strip.tabs.filter((tab) => tab.unsent).map((tab): [string, UnsentTab] => [tab.id, { preview: tab.preview, at: tab.draftAt }]),
    ]);
    // A draft is a conversation the fleet has never heard of. NOT one that is merely absent from the live
    // roster, which is also true of every agent the user has archived and of every agent at all while the
    // events stream is down. `carded` is the join's own guard: an id the registry half already rendered must
    // not be rendered a second time by this one, whatever the latch says.
    /* ...EXCEPT THE BLANK A PANEL IS ONLY STANDING ON (tabFacts.unasked): the chat a window with nothing to
     * restore opens on, and the one a close leaves behind when it takes the last card. Every other tab here
     * stands for something the user did; that one stands for the panel needing to show something, and carding it
     * put "New agent" in this lane wearing the selection ring the moment somebody closed their last chat. It
     * joins the board on its own the instant anything happens in it, which is what `unasked` stops answering to. */
    const drafts = strip.tabs
        .filter((tab) => !tab.registered && !carded.has(tab.id) && !unasked(tab))
        .map((tab): FleetAgent => draftCard(tab, unsent.get(tab.id)));
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

// The board's two headline counts, kept apart on purpose (the header renders both): agents BLOCKED on the
// user, and agents merely unread.
export const blocking = computed(() => fleet.value.filter(blocked).length);
export const unread = computed(() => fleet.value.filter((agent) => agent.unread).length);
/* The single aggregate the rail tile and mobile tab badge render, "there is something for you on the board",
 * counted per AGENT so one that is both blocked and unread badges once.
 *
 * HELD WAKES COUNT TOO, and they are the reason this is not just a filter over the fleet. An automation set to
 * require approval fires at 3am and parks a wake in the queue; the board has always shown it in the Attention
 * lane, but the rail stayed silent, so the one surface visible from every other area said nothing was owed. A
 * hold is not an agent, it has no conversation, no transcript and no turn until it is approved, which is
 * exactly why it needs the badge: nothing else about it is on screen. */
export const attention = computed(() => fleet.value.filter((agent) => blocked(agent) || agent.unread).length + heldWakes.value.length);

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
export const laneGroups = (agents: readonly FleetAgent[]): Record<FleetLane, FleetAgent[]> => {
    const grouped: Record<FleetLane, FleetAgent[]> = { attention: [], active: [], finished: [] };
    for (const agent of agents) {
        grouped[laneOf(agent)].push(agent);
    }
    // Fresh drafts lead the active lane (they're what the user just created). Below them, order by startedAt,
    // a turn's start is FIXED for its whole life, so a running agent holds its slot instead of jumping to the
    // top on every activity frame (updatedAt ticks every second, which churns the lane when many run at once).
    // Oldest-running leads; a draft has no startedAt, so it falls back to updatedAt but is already sorted ahead.
    grouped.active.sort(
        (a, b) =>
            Number(b.status === `draft`) - Number(a.status === `draft`) || (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt) || byId(a, b),
    );
    grouped.attention.sort((a, b) => b.updatedAt - a.updatedAt || byId(a, b));
    /* UNSENT FIRST, then work the agent left open, then ready-to-land, then recency. All three exceptions are
     * the same argument, made about the fold: this lane windows to a handful (FINISHED_WINDOW), and recency
     * alone lets whatever finished a minute ago push any of them behind it, where "waiting for you" quietly
     * becomes "forgotten".
     *
     * A ready card is owed a press. An UNSENT one is owed a sentence, and it goes first because it is the more
     * easily lost of the two: the press is on a card the daemon will keep offering for as long as the branch
     * exists, while the half-written message lives in this window alone. Ordering them this way is also what
     * makes the promise cheap to keep, a card holding words the user wrote can only fall behind the fold when
     * MORE THAN A WINDOW'S WORTH of such cards exist, at which point they are hiding each other rather than
     * being hidden by unrelated work.
     *
     * AN UNFINISHED CARD GOES BETWEEN THEM, and it is the one card in this lane whose own status argues against
     * it: `idle` and `landed` are what a finished conversation looks like, so a session that stopped three
     * steps into its own list is filed here wearing exactly the face of one that finished. It sorts under the
     * unsent chip because a message nobody sent is still the more perishable of the two — the work is on a
     * branch and will keep — and above the ready card because a press on work that stopped short lands work
     * that stopped short. */
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

// Resolve one agent by id across BOTH halves of the fleet. The board's roster deliberately drops archived
// agents, but a surface addressed by id, the /agents/:id detail and its review, must still find one: an
// archived agent keeps its branch, its diff and its transcript, so its detail page is a real destination and
// not a 404. (The archive half is only populated once loadArchived has run; callers that can be deep-linked
// into ask for it themselves.)
export const agentById = (id: string): FleetAgent | undefined =>
    fleet.value.find((agent) => agent.id === id) ?? archived.value.find((agent) => agent.id === id);
