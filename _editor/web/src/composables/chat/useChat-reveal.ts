import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import { claimClosedDrafts } from "./closedDrafts";
import { drawsChat } from "./chatEcho";
import { Conversation } from "./conversation";
import type { StoredTab } from "./tabSnapshot";
import {
    active,
    claimColumnBeside,
    closePane,
    collapsePanes,
    conversations,
    focusComposer,
    restoreComposer,
    restoreTab,
    setActive,
    setConversations,
    setPanes,
    untouchedDraft,
} from "./useChat-tabs";
import { fetchTranscript, hydrateOnce, sessions } from "./useChat-sessions";
import { uuid } from "../uuid";

/* --- Reveal: what every summons of the chat applies -----------------------------------------------------
 *
 * ONE verb set, applied identically wherever the summons was pressed AND in whichever window it lands. The
 * surfaces outside the panel, the fleet board, New agent, a suggestion box, an extension, never touch the
 * tab list directly: they describe what the chat should show and hand it to the summons channel (summon.ts),
 * which runs this same function in this window and broadcasts it to the app's other windows. That is the whole
 * cure for "I clicked New agent and the floating chat kept showing an old conversation": a floating chat is a
 * window of its own running its own copy of the app, so a summons that only mutated the clicking window's own
 * store was invisible out there. The panel's OWN controls (its rail, its tabs, its panes) keep calling the
 * plain store verbs, a gesture inside the panel acts on the panel it was made in.
 *
 *   · show  , this one chat as the whole panel (the panes collapse to it): a card click, New agent, an
 *              accepted suggestion, a history row. A fresh start and an arrival land the same way on purpose:
 *              the other chats keep their tabs, they give their columns back.
 *   · focus , this one chat in the focused column, the split left standing. What `show` is minus the
 *              collapse: the collapse belongs to a plain click on a SELECTION surface (the ringed cards are
 *              the pane set, so pointing elsewhere replaces it), and a link inside the panel, a fork's
 *              source, a history row under a split being compared, is no such click.
 *   · beside, this chat in a column of its own, right of the focused pane (Alt/Ctrl on a board card).
 *   · panes , exactly this set, side by side, in this order (a Shift-run on the board).
 *   · unpane, take the chat's column back (Ctrl on an already-ringed card).
 */
export type RevealVerb = `show` | `focus` | `beside` | `panes` | `unpane`;

/* A chat, in whatever form the summoning surface holds it:
 *   · a live Conversation, the surface just built and configured it (New agent, an accepted suggestion);
 *   · a StoredTab, the portable description of a tab (tabSnapshot), which is also what every live entry
 *     becomes on the wire between windows;
 *   · a session reference, a history row: nothing exists but the daemon-side session and a title, and the
 *     summoner mints the conversationId so every window agrees on the tab's identity.
 * All three carry `conversationId`, which is the identity a reveal's `focus` names. */
export type RevealEntry = Conversation | StoredTab | { readonly conversationId: string; readonly sessionRef: string; readonly title?: string };

export interface Reveal {
    readonly verb: RevealVerb;
    readonly entries: readonly RevealEntry[];
    // Which entry holds the focus, by the conversationId the SUMMONER knows, a session already open in this
    // window under another id resolves to that tab instead.
    readonly focus: string;
    // Put the caret in the composer: what the press is FOR when it starts something to type into.
    readonly caret: boolean;
    /* A LOOK RATHER THAN AN OPENING: the chats this reveal has to create come in as peeks (Conversation.peek),
     * so the strip sweeps them again the moment the focus goes elsewhere. It is a property of the GESTURE, not
     * of the chat — a click down a lane of fleet cards, a skim of history rows — which is why it rides the
     * reveal and not the entries, and why every window applies it identically off the one summons.
     *
     * Only the tabs it OPENS: a chat already open keeps whatever standing it had, so looking at one the reader
     * deliberately kept never demotes it, and looking twice at the same card never promotes it either. */
    readonly peek?: boolean;
    /* THE WORDS THESE CHATS WERE CLOSED HOLDING (closedDrafts), for the reveal to put back. Filled by the
     * window whose gesture reopens them, which claims them ONCE from the shared store and sends them with the
     * summons so every window restores the identical composer; absent on a reveal made in this window alone,
     * which claims for itself. Never something a calling surface fills in: a board card, a history row and a
     * deep link all describe the chat they want, and what is waiting in it is this file's business. */
    readonly unsent?: readonly StoredTab[];
}

// The transcript round-trip behind a session entry, off the reveal's synchronous path.
const loadSession = async (conversation: Conversation, sessionRef: string, title: string | null): Promise<void> => {
    try {
        const restored = await fetchTranscript(conversation, sessionRef);
        if (restored !== undefined) {
            conversation.loadTranscript(restored, sessionRef, title);
        }
    } finally {
        conversation.loading.value = false;
    }
};

/* THE WORDS A CLOSE SET ASIDE, folded into the tab they were typed into as it comes back (closedDrafts).
 *
 * Every reopen goes through here, and that is the point: the board's card, a history row, a summons from
 * another window and a deep link are all "show me this conversation", and the message waiting in it is part of
 * the conversation.
 *
 * WHICH ACCOUNT OF THE TAB WINS depends on what the caller is holding. A REGISTERED agent's seed is the
 * daemon's own record (agentTabOf) and outranks a stored copy of it — but it carries `undefined` for
 * everything the registry has nothing to say about, so only its stated fields overlay. A DRAFT's seed knows
 * nothing this doesn't (it is a card the client itself invented), so the kept tab wins outright: its
 * placement, its picks and its persona are the chat, and a fresh tab's defaults would quietly re-aim it. */
const withClosedDraft = (entry: StoredTab, kept: StoredTab | undefined): StoredTab => {
    if (kept === undefined) {
        return entry;
    }
    const stated = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as Partial<StoredTab>;
    const merged = entry.registered ? { ...kept, ...stated } : { ...stated, ...kept };
    // ...and the composer is the kept tab's whichever way that went: it is the whole reason there is an entry.
    return { ...merged, draft: kept.draft, draftAt: kept.draftAt, attachments: kept.attachments, queued: kept.queued };
};

/* The same words put back into a tab this window ALREADY has open, which is how a close and a reopen in two
 * different windows meet: the other window's × set them aside, this one never closed its own copy. Only ever
 * into an EMPTY composer — words being typed here now are the live ones, and a restore must not overwrite them. */
const restoreKept = (conversation: Conversation, kept: StoredTab | undefined): void => {
    if (kept !== undefined && !conversation.unsent.value) {
        restoreComposer(conversation, kept);
    }
};

/* One entry, resolved to the open Conversation it means in THIS window, matching an open tab by id and a
 * session by the session it shows, so a summons broadcast twice (or a chat this window already opened by hand)
 * focuses the tab it already has rather than minting a twin. What has to join the strip goes into `additions`,
 * so the reveal lands as ONE list write however many chats it carries. `kept` is what the reveal is bringing
 * back to these composers (reveal's note), by conversation. */
const resolveEntry = (entry: RevealEntry, additions: Conversation[], kept: ReadonlyMap<string, StoredTab>): Conversation => {
    const opened = [...conversations.value, ...additions];
    const byId = opened.find((conversation) => conversation.conversationId === entry.conversationId);
    if (entry instanceof Conversation) {
        if (byId !== undefined) {
            return byId;
        }
        additions.push(entry);
        return entry;
    }
    if (`sessionRef` in entry) {
        const existing = opened.find((conversation) => conversation.session.value?.id === entry.sessionRef) ?? byId;
        if (existing !== undefined) {
            return existing;
        }
        const conversation = new Conversation(entry.conversationId);
        // Titled from the row BEFORE the transcript round-trip: a nameless empty tab awaiting its fetch is
        // indistinguishable from an untouched draft, and the focus-leave sweep would close it mid-load.
        conversation.title.value = entry.title ?? null;
        // A history row names a session, not a composer, so anything set aside for this chat is the only
        // account of what was waiting to be sent in it.
        restoreKept(conversation, kept.get(entry.conversationId));
        conversation.loading.value = true;
        void loadSession(conversation, entry.sessionRef, entry.title ?? null);
        additions.push(conversation);
        return conversation;
    }
    const session = entry.session;
    const existing = byId ?? (session === undefined ? undefined : opened.find((conversation) => conversation.session.value?.id === session.id));
    if (existing !== undefined) {
        // Closed in another window, still open here: the words that × set aside come back into this window's
        // own composer (restoreKept's note), never over one being typed in.
        restoreKept(existing, kept.get(entry.conversationId));
        // The summoner says the fleet knows this agent, however the tab came to be open, the latch that keeps
        // an opened card from re-appearing on the board as a phantom draft (see the registered flag's note).
        if (entry.registered) {
            existing.registered.value = true;
            existing.isolated.value = entry.isolated;
        }
        /* Opening is an explicit request to look again, however much the tab already shows, it may be a STUB
         * from an attach that died mid-turn, which is the one state that never heals on its own. Skipped while
         * streaming: this tab IS the stream, and rewriting under it is the one thing a summons must not do. */
        if (!existing.streaming.value) {
            hydrateOnce(existing);
        }
        return existing;
    }
    // Never open in this window: built from the snapshot exactly as a reload restores it. Hydrated OUTRIGHT
    // rather than left to the reachability watch, a turn running daemon-side attaches and renders live, a
    // settled one replays its record, and an unreachable daemon leaves the tab as it stands for that watch to
    // retry (hydrateOnce clears its mark on failure).
    const conversation = restoreTab(withClosedDraft(entry, kept.get(entry.conversationId)));
    additions.push(conversation);
    hydrateOnce(conversation);
    return conversation;
};

/* WHAT A REVEAL IS BRINGING BACK to the composers it opens, by conversation: the words carried on a summons
 * (claimed once, in the window that was pressed), or, for a reveal this window makes alone (a run taken into the
 * panel, a link followed inside it), whatever this window can claim for itself right now.
 *
 * Claimed for the whole reveal rather than entry by entry, so a Shift-run of cards into panes makes one claim,
 * and so the two cases meet in one place: the difference between "the window that was pressed already claimed
 * these for me" and "nobody has" is the whole subtlety, and it is a single `??`. */
const keptFor = (entries: readonly RevealEntry[], unsent: readonly StoredTab[] | undefined): ReadonlyMap<string, StoredTab> =>
    new Map((unsent ?? claimClosedDrafts(entries.map((entry) => entry.conversationId))).map((tab) => [tab.conversationId, tab] as const));

/* The tabs a LOOK had to create, marked as such (Reveal.peek) before the write that seats them, so the strip is
 * never momentarily holding a peek that doesn't say it is one — the snapshot watch reads exactly that moment,
 * and a tab persisted between the two would come back pinned. Only the additions, never a chat that was already
 * open: that one keeps whatever standing the reader gave it. */
const markPeeked = (peek: boolean | undefined, additions: readonly Conversation[]): void => {
    if (peek !== true) {
        return;
    }
    for (const conversation of additions) {
        conversation.peek.value = true;
    }
};

// Reveal returns the conversation the focus resolved to, the summoning surface may still need the live
// instance (a fork link, a test fixture). `unpane` shows nothing, so it returns nothing.
export const reveal = ({ verb, entries, focus, caret, unsent, peek }: Reveal): Conversation | undefined => {
    if (verb === `unpane`) {
        closePane(focus);
        return undefined;
    }
    const additions: Conversation[] = [];
    const kept = keptFor(entries, unsent);
    const resolved = entries.map((entry) => resolveEntry(entry, additions, kept));
    // The focus as THIS window knows it (see resolveEntry's aliasing).
    const at = entries.findIndex((entry) => entry.conversationId === focus);
    const focusId = (at === -1 ? undefined : resolved[at]?.conversationId) ?? focus;
    /* The column is claimed BEFORE the list write (openBeside's rule): the write reconciles the panes, and an
     * arriving chat with no column of its own takes the focused pane's on its way in. */
    if (verb === `beside`) {
        claimColumnBeside(focusId);
    }
    markPeeked(peek, additions);
    if (additions.length > 0) {
        setConversations([...conversations.value, ...additions], focusId, `reveal-${verb}`);
    }
    // Through setActive even when the write above already seated the focus: the reveal counter is what brings
    // the tab into view in a scrolled rail, and asking again for the focused tab is still a distinct request.
    setActive(focusId);
    if (verb === `panes`) {
        setPanes(resolved.map((conversation) => conversation.conversationId));
    } else if (verb === `show`) {
        // After the write, so the column kept is the one the summoned chat has just been seated in. The other
        // chats stay OPEN, this gives their columns back, it does not close them.
        collapsePanes();
    }
    if (caret) {
        focusComposer();
    }
    return resolved.find((conversation) => conversation.conversationId === focusId);
};

/* An agent's registry summary, folded into the portable tab shape, what a fleet surface holds when it opens a
 * chat that may not have a tab anywhere yet. The daemon's provider-neutral transcript record hydrates workspace
 * and isolated conversations alike, so no provider store or placement gets a separate open path. */
export interface AgentTabSeed {
    id: string;
    /* WHICH SANDBOX THE AGENT LIVES IN, absent for the box this browser is pointed at, which is every card the
     * streamed roster produces. A seed that carries one opens a tab addressed at THAT daemon
     * (Conversation.box): the same conversation, rendered here, running there. */
    sandboxId?: string;
    sessionId?: string;
    title?: string;
    provider: AgentProvider;
    harness: AgentHarness;
    // Present exactly when this conversation owns an isolated worktree. A registry-opened workspace
    // conversation must explicitly clear Conversation's isolated-by-default posture before its next turn.
    branch?: string;
    account?: string;
    // What the agent's turns actually ran with, as the registry recorded them. Absent only for an agent that
    // has never run one (the board's draft card), a real agent's settings are facts about it, and seeding the
    // tab from the remembered picks instead is what made the composer claim a model the session never used.
    model?: string;
    effort?: string;
    thinking?: boolean;
    fast?: boolean;
    // The automatic-tier pair the registry keeps per conversation: the last verdict (seeds the composer
    // preview's afterHardTurn input) and the standing veto (seeds the hold toggle).
    tier?: "fast" | "standard";
    tierHold?: boolean;
    // Whether the fleet actually knows this agent, true unless the caller knows better. The board's
    // client-only DRAFT card is the one that does: its conversation must stay a draft (carded, and taken by
    // the focus-leave sweep when abandoned) until a first turn registers it.
    registered?: boolean;
}

export const agentTabOf = (agent: AgentTabSeed): StoredTab => {
    const registered = agent.registered ?? true;
    return {
        conversationId: agent.id,
        // A registered agent's isolation is its branch fact; a draft keeps a fresh conversation's own
        // isolated-by-default posture.
        isolated: registered ? agent.branch !== undefined : true,
        registered,
        // The tab's address, carried through the same fold every window applies (see summon.ts): a summoned
        // remote tab talks to the same daemon in the second window as in the one that opened it.
        box: agent.sandboxId,
        provider: agent.provider,
        harness: agent.harness,
        account: agent.account,
        model: agent.model,
        effort: agent.effort,
        thinking: agent.thinking,
        fast: agent.fast,
        tier: agent.tier,
        tierHold: agent.tierHold,
        title: agent.title,
        /* The session with the whole of what the registry says minted it. `agent.account` serves both fields
         * here and means two different things by design: as the tab's pick it is where the NEXT turn goes, and
         * on the session it is what the LAST one ran under, which the registry recorded from the turn's own
         * frame (so an unpinned turn names the account that actually paid, not the first one connected). They
         * start equal because opening a card is asking to carry on where it left off; a switch made afterwards
         * moves the pick alone, and the divider then says what that costs. */
        session:
            agent.sessionId === undefined
                ? undefined
                : { id: agent.sessionId, provider: agent.provider, harness: agent.harness, account: agent.account },
        draft: ``,
        attachments: [],
        queued: [],
    };
};

// Open (or focus) the tab bound to a fleet agent's conversationId in THIS window, reveal's `focus`, seeded
// through agentTabOf. The panel's own surfaces use it directly (a fork's source link, a claimed column being
// filled); the surfaces outside the panel summon instead (summon.ts), which applies the very same fold in
// every window.
export const openAgentConversation = (agent: AgentTabSeed): Conversation =>
    reveal({ verb: `focus`, entries: [agentTabOf(agent)], focus: agent.id, caret: false }) ?? active.value;

/* The conversation "New agent" summons: the untouched draft already open (there is at most one, the one-draft
 * invariant setConversations holds), else a fresh one. Handing the existing draft back rather than minting a
 * twin is what keeps a second press from reading as a press that did nothing: an empty draft has nothing in it
 * to tell two apart, so the press is about the caret, and about the FOCUS landing on the draft, which is a
 * visible tab switch when it was pressed from another tab. */
export const draftConversation = (): Conversation => {
    /* ONLY WHERE THE COMPOSER CAN BE SEEN. A window that is not drawing the chat holds a shadow of the strip
     * (untouchedDraft's note), and a shadow cannot tell an empty draft from one being typed into a window away:
     * typing is never broadcast, so the board's copy of the draft the reader is writing in the popped-out chat
     * stays untouched for as long as they write. Handing THAT back summoned the chat they were already in,
     * re-hydrated it (the skeleton that flashed over their words) and opened nothing, and only a click that took
     * the shadow's focus elsewhere, sweeping it, let the next press mint a draft. So such a window always mints:
     * the drawing window receives a fresh tab, and its own write sweeps whatever untouched draft it held, which
     * is the strip either press converges on. */
    const open = drawsChat.value ? conversations.value.find(untouchedDraft) : undefined;
    if (open === undefined) {
        return new Conversation();
    }
    /* ...RE-SEEDED, so the draft handed back is the chat a fresh one would have been. It was minted with the
     * picks that were remembered at the time, which is not the same thing: pick a model in one chat, then press
     * New agent, and the empty tab that answers was carrying whatever was remembered when it happened to be
     * created — a model the user had not chosen, under a heading saying "New agent". Safe because the draft is
     * untouched by definition, and free because a pick made in that very draft IS the remembered pick. */
    open.seedPicks();
    /* ...AND THE PRESS IS THE ASKING. A blank the panel was only standing on (Conversation.standIn) has no card
     * on the fleet board by design; handed back for a New agent press it becomes a chat the user started, and a
     * press that left the board looking exactly as it did is a press that did nothing. */
    open.standIn.value = false;
    return open;
};

/* The conversation a SUGGESTION is written into, the empty board's starters, which fill a composer rather than
 * sending anything (agentActions.composeAgent).
 *
 * Deliberately looser than `untouchedDraft`: text in the box makes a draft touched, so asking for one twice
 * would mint a second tab, and a user trying three starters in a row would end up with three chats they never
 * sent. What matters here is only that nothing has been SENT on the focused chat, no transcript, no session,
 * not on the fleet, because then rewriting its composer replaces a suggestion the user has not acted on. Once
 * anything has been sent it is somebody's conversation, and a suggestion opens its own draft instead. */
export const composingConversation = (): Conversation => {
    const focused = active.value;
    return !focused.registered.value && focused.messages.value.length === 0 && focused.session.value === undefined ? focused : draftConversation();
};

/* Open a past conversation from the panel's own history rows: focus its tab when one already shows that
 * session, else load its transcript into a new tab (reveal's session entry). Panel-internal, so it reveals in
 * THIS window only, the surfaces outside the panel go through the summons channel (summon.ts) instead.
 *
 * A PEEK, like a click on a fleet card, and for the same reason: reading down a list of past sessions to find
 * the one you meant is the gesture this list exists for, and it used to cost a permanent tab per row tried. */
export const openConversation = (id: string): void => {
    const conversationId = uuid();
    reveal({
        verb: `focus`,
        entries: [{ conversationId, sessionRef: id, title: sessions.value.find((session) => session.id === id)?.title }],
        focus: conversationId,
        caret: false,
        peek: true,
    });
};
