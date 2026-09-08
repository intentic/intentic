import { computed, ref, shallowRef, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { forgetClosedDraft, keepClosedDraft } from "../drafts/closedDrafts";
import { drawsChat } from "../run/chatEcho";
import { traceFocus } from "../run/focusTrace";
import { Conversation } from "../session/conversation";
import { rememberedAccountFor } from "../accounts/providerAccounts";
import { rememberedModelFor, startingMode } from "../run/turnDefaults";
import { scopeAccountPreference } from "../accounts/accountPreference";
import { tabFacts, untouched } from "./tabFacts";
import { forgetTabSnapshot, readTabSnapshot, snapshotTab, type StoredTab, writeTabSnapshot } from "./tabSnapshot";
import { dropTranscript } from "../transcript/transcriptCache";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { uuid } from "../../../lib/uuid";

const { activeSandboxId } = useSandbox();

// A tab is its conversation, focus is the conversationId itself; no separate tab id (a counter-based one let
// resets alias two chats). shallowRef keeps each Conversation's own reactive fields intact; reassign the array
// to update.
export const conversations = shallowRef<Conversation[]>([]);
export const activeId = ref<string>(``);

// An untouched draft only exists while focused (else it's swept): the tab and the board's draft card are one
// conversation, so an abandoned one squats in Active looking like real work. Read off this window's own
// conversation, not the echo.
export const untouchedDraft = (conversation: Conversation): boolean => untouched(tabFacts(conversation));

// Tabs that exist only while focused: an untouched draft, or a peeked chat with nothing unsent. A sweep
// destroys nothing (card and History survive, a running turn just detaches). Words in the composer spare a
// peek regardless of its flag.
const transient = (conversation: Conversation): boolean => untouchedDraft(conversation) || (conversation.peek.value && !conversation.unsent.value);

// The blank a window shows with nothing open (Conversation.standIn), minted here so both call sites (no tabs
// to restore, or a close taking the last card) leave the same thing. Unflagged, the board would card and ring
// a chat nobody asked for.
const standIn = (): Conversation => {
    const conversation = new Conversation();
    conversation.standIn.value = true;
    return conversation;
};

/**
 * Promotes a peeked tab into an ordinary one, by id, for surfaces (a card's pin, its menu) that hold an id
 * rather than the live chat. A chat acting on itself uses Conversation.keep instead.
 */
export const keepChat = (conversationId: string): void => {
    conversations.value.find((conversation) => conversation.conversationId === conversationId)?.keep();
};

// The one writer of the tab list and the focus, holding two invariants in one write:
// - focus lands on a tab actually in the list, the last one if its own tab closed (VSCode's rule)
// - at most one transient tab is open, and only as the focused one
// Enforced here, not by a watcher after the fact, so an explicit action and an implicit reaper can't race.

// Focus history, most recent last: where focus goes when its tab closes, the one visited just before.
let recent: readonly string[] = [];

// Detaches a swept tab's turn (soft abort) on the way out, since a peek may be watching one; an untouched
// draft has none. The cached transcript is kept, unlike a close's, since a look is often repeated.
const detachSwept = (next: readonly Conversation[], kept: readonly Conversation[]): void => {
    for (const conversation of next) {
        if (!kept.includes(conversation)) {
            conversation.abort();
        }
    }
};

export const setConversations = (next: readonly Conversation[], focus: string, reason: string): void => {
    const open = (id: string): boolean => next.some((conversation) => conversation.conversationId === id);
    // Focus falls first to an open pane, then the most recently focused tab, then the list's last.
    const focused = open(focus) ? focus : (panes.value.find(open) ?? recent.findLast(open) ?? next.at(-1)!.conversationId);
    // The focused tab is always kept, so the list can't come out empty; a dropped tab needs no teardown.
    const kept = next.filter((conversation) => conversation.conversationId === focused || !transient(conversation));
    // Traces the focus and its fallback (focusTrace.ts) only when it actually moves, to catch a silent misroute.
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
    // Reassigned only when the list actually changed, so a plain focus switch doesn't refire list watchers.
    if (kept.length !== conversations.value.length || kept.some((conversation, at) => conversation !== conversations.value[at])) {
        conversations.value = kept;
    }
    // Before the focus moves: which column the incoming chat lands in depends on where the focus is leaving from.
    reconcilePanes(kept, focused);
    activeId.value = focused;
    // Closed tabs drop out of the order; the focused one moves to its head.
    recent = [...recent.filter((id) => id !== focused && kept.some((conversation) => conversation.conversationId === id)), focused];
};

// Chats on screen at once, in the order they were opened, not the rail's lane order (which would reshuffle
// columns mid-read). The focused pane (activeId) is always a member.
export const panes = ref<string[]>([]);

// Keeps the pane invariants (every pane open, focus always in one) in step with the tab list. A click/card/deep
// -link lands on setActive and swaps the focus's own column rather than opening a new one; openBeside/setPanes
// open, collapsePanes closes.
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

// The focused conversation; find always hits since setConversations reconciles focus with the list. `list[0]`
// is a floor against a stale id, not a crash.
export const active = computed<Conversation>(() => {
    const list = conversations.value;
    return list.find((conversation) => conversation.conversationId === activeId.value) ?? list[0]!;
});

// Snapshot shape/storage live in tabSnapshot.ts; here is only when it's read/written. The sandbox is recorded
// at restore, not read live, so a mid-flip write can't land in the incoming sandbox's key as the outgoing one's.
let scopedSandboxId: string | undefined;

// Everything waiting to be sent, back in the composer: message, age, staged files, queued turns. Its own
// function since two arrivals restore a composer (a snapshot restore, a reopened closed draft).
export const restoreComposer = (conversation: Conversation, tab: StoredTab): void => {
    conversation.draft.value = tab.draft;
    // The stamping watch only fills an empty stamp, so this keeps the restored instant, not a fresh one.
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
    // Set before anything that could talk to a daemon: this is the tab's address, asked first.
    conversation.box.value = tab.box;
    // Posture isn't part of the snapshot; a restored tab starts from its tree's mode, like a fresh one.
    conversation.modePick.value = startingMode(conversation.isolated.value);
    // A looked-at tab restores as still looking; it's always the focused tab, swept by the next click elsewhere.
    conversation.peek.value = tab.peek === true;
    // A stand-in blank restores as one too; unflagged, it would board a fresh, selected "New agent" card.
    conversation.standIn.value = tab.standIn === true;
    // The card's account of the agent, so a restored tab lanes the way its board card does before the roster lands.
    conversation.standing.value = tab.standing;
    restoreComposer(conversation, tab);
    conversation.title.value = tab.title ?? null;
    // Restore harness before model: native and claude-code model lists diverge for codex/grok.
    if (tab.harness !== undefined) {
        conversation.harness.value = tab.harness;
    }
    if (tab.provider !== undefined) {
        conversation.provider.value = tab.provider;
        // An open chat keeps its own account, not the provider's remembered pick; only an unpinned tab falls back.
        conversation.account.value = tab.account ?? rememberedAccountFor(tab.provider);
        conversation.model.value = tab.model ?? rememberedModelFor(tab.provider);
        // Whether the app parked it on a fallback account (a mid-redirect), so reconciliation can move it back later.
        conversation.movedFrom.value = tab.movedFrom;
        // Same for a model a thin catalog moved it off: the debt outlives the window that took it on.
        conversation.displacedModel.value = tab.displacedModel;
    }
    // Turn settings restore per tab: they describe this chat, not picks made in some other tab since.
    if (tab.thinking !== undefined) {
        conversation.thinking.value = tab.thinking;
    }
    if (tab.fast !== undefined) {
        conversation.fast.value = tab.fast;
    }
    // tierHold is a pick like the others; tier is the judge's verdict, not re-derivable from a draft.
    if (tab.tierHold !== undefined) {
        conversation.tierHold.value = tab.tierHold;
    }
    if (tab.tier !== undefined) {
        conversation.lastTier.value = tab.tier;
    }
    // Restored because it governs unattended runs; a reload must not quietly disarm one still in progress.
    if (tab.autoContinue !== undefined) {
        conversation.autoContinue.value = tab.autoContinue;
    }
    // The stopped-turn offer itself doesn't restore here; only the daemon knows if it's still held (see adoptEnding).
    if (tab.effort !== undefined) {
        conversation.effortPick.value = tab.effort;
    }
    // Persona restores per tab; nothing else remembers it, so a drop would silently hand back every account.
    if (tab.actsAs !== undefined) {
        conversation.actsAs.value = tab.actsAs;
    }
    if (tab.session !== undefined) {
        // Restored exactly as stored: filling gaps from the tab's own picks could resume or retire the wrong session.
        conversation.session.value = tab.session;
    }
    if (tab.forkOf !== undefined) {
        // Fork linkage, back where send() looks for it; missing here, a rebuild sends an unseeded first turn.
        conversation.pendingForkOf.value = tab.forkOf;
    }
    return conversation;
};

// Rebuilds this window's tabs for the active sandbox: its own snapshot, the last window's as a seed, or one
// fresh tab if neither exists; focuses the stored active tab.
export const restoreTabs = (): void => {
    scopedSandboxId = activeSandboxId.value;
    // Scoped before the tabs are built: a fresh or restored conversation resolves its account from this pick.
    scopeAccountPreference(scopedSandboxId);
    const stored = readTabSnapshot(scopedSandboxId);
    // The list is replaced wholesale, focus included; rare and otherwise invisible, hence the trace.
    traceFocus(`restore-tabs`, { sandbox: scopedSandboxId ?? `none`, stored: stored?.tabs.length ?? 0, active: stored?.active ?? `none` });
    if (stored === undefined) {
        // Nothing to restore: opens on the blank, with no board card for a chat never started.
        const conversation = standIn();
        setConversations([conversation], conversation.conversationId, `first-tab`);
        return;
    }
    // `stored.active` names one of the tabs; the reader guarantees it.
    setConversations(stored.tabs.map(restoreTab), stored.active, `restore-snapshot`);
    // Panes restore with the tabs, assigned directly (not through setPanes) to keep their stored order. Filtered
    // against what actually restored, since the list write above can sweep an untouched draft.
    const restored = new Set(conversations.value.map((conversation) => conversation.conversationId));
    const held = stored.panes.filter((id) => restored.has(id));
    panes.value = held.length > 0 ? held : [activeId.value];
};

restoreTabs();

// The window drawing the chat remembers the strip: written on every change while drawing, forgotten (falling
// back to the seed) the moment it stops. Nothing is handed between windows; the seed is the handoff
// (drawsChat, chatEcho.ts).

// Stamps when a composer first went unsent (draftAt), watching the flag alone since content arrives by five
// routes. Idempotent (fills only an empty stamp), so restore keeps its persisted instant, and fires per
// transition, not per keystroke.
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

// Words in a peeked chat keep it (Conversation.keep) — the one promotion this store makes for the user.
// Watches the same unsent flag as the stamp above, so it can't miss the same five arrival routes.
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

// Touches every persisted field, so any change writes through automatically; registered after the stamp watch
// so a keystroke's stamp lands in the same flush. Writes per keystroke; throttle later if profiling shows jank.
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

// A signal since the caret belongs to whichever surface is mounted; a counter so repeat requests each land.
export const composerFocus = ref(0);
export const focusComposer = (): void => {
    composerFocus.value++;
};

// Scroll counterpart of composerFocus; a counter since re-focusing the same tab is still a distinct request.
export const tabReveal = ref(0);

// Focuses a tab through the one writer, so an untouched draft leaves in the same write. An id naming no open
// tab is ignored, not written, so a stale click can't surface the wrong chat.
export const setActive = (conversationId: string): void => {
    if (conversations.value.some((conversation) => conversation.conversationId === conversationId)) {
        setConversations(conversations.value, conversationId, `select`);
        tabReveal.value++;
    }
};

const isOpen = (conversationId: string): boolean => conversations.value.some((conversation) => conversation.conversationId === conversationId);

// Three verbs change how many chats are on screen; everything else goes through setActive and swaps a column
// instead of adding one. openBeside gives a chat its own column beside the focus (or just refocuses it if
// already open).
export const openBeside = (conversationId: string): void => {
    claimColumnBeside(conversationId);
    setActive(conversationId);
};

// The claim alone, without the focus move (reveal's `beside` verb needs the column before its list write).
// No-op if already on screen.
export const claimColumnBeside = (conversationId: string): void => {
    // Keeps every chat on screen, not just the new one, so the opening focus move can't sweep a peeked neighbour.
    for (const id of [conversationId, ...panes.value]) {
        keepChat(id);
    }
    if (!panes.value.includes(conversationId)) {
        const beside = panes.value.indexOf(activeId.value);
        panes.value = panes.value.toSpliced(beside === -1 ? panes.value.length : beside + 1, 0, conversationId);
    }
};

// Takes a chat's column back; the chat stays open (still in the rail), and the last pane never closes since
// that one is the panel.
export const closePane = (conversationId: string): void => {
    if (panes.value.length < 2 || !panes.value.includes(conversationId)) {
        return;
    }
    const rest = panes.value.filter((id) => id !== conversationId);
    panes.value = rest;
    if (activeId.value === conversationId) {
        // The neighbour that took its place on screen, where the eye already is.
        setActive(rest.at(-1)!);
    }
};

// Resets to one column: the pane rows/cards are a multi-select list, and a plain click replaces the selection
// the way Shift/Ctrl build it. Names no id since the click already moved the focus; also used by reveal's
// `show` verb.
export const collapsePanes = (): void => {
    if (panes.value.length > 1) {
        panes.value = [activeId.value];
    }
};

// The pane set as a whole, from a multi-selection: chats already on screen keep their columns, newcomers
// append in order. An empty selection is ignored; close a pane to have fewer.
export const setPanes = (ids: readonly string[]): void => {
    const wanted = [...new Set(ids)].filter(isOpen);
    if (wanted.length === 0) {
        return;
    }
    // Every chat in the set is deliberately on screen now, so none of them is still just a look.
    for (const id of wanted) {
        keepChat(id);
    }
    const kept = panes.value.filter((id) => wanted.includes(id));
    panes.value = [...kept, ...wanted.filter((id) => !kept.includes(id))];
    if (!panes.value.includes(activeId.value)) {
        setActive(panes.value[0]!);
    }
};

// Two closes, chosen by which surface pressed it:
// - the panel's x (row, menu): takes the chat off this surface only; unsent words are set aside (closedDrafts)
//   since the conversation survives on the board and in History
// - the board's x (closeConversations): closes the conversation everywhere, tab and words together
// Both soft-abort the turn and drop the cached transcript; only the window drawing the chat sets words aside.
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
    // Closing the last card leaves the standIn blank, not an indistinguishable fresh "New agent".
    const next = remaining.length > 0 ? remaining : [standIn()];
    setConversations(next, activeId.value, `close`);
};

/** The panel's close: these chats leave this surface, and whatever was unsent in them is set aside. */
export const closeTabs = (ids: ReadonlySet<string>): void => {
    closing(ids, `keep`);
};

/**
 * The board's close: these conversations go everywhere, tab and unsent words alike. Applied by every window
 * from the summons, idempotently (the first empties the shared store).
 */
export const closeConversations = (ids: ReadonlySet<string>): void => {
    for (const id of ids) {
        forgetClosedDraft(id);
    }
    closing(ids, `drop`);
};

// The same close, asked by the daemon rather than the user: tabs whose agent left the roster without this
// browser closing it (a retention sweep, or an archive/discard elsewhere). Spares two:
// - the focused chat, so an unattended sweep can't empty the panel mid-read
// - one holding unsent input, since a close would lose it
// History still has the transcript either way.
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

// One store per window: a hot update re-running this module would mint a second one beside it.
reloadOnHotUpdate(import.meta);
