import { computed, ref, shallowRef, watch } from "vue";
import { reloadOnHotUpdate } from "../hotReload";
import { forgetClosedDraft, keepClosedDraft } from "./closedDrafts";
import { drawsChat } from "./chatEcho";
import { traceFocus } from "./focusTrace";
import { Conversation } from "./conversation";
import { rememberedAccountFor } from "./providerAccounts";
import { rememberedModelFor, startingMode } from "./turnDefaults";
import { scopeAccountPreference } from "./accountPreference";
import { tabFacts, untouched } from "./tabFacts";
import { forgetTabSnapshot, readTabSnapshot, snapshotTab, type StoredTab, writeTabSnapshot } from "./tabSnapshot";
import { dropTranscript } from "./transcriptCache";
import { useSandbox } from "../sandbox/useSandbox";
import { uuid } from "../uuid";

const { activeSandboxId } = useSandbox();

// Open conversations (tabs) and which one is focused; always at least one. A tab IS its conversation, so the
// focus is a conversationId, the one identity the daemon, the fleet registry, the transcript mirror and the
// agent fleet registry and transcript mirror all already key on. There is deliberately no second, tab-local
// id: the previous one was minted from a counter that resetChat rewound, so a reused value silently aliased two
// different chats in anything that outlived the reset.
// shallowRef, not ref: a deep ref would unwrap each Conversation's internal Vue refs (messages, title, …)
// and mangle the class type. The instances' own refs stay reactive; reassigning the array triggers updates.
export const conversations = shallowRef<Conversation[]>([]);
export const activeId = ref<string>(``);

/* An untouched "New agent" tab exists only while the focus is ON it. The tab and the fleet board's draft card
 * are one conversation under two skins, so an abandoned empty draft doesn't just crowd the strip, it squats in
 * the board's Active lane looking like work in flight. Anything at all in it makes it real and it stays:
 * anything unsent (Conversation.unsent, composer text, a staged attachment, a queued message), a transcript,
 * a session, a running turn, a rename, an unread error, or a fleet registration.
 *
 * Read off THIS window's conversation, whether or not this window draws the chat. In the window that does, the
 * composer is the truth. In a window that does not, the list is a shadow (the note above) that nothing displays:
 * a sweep there costs the board nothing, since the board reads the drawing window's strip, and sparing there
 * costs nothing either. The sweep used to consult the echo for the words instead, which was the right answer to
 * a question that no longer arises: the board's card for a draft being typed one window away is drawn from that
 * window's strip, not from whether this window's copy survived the click. */
export const untouchedDraft = (conversation: Conversation): boolean => untouched(tabFacts(conversation));

/* THE TABS THAT EXIST ONLY WHILE THE FOCUS IS ON THEM, which is the whole of what the writer below sweeps: an
 * untouched draft, and a chat opened for a LOOK (Conversation.peek, the workspace editor's preview tab for
 * chats). One rule, two doors into it, and the same promise on the way out — a sweep here can destroy nothing:
 * the conversation keeps its card on the board and its row in History, and a running turn is detached rather
 * than stopped.
 *
 * WORDS IN THE COMPOSER SPARE A PEEK whatever its flag says. Typing clears the flag itself (the watch further
 * down), so this is the floor under that watch rather than a second opinion about the same thing: the sweep is
 * a synchronous list write and the watch is a flush later, and the one ordering nobody should ever have to
 * reason about is the one with a message at stake. */
const transient = (conversation: Conversation): boolean => untouchedDraft(conversation) || (conversation.peek.value && !conversation.unsent.value);

/* THE BLANK A WINDOW SHOWS WHEN NOTHING IS OPEN (Conversation.standIn). Minted here rather than by a bare
 * `new Conversation()` at each site, because both floors leave the same thing behind: a window with no tabs to
 * restore, and a close that took the last card. What the flag buys is on the fleet board, which cards every
 * open tab the fleet has never heard of: a chat the user never asked for gets no card there and takes no ring,
 * so closing the last card selects nothing rather than selecting a "New agent" nobody started. */
const standIn = (): Conversation => {
    const conversation = new Conversation();
    conversation.standIn.value = true;
    return conversation;
};

/** Promote a peeked tab into an ordinary one, named by id: what the card's pin, its menu row and the surfaces
 *  that hold an id rather than a live chat press. A chat acted on promotes itself (Conversation.keep). */
export const keepChat = (conversationId: string): void => {
    conversations.value.find((conversation) => conversation.conversationId === conversationId)?.keep();
};

/* The one writer of the tab list AND of the focus (setActive routes through it too), holding both of the
 * strip's invariants in the same write:
 *   · the focus lands on a tab that is actually in the list, and on the LAST one when the tab that had it is
 *     gone (VSCode behaviour, the rule the workspace's tabs follow too). A focus naming nothing is invisible
 *     rather than loud, the strip highlights no tab while the panel quietly shows the first one, so every
 *     click afterwards looks like it did nothing.
 *   · at most ONE TRANSIENT tab is open, and only as the focused one: an untouched draft, or a chat opened for
 *     a look (`transient`, above). Neither needs counting to stay unique, since any of them that is not the
 *     focused tab leaves on this very write.
 *
 * The draft rule is enforced HERE rather than by a watcher reacting to the focus afterwards, which is what it
 * used to be. Reaping after the fact meant the outcome of an explicit action was decided by an implicit reaper
 * racing it: "New agent" pressed while sitting on an empty draft appended one and the reaper closed the other,
 * so the press was a visual no-op, and every intermediate state (a focus already moved, the doomed draft still
 * listed) was live long enough to render and to be persisted by the snapshot watch. It also only ever looked at
 * the tab that LOST the focus, so a draft that lost it to a list rewrite instead (a close reseating the focus on
 * the last tab) survived as a permanent, unsweepable "New agent" tab. One synchronous write, no ordering. */

/* THE ORDER THE FOCUS VISITED THE TABS IN, most recent last, for the one question it answers: where the focus
 * goes when the tab holding it closes. It used to go to the LAST tab in the strip, which in a rail sorted by
 * lane is whichever chat happened to be opened last, most often a finished or archived one nobody was reading,
 * so closing a draft from the board sent the popped-out chat to "some old session". The tab the reader was on
 * BEFORE this one is what every editor's close means (VSCode focuses the most recent editor by default), and it
 * is the only answer that makes a close from the board and a close from the rail land in the same place. */
let recent: readonly string[] = [];

/* A SWEPT TAB IS DETACHED ON ITS WAY OUT, the one piece of teardown a transient tab can need: an untouched
 * draft has no turn to leave, but a PEEK may be attached to one — looking at a working agent is most of what
 * the board's cards are for — and a stream left open would go on writing into a conversation nothing renders.
 * Soft, like every abort here (Conversation.abort): the daemon-side turn carries on and the card on the board
 * goes on saying so.
 *
 * The cached transcript is deliberately KEPT, unlike a close's (see `closing`): the mirror is what makes the
 * next look at the same card paint instantly, and a look is the gesture most likely to be repeated. */
const detachSwept = (next: readonly Conversation[], kept: readonly Conversation[]): void => {
    for (const conversation of next) {
        if (!kept.includes(conversation)) {
            conversation.abort();
        }
    }
};

export const setConversations = (next: readonly Conversation[], focus: string, reason: string): void => {
    const open = (id: string): boolean => next.some((conversation) => conversation.conversationId === id);
    /* Where the focus lands when the id asked for names no tab in the list being written, a close taking the
     * tab that had it. A chat still ON SCREEN wins: with several panes open, closing the focused one should hand
     * the keyboard to a column the user is already looking at and let that column go, rather than pull an
     * unrelated chat into the vacated slot to hold a focus that had nowhere else to be (VSCode closes the group
     * with its last editor; this is the same move). Then the tab the focus was on most recently before this one
     * (`recent`), and only when nothing has ever held it, the strip's last tab. */
    const focused = open(focus) ? focus : (panes.value.find(open) ?? recent.findLast(open) ?? next.at(-1)!.conversationId);
    // The focused tab is always kept, so the list can never come out empty. A dropped draft needs no teardown
    // (untouched means no turn to detach from and no transcript to evict), and a dropped peek needs none either:
    // its transcript is the daemon's and its turn goes on without the tab.
    const kept = next.filter((conversation) => conversation.conversationId === focused || !transient(conversation));
    /* Every movement of the focus, with what asked for it and what it resolved to, see focusTrace.ts. The
     * FALLBACK is the line worth having: an id that names no tab in the list being written is not an error
     * here, it silently seats the focus on the last one instead, which on screen is indistinguishable from
     * "the chat ignored my click and went somewhere else", the report this trace exists to settle. Only
     * actual movements are traced; a write that leaves the focus where it was says nothing. */
    if (focused !== activeId.value || focus !== focused) {
        traceFocus(`focus`, {
            reason,
            asked: focus,
            resolved: focused,
            ...(focus === focused ? {} : { fellBack: true }),
            from: activeId.value,
            tabs: kept.length,
            ...(kept.length === next.length ? {} : { swept: next.length - kept.length }),
        });
    }
    detachSwept(next, kept);
    // Reassigned only when the list actually moved, so a plain tab switch doesn't re-fire every list watcher
    // (the snapshot write, the hydrate sweep) for a change that is only about the focus.
    if (kept.length !== conversations.value.length || kept.some((conversation, at) => conversation !== conversations.value[at])) {
        conversations.value = kept;
    }
    // Before the focus moves, since which COLUMN the incoming chat lands in is answered by where the focus is
    // leaving from.
    reconcilePanes(kept, focused);
    activeId.value = focused;
    // Closed tabs leave the order; the focused one moves to its head.
    recent = [...recent.filter((id) => id !== focused && kept.some((conversation) => conversation.conversationId === id)), focused];
};

/* WHICH CHATS ARE ON SCREEN AT ONCE, the panes, in the order they were opened.
 *
 * One id is the ordinary case (the docked column has room for nothing else); several is the floating window
 * showing a fleet side by side. The focused pane is `activeId`, always a member, so every surface outside this
 * panel goes on reading `active` and means "the chat the user is looking at".
 *
 * ORDER IS INSERTION ORDER, never the rail's. The rail sorts by lane (attention / active / finished), so a
 * chat changes rows the moment its turn ends, and panes laid out in rail order would swap columns under the
 * reader's eyes mid-answer. A pane holds its column from the moment it opens until it closes. */
export const panes = ref<string[]>([]);

/* The pane invariants, held in the same write as the focus and the tab list: every pane names an open tab, the
 * focused chat is always in one, and the set is never empty.
 *
 * The slot rule below is what keeps every existing caller working: a plain tab click, a card on the board, a
 * deep link and a history row all land on setActive, and none of them means "open another pane", they mean
 * "show me this chat", so the incoming chat takes the column the focus was already in and the other panes are
 * left alone. Opening a pane is a separate verb (openBeside / setPanes), and so is closing the rest
 * (collapsePanes), which is why a CLICK on a row or a card collapses while an arriving deep link does not:
 * one is a gesture on a selection, the other is an arrival. */
const reconcilePanes = (kept: readonly Conversation[], focused: string): void => {
    const open = new Set(kept.map((conversation) => conversation.conversationId));
    const held = panes.value.filter((id) => open.has(id));
    if (!held.includes(focused)) {
        const slot = held.indexOf(activeId.value);
        if (slot === -1) {
            held.push(focused);
        } else {
            held[slot] = focused;
        }
    }
    if (held.length !== panes.value.length || held.some((id, at) => id !== panes.value[at])) {
        panes.value = held;
    }
};

// The focused conversation. The find always hits, setConversations reconciles the focus with every list it
// writes, and list[0] is the floor that keeps a slip a wrong tab rather than a crashed panel.
export const active = computed<Conversation>(() => {
    const list = conversations.value;
    return list.find((conversation) => conversation.conversationId === activeId.value) ?? list[0]!;
});

// --- Tab persistence ---------------------------------------------------------------------------
// The snapshot's shape, storage and validation live in tabSnapshot.ts; what stays here is when it is read and
// written. Which SANDBOX the open tabs belong to is recorded at restore rather than read live at write time:
// activeSandboxId flips one flush before sandboxScope's watch re-scopes the list, so a snapshot that lands in
// the incoming sandbox's key during that window is the OUTGOING sandbox's tabs, restored, on the very next
// line, as if they were the new sandbox's own.
let scopedSandboxId: string | undefined;

/* EVERYTHING THAT WAS WAITING TO BE SENT, back in the composer: the message, the age it has been standing, the
 * staged files and the turns queued behind a running one. Its own function because two arrivals put a composer
 * back — a tab restored from this window's snapshot, and a chat REOPENED after a close set its words aside
 * (closedDrafts) — and a second copy of this is how the two start to disagree about what "unsent" restores.
 *
 * Restored attachments carry upload metadata only (no previewUrl/controller, those are client-session objects);
 * the composer re-mints thumbnails from the workspace bytes on render (attachmentPreview). */
export const restoreComposer = (conversation: Conversation, tab: StoredTab): void => {
    conversation.draft.value = tab.draft;
    // The age of what is in that composer, restored with it: the stamping watch below only ever fills an EMPTY
    // stamp, so a tab that comes back holding words keeps the instant it first held them instead of being
    // re-stamped as freshly written by its own restore.
    conversation.draftAt.value = tab.draftAt;
    conversation.attachments.value = tab.attachments.map((file) => ({
        id: uuid(),
        name: file.name,
        path: file.path,
        status: `done` as const,
        progress: 1,
    }));
    conversation.queued.value = tab.queued.map((message) => ({ id: uuid(), text: message.text, attachments: message.attachments }));
};

// One persisted tab, back as a live conversation.
export const restoreTab = (tab: StoredTab): Conversation => {
    const conversation = new Conversation(tab.conversationId);
    conversation.isolated.value = tab.isolated;
    conversation.registered.value = tab.registered;
    // Before anything else that could talk to a daemon: this is the tab's ADDRESS, and a hydrate that ran
    // against the active box first would ask the wrong one about a conversation it has never heard of.
    conversation.box.value = tab.box;
    // The posture isn't part of the snapshot (it is a per-task choice, not a preference), a restored tab
    // starts from the mode its tree calls for, same as a fresh one.
    conversation.modePick.value = startingMode(conversation.isolated.value);
    /* A tab that was only being LOOKED at comes back that way. This snapshot is also the handoff between the
     * docked chat and its own window (the note by the snapshot watch below), so a flag dropped here would pin
     * the one tab the reader never asked to keep every time the panel moved, and dropping the tab instead would
     * close the chat they are in the middle of reading. It is always the focused tab, so a restored peek is
     * simply "still a look", swept by the first click that goes elsewhere. */
    conversation.peek.value = tab.peek === true;
    // ...and a blank the panel was only standing on comes back as one (Conversation.standIn). It rides the same
    // snapshot for the same reason the look above does: this is the pop-out handoff as well as the reload, and a
    // flag dropped here would put a "New agent" card on the fleet board every time the panel changed windows.
    conversation.standIn.value = tab.standIn === true;
    restoreComposer(conversation, tab);
    conversation.title.value = tab.title ?? null;
    // Restore the harness before the model, the native/claude-code model lists diverge for codex/grok.
    if (tab.harness !== undefined) {
        conversation.harness.value = tab.harness;
    }
    if (tab.provider !== undefined) {
        conversation.provider.value = tab.provider;
        // An OPEN chat comes back on the account it was running on, not on whatever the remembered pick has since
        // become, switching one tab's account is not an instruction about the others. Only a tab that carries no
        // pin of its own (one persisted before this was stored) falls back to the provider's remembered one.
        conversation.account.value = tab.account ?? rememberedAccountFor(tab.provider);
        conversation.model.value = tab.model ?? rememberedModelFor(tab.provider);
        // ...and whether the app is the one that put it there. Without this a chat parked on a fallback while a
        // sign-in redirected the whole page came back on that fallback with nothing left to say it was standing
        // somewhere it never chose, so the reconciliation pass below had no reason to give it back.
        conversation.movedFrom.value = tab.movedFrom;
    }
    // ...and the rest of the tab's turn settings by the same rule: the composer's pills describe THIS chat, so a
    // reload restores what it was showing rather than re-seeding it from picks made in some other tab since.
    if (tab.thinking !== undefined) {
        conversation.thinking.value = tab.thinking;
    }
    if (tab.fast !== undefined) {
        conversation.fast.value = tab.fast;
    }
    // The automatic-tier pair: the standing veto (a pick like the others on this line) and the last verdict,
    // which is not a pick at all but the one judge input the composer's preview cannot re-derive from a draft.
    if (tab.tierHold !== undefined) {
        conversation.tierHold.value = tab.tierHold;
    }
    if (tab.tier !== undefined) {
        conversation.lastTier.value = tab.tier;
    }
    // The one restored pick that is about what happens while nobody is looking, which is why it comes back at
    // all: a reload during an unattended run must not quietly disarm the thing keeping it going.
    if (tab.autoContinue !== undefined) {
        conversation.autoContinue.value = tab.autoContinue;
    }
    // The stopped turn that switch would act on does NOT come back from here, and it used to: the daemon is the
    // one party that knows whether the refused turn is still held, and only a held turn makes the press free
    // (see StoredTab, and adoptEnding below, which takes the record's own account of the ending).
    if (tab.effort !== undefined) {
        conversation.effortPick.value = tab.effort;
    }
    // The persona comes back with the tab for the same reason, and with more riding on it than the rest of this
    // line: nothing else remembers it (it is never a global default), so a reload that dropped it would quietly
    // hand a chat every account back and the composer would say so only if the user looked.
    if (tab.actsAs !== undefined) {
        conversation.actsAs.value = tab.actsAs;
    }
    if (tab.session !== undefined) {
        /* The session comes back exactly as it was stored, all three bindings included: a session resumes only
         * on the runtime and account that minted it, so forging the match would resume another account's
         * session and faking a mismatch would retire a live one at the next send.
         *
         * Nothing is filled in from the tab here, which is the point — a missing account means no stored
         * account minted this session (the container's env token, a translator subscription), and standing the
         * remembered pick in its place invented the very agreement `resumes` exists to test. */
        conversation.session.value = tab.session;
    }
    if (tab.forkOf !== undefined) {
        // The fork linkage, back where send() looks for it. Until the fork's first turn is accepted this is the
        // only record of the cut anywhere, and a tab rebuilt without it sends an ordinary first turn, the
        // daemon then opens an empty record and the "continued" chat answers from nothing (see StoredTab.forkOf).
        conversation.pendingForkOf.value = tab.forkOf;
    }
    return conversation;
};

// Rebuild this window's tab set for the active sandbox, its own snapshot, the last window's as a seed, or a
// single fresh tab when neither exists, and focus the stored active tab.
export const restoreTabs = (): void => {
    scopedSandboxId = activeSandboxId.value;
    // Scoped BEFORE the tabs are built, because building one resolves an account: a fresh conversation seeds
    // from this pick (Conversation's constructor), and a restored one falls back to it. Scoped with the tabs,
    // the ids name credentials in THIS sandbox's store, so the incoming sandbox's picks replace the outgoing
    // one's rather than being cleared to nothing.
    scopeAccountPreference(scopedSandboxId);
    const stored = readTabSnapshot(scopedSandboxId);
    // The list is about to be REPLACED wholesale, focus included: the snapshot's active tab wins over whatever
    // is on screen. Rare (a sandbox switch, a boot) and invisible when it isn't, hence the line.
    traceFocus(`restore-tabs`, { sandbox: scopedSandboxId ?? `none`, stored: stored?.tabs.length ?? 0, active: stored?.active ?? `none` });
    if (stored === undefined) {
        // Nothing to restore, so this window opens on the blank: a composer to start in, and no card anywhere
        // for a chat the user has not started (Conversation.standIn).
        const conversation = standIn();
        setConversations([conversation], conversation.conversationId, `first-tab`);
        return;
    }
    // `stored.active` names one of the tabs, the reader guarantees it.
    setConversations(stored.tabs.map(restoreTab), stored.active, `restore-snapshot`);
    /* The pane set comes back with the tabs: how this window is laid out is a decision the user made, and a
     * reload is not a decision to collapse it back to one chat. Assigned rather than run through setPanes,
     * which is the only caller with an authoritative ORDER, the columns come back where they were left.
     * Filtered against what actually restored, since the write above sweeps an untouched draft and a pane
     * naming one would be a column with nothing in it. */
    const restored = new Set(conversations.value.map((conversation) => conversation.conversationId));
    const held = stored.panes.filter((id) => restored.has(id));
    panes.value = held.length > 0 ? held : [activeId.value];
};

restoreTabs();

/* WHICH WINDOW REMEMBERS THE STRIP, and it is exactly the window that is DRAWING it. There is one chat surface
 * at a time (composables/floating.ts): while the chat is in a window of its own, this window shows no chat, so
 * it has no view state for one, and the strip it remembers from before the move is not a memory but a stale
 * copy. Keeping it is what made a docked chat come back wearing tabs the reader had closed out there.
 *
 * So the rule is two sides of one fact:
 *   · SHOWING it, write on every change, which also re-seeds the next window (windowStore's two stores).
 *   · NOT showing it, forget, and read the seed back the moment the panel returns. A brand-new floating window
 *     and a window taking the panel back therefore travel the same path, the one a fresh window always took.
 * Nothing is exchanged between the two windows and nothing has to be handed over: the seed is the handoff.
 * `drawsChat` (chatEcho.ts) is that reading. */

/* WHEN EACH COMPOSER FIRST HELD SOMETHING UNSENT (Conversation.draftAt), stamped here and nowhere else.
 * Something arrives in a composer by five routes — typing, an upload finishing, a message queued behind a
 * running turn, a fork seeding the box, an edit mode handing back the draft it displaced — and a stamp written
 * at each of them is five chances to miss one, so this watches the FLAG all five feed instead.
 *
 * THE EDGE, BOTH WAYS: an empty stamp is filled the first time a chat reads as unsent, and cleared the moment it
 * stops being one. Filling only the EMPTY ones is what makes it idempotent, and that is what lets a restored tab
 * keep the instant it was persisted with (restoreTab) rather than being re-stamped as fresh by its own restore.
 *
 * The key is the flags alone, so it runs on a transition or on the list changing and never per keystroke. That
 * is load-bearing for the echo below, which carries the stamp: one that moved with every character would undo
 * exactly what that publish key is shaped to avoid. */
watch(
    () => conversations.value.map((conversation) => `${conversation.conversationId}:${conversation.unsent.value ? 1 : 0}`).join(`,`),
    () => {
        for (const conversation of conversations.value) {
            if (!conversation.unsent.value) {
                conversation.draftAt.value = undefined;
            } else if (conversation.draftAt.value === undefined) {
                conversation.draftAt.value = Date.now();
            }
        }
    },
    { immediate: true },
);

/* WORDS IN A PEEKED CHAT KEEP IT, the promotion that matters most and the only one this store makes on the
 * user's behalf: everything else that promotes is an act the chat performs on itself (Conversation.keep) or a
 * press on the card. It watches the same flag the stamp above does, and for the same reason — something reaches
 * a composer by five routes, and a promotion that missed one of them would be a message swept away with the tab
 * that held it.
 *
 * The sweep spares an unsent tab regardless (`transient`); what this adds is taking the MARK off the card, so a
 * chat stops calling itself temporary the moment it stops being so. */
watch(
    () => conversations.value.map((conversation) => `${conversation.conversationId}:${conversation.unsent.value ? 1 : 0}`).join(`,`),
    () => {
        for (const conversation of conversations.value) {
            if (conversation.unsent.value) {
                conversation.keep();
            }
        }
    },
    { immediate: true },
);

// The stringified getter touches every persisted field, so tab open/close/switch, keystrokes, uploads finishing
// and session commits all write through automatically. Registered AFTER the stamp above so a draft's first
// keystroke persists with its stamp in the same flush rather than one behind it.
// ponytail: writes per keystroke; the blob is tiny, throttle if profiling shows jank.
watch(
    () =>
        JSON.stringify({
            active: activeId.value,
            panes: panes.value,
            tabs: conversations.value.map(snapshotTab),
        }),
    (json) => {
        if (scopedSandboxId !== undefined && drawsChat.value) {
            writeTabSnapshot(scopedSandboxId, json);
        }
    },
);

watch(drawsChat, (draws) => {
    if (draws) {
        restoreTabs();
        return;
    }
    forgetTabSnapshot(scopedSandboxId);
});

// "Put the caret in the composer", as a signal rather than a call: the conversation list is store state, but
// the caret belongs to whichever chat surface is mounted (the docked panel, the mobile detail, a floating
// window), and only that component holds the textarea. A counter, not a flag, two "New agent" presses in a
// row must each land, and a re-focus of the same conversation is still a distinct request.
export const composerFocus = ref(0);
export const focusComposer = (): void => {
    composerFocus.value++;
};

// "Put the focused tab on screen", the counterpart of composerFocus and a counter for the same reason: the tab
// list is store state, but the SCROLL belongs to whichever strip is mounted, and asking again for the tab that
// is already focused, clicking its card on the fleet board while the strip is scrolled elsewhere, is still a
// distinct request. A plain activeId watch cannot see that one, since the id doesn't move.
export const tabReveal = ref(0);

// Focus a tab, through the one writer, so leaving an untouched draft takes it with the same write that moves
// the focus. An id that names no open conversation is ignored rather than written: setConversations would seat
// the focus on the last tab instead, and a stale click would silently surface a chat the user didn't ask for.
export const setActive = (conversationId: string): void => {
    if (conversations.value.some((conversation) => conversation.conversationId === conversationId)) {
        setConversations(conversations.value, conversationId, `select`);
        tabReveal.value++;
    }
};

const isOpen = (conversationId: string): boolean => conversations.value.some((conversation) => conversation.conversationId === conversationId);

/* --- The panes ---------------------------------------------------------------------------------
 * Three verbs over the pane set, and the only ways to change how many chats are on screen, everything else
 * that touches the focus goes through setActive and swaps a column rather than adding one.
 *
 * Give a chat a column of its OWN, immediately right of the focused pane (VSCode's Open to the Side), and put
 * the focus in it. Already on screen ⇒ this is just a focus move, which is what the user means by asking for a
 * chat they can already see.
 *
 * The column is claimed for an id that need not name an open tab YET, so a surface handing over a conversation
 * it is about to open, the fleet board's cards, calls this FIRST and opens second. That order is what stops
 * the opening from eating the focused pane's column on its way in: by the time the pane set is reconciled the
 * id names a real tab, the focus is already inside the set, and the chat that was there keeps its place. A
 * claim nobody follows through on costs nothing, the next reconcile drops an id that names no tab. */
export const openBeside = (conversationId: string): void => {
    claimColumnBeside(conversationId);
    setActive(conversationId);
};

// The claim alone, without the focus move: reveal's `beside` verb takes the column BEFORE its list write (its
// note has why), and openBeside is this followed by the focus. Already on screen ⇒ nothing to claim.
export const claimColumnBeside = (conversationId: string): void => {
    /* ARRANGING THE SCREEN KEEPS EVERY CHAT ON IT: the arriving column, and the ones already up. A split is the
     * gesture that says "these, together", so both halves stop being looks — and the second half is the one that
     * matters, because the chat the reader is putting this one BESIDE is usually the card they just clicked,
     * which is a peek, and it would otherwise be swept by the very focus move that opens the new column. */
    for (const id of [conversationId, ...panes.value]) {
        keepChat(id);
    }
    if (!panes.value.includes(conversationId)) {
        const beside = panes.value.indexOf(activeId.value);
        panes.value = panes.value.toSpliced(beside === -1 ? panes.value.length : beside + 1, 0, conversationId);
    }
};

// Take a chat's column back. The chat itself stays open, it is still in the rail, one click from a column
// again, and the last pane is never closed, since that one IS the panel.
export const closePane = (conversationId: string): void => {
    if (panes.value.length < 2 || !panes.value.includes(conversationId)) {
        return;
    }
    const rest = panes.value.filter((id) => id !== conversationId);
    panes.value = rest;
    if (activeId.value === conversationId) {
        // The neighbour that took its place on screen, which is where the eye already is.
        setActive(rest.at(-1)!);
    }
};

/* BACK TO ONE COLUMN, the reset half of the gesture set, and the counterpart of setPanes.
 *
 * Every list that lets Shift and Ctrl build a selection also lets a PLAIN click replace it, and the surfaces
 * that put chats in columns (the rail's rows, the board's cards) are such lists: the ringed cards ARE the pane
 * set, so a click carrying no modifier means "just this one" there exactly as it does in a file list. Without
 * it a split could only be left one × at a time, which made arriving cheaper than leaving, and left actions
 * scoped to "what is on screen" (Synthesize) acting on a column the user thought they had walked away from.
 *
 * It names no id on purpose: the click has already moved the focus, so the chat to keep IS the focused one.
 * That also keeps it out of setActive, where it would wrongly collapse a deep link's or a history row's
 * arrival, those are not gestures on a selection.
 *
 * Its other caller is reveal's `show` verb, which is the same shape of act wherever the summons came from: a
 * card click, New agent, an accepted suggestion, one chat asked for, one chat on screen. */
export const collapsePanes = (): void => {
    if (panes.value.length > 1) {
        panes.value = [activeId.value];
    }
};

/* The pane set as a whole, what a multi-selection on the rail or the board lands as. Chats already on screen
 * KEEP their columns and the newcomers are appended in the order given, so adding a third chat never reshuffles
 * the two the user is reading. An empty selection is not a request for an empty panel and is ignored; the way
 * to have fewer panes is to close one. */
export const setPanes = (ids: readonly string[]): void => {
    const wanted = [...new Set(ids)].filter(isOpen);
    if (wanted.length === 0) {
        return;
    }
    // Every chat in the set is being put on screen deliberately, so none of them is a look any more
    // (claimColumnBeside's note): a Shift-run keeps its whole run.
    for (const id of wanted) {
        keepChat(id);
    }
    const kept = panes.value.filter((id) => wanted.includes(id));
    panes.value = [...kept, ...wanted.filter((id) => !kept.includes(id))];
    if (!panes.value.includes(activeId.value)) {
        setActive(panes.value[0]!);
    }
};

/* TWO CLOSES, and what they mean is decided by the surface the press was made on rather than by what the tab
 * holds.
 *
 *   · THE PANEL'S OWN × (a rail row, the strip menu's Close / Close Others / Close to the Right / Close All)
 *     takes the chat OFF THIS SURFACE. The panel is an operating surface, the subset of conversations the reader
 *     has chosen to look at, and its × narrows that subset; the conversation itself goes on existing, on the
 *     board and in History. So the one thing a close would destroy is set aside instead (closedDrafts): a
 *     message standing in the composer lives in this browser and nowhere else, and the board goes on drawing a
 *     card for it, named by the message, which is how the words come back (resolveEntry claims them). The whole
 *     tab is kept, not merely its text, because what is unsent may be a staged attachment or a message queued
 *     behind a running turn, and because the chat has to come back as itself (its picks, its session, its
 *     persona) rather than as a fresh tab wearing somebody's words.
 *   · THE BOARD'S × CLOSES THE CONVERSATION (closeConversations, below): a card is the conversation seen from
 *     the board, so its × is the thing itself going, the tab in every window and the words with it, in one press.
 *     Setting the words aside here was tried and read as a close that did nothing: the tab left the popped-out
 *     chat while the card stayed, now standing for the message, and only a second × on that same card took it.
 *
 * Both detach from each in-flight turn (Conversation.abort is soft, the daemon-side run keeps working and
 * reopening reattaches to it), drop each cached transcript, and keep at least one conversation, a fresh chat
 * when the set empties the strip. Closing the active tab moves focus to the tab it was on before. The
 * daemon-side sessions survive: a closed chat is still in History.
 *
 * ONLY THE WINDOW DRAWING THE CHAT PUTS WORDS ASIDE (drawsChat, chatEcho.ts): a window that is not drawing it
 * holds a shadow of the strip, frozen at whatever was in its composers when the panel left, and a close that
 * stored one of those would set aside a message the user has since sent out in the floating window — offered
 * back, by a later card click, into the composer they sent it from. Such a window still closes its copy; it just
 * has nothing to say about what was in it. */
const closing = (ids: ReadonlySet<string>, unsent: `keep` | `drop`): void => {
    traceFocus(`close`, { ids: [...ids], active: activeId.value, unsent });
    for (const conversation of conversations.value) {
        if (ids.has(conversation.conversationId)) {
            if (unsent === `keep` && conversation.unsent.value && drawsChat.value) {
                keepClosedDraft(snapshotTab(conversation));
            }
            conversation.abort();
            void dropTranscript(conversation.conversationId);
        }
    }
    const remaining = conversations.value.filter((conversation) => !ids.has(conversation.conversationId));
    /* CLOSING THE LAST CARD MEANS NOTHING IS OPEN, and the blank left standing says exactly that: a composer to
     * start in, no card on the fleet board, and so no card selected there either (Conversation.standIn). It used
     * to be a plain `new Conversation()`, indistinguishable from a "New agent" the user had pressed, so the
     * press that emptied the chat put a fresh card in the board's Active lane and ringed it — /agents claiming a
     * session was selected while the window that closed it showed an empty chat. */
    const next = remaining.length > 0 ? remaining : [standIn()];
    setConversations(next, activeId.value, `close`);
};

/** The panel's close: these chats leave THIS surface, and whatever was unsent in them is set aside. */
export const closeTabs = (ids: ReadonlySet<string>): void => {
    closing(ids, `keep`);
};

/** The board's close: these CONVERSATIONS go, the tab in this window and the words set aside for them alike.
 *  Applied by every window from the board's summons (summon.ts), so the forgetting is idempotent: the first
 *  window to apply it empties the shared store, and the rest find nothing there. */
export const closeConversations = (ids: ReadonlySet<string>): void => {
    for (const id of ids) {
        forgetClosedDraft(id);
    }
    closing(ids, `drop`);
};

/* THE SAME CLOSE, ASKED FOR BY THE DAEMON RATHER THAN BY THE USER, the tabs of agents that left the roster
 * without this browser doing it: the retention sweep filing a finished agent away (the daemon's
 * agents/archive.ts), or an archive or discard performed on another device.
 *
 * It exists because the two halves of "an agent is a card and a tab" only ever moved together when the press
 * happened HERE: archiving from this board closes the chat with the card (useAgents.archive), while the sweep
 * that does the same thing on its own left the tab behind. That is the whole of why the chat list's Finished
 * lane grew without bound while /agents stayed clean, the sweep is the board's cleaner and was the chat
 * list's litter. Nothing is lost either way (see closeTabs): the transcript is in History, and reopening the
 * agent from there brings the tab straight back.
 *
 * TWO TABS ARE SPARED, and both are about not taking something out from under the user:
 *   · the FOCUSED chat, the sweep runs on a clock the user cannot see, and a panel that empties itself
 *     mid-read is the worst thing an unattended cleaner can do. It reads as archived (ChatTabList's box mark)
 *     and closes like any other tab when the user is done with it.
 *   · one holding UNSENT INPUT (Conversation.unsent), every other thing a chat holds survives a close; those
 *     words do not. The board makes the same promise from the other side: a session holding them keeps its
 *     card, so a sweep that spares the tab can't leave the fleet reporting the work as gone. */
export const closeRetired = (ids: ReadonlySet<string>): void => {
    const retired = new Set(
        conversations.value
            .filter(
                (conversation) =>
                    ids.has(conversation.conversationId) && conversation.conversationId !== activeId.value && !conversation.unsent.value,
            )
            .map((conversation) => conversation.conversationId),
    );
    if (retired.size > 0) {
        closeTabs(retired);
    }
};

// A singleton per window (hotReload.ts): a hot update that re-ran this module would mint a second tab store
// beside the one the rest of the app still reads.
reloadOnHotUpdate(import.meta);
