import { computed, type ComputedRef, shallowRef, watch } from "vue";
import { reloadOnHotUpdate } from "../hotReload";
import { floatingWindowPanel, showsPanel } from "../floating";
import { useSandbox } from "../sandbox/useSandbox";
import { onChatNote, postChatNote } from "./chatChannel";
import { EMPTY_STRIP, type Strip } from "./tabFacts";

/* THE STRIP, TOLD TO THE WINDOWS THAT ARE NOT DRAWING IT.
 *
 * The app runs a full copy per browser window and the chat panel's tab state is deliberately per window
 * (useChat's note). While the chat is docked that costs nothing: a window's board reads its own strip. While
 * the chat is POPPED OUT, the composer is in one window and the fleet board is in another, and the board's
 * account of the strip has to come from the window holding it. It used to come from two places at once, this
 * window's frozen copy of the tabs for "which chats are open" and an echo of the composers for "which hold
 * words", and every defect of the popped-out chat was those two disagreeing: a draft card swept because the
 * copy looked empty, an unsent chip latched because the copy still held sent words, a card that vanished and
 * came back because the copy was closed a beat before the holder said so.
 *
 * So the window that HOLDS the floating chat publishes its whole strip (tabFacts.ts: every tab as the board
 * reads it, the focus and the panes), and every other window reads that and nothing else (useChat.chatStrip).
 * Two rules keep it honest:
 *   · only the window POSITIVELY holding the floating chat speaks. A regular window briefly believes it draws
 *     every panel while booting, before the holder's roll-call arrives, so `showsPanel` is not proof of
 *     ownership, and letting it publish would let a half-restored strip overwrite the real one;
 *   · the holder's FIRST snapshot is published even when empty. A reload is a new JS realm, so suppressing its
 *     empty snapshot would leave the last realm's strip alive on every dashboard: the stale card whose chat
 *     opens onto nothing.
 * A window drawing the docked chat reads its own strip and ignores every echo, so docked chats need no publisher
 * and no stale echo can outrank the strip itself. */

const shows = showsPanel(`chat`);

/** "THIS window draws the chat", the one reading behind every choice between a local tab and the echo. It is
 *  optimistic during boot (a window believes it draws every panel until a holder's first beat arrives), which is
 *  the right way round: an unproven window answers from its own tabs, exactly as it did before the chat moved,
 *  and switches to the echo the moment the holder speaks. */
export const drawsChat: ComputedRef<boolean> = shows;

// What the holder last said it was showing. A snapshot, never a patch: the last note wins.
const heard = shallowRef<Strip>(EMPTY_STRIP);

/** The strip as another window is drawing it, for a window that is not: what `chatStrip` reads while the chat
 *  is popped out. Empty whenever this window draws the chat itself, since then its own tabs are the answer and
 *  an echo could only be a stale copy. */
export const elsewhereStrip: ComputedRef<Strip> = computed(() => (shows.value ? EMPTY_STRIP : heard.value));

// The latest strip this window could publish, kept whether or not it is the holder, so taking ownership and a
// roll-call can both answer without waiting for the next change. Filled before the floating route claims the
// panel during boot (useChat's publish watch runs at load).
let published: Strip = EMPTY_STRIP;

const holdsChat = (): boolean => floatingWindowPanel.value === `chat`;

const speak = (): void => postChatNote({ kind: `strip`, strip: published });

/** Say what this window's strip holds. Called by the tab store on every change; only the floating chat's proven
 *  holder puts it on the wire. */
export const publishStrip = (strip: Strip): void => {
    published = strip;
    if (holdsChat()) {
        speak();
    }
};

// The floating route claims the panel after this module and the tab store have booted. That positive ownership
// transition publishes the restored strip immediately, INCLUDING empty: it retracts whatever the previous realm
// left on the dashboards when this window is a reload of the floating chat.
watch(floatingWindowPanel, (panel) => {
    if (panel === `chat`) {
        speak();
    }
});

onChatNote(`roll`, () => {
    if (holdsChat()) {
        speak();
    }
});

onChatNote(`strip`, (note) => {
    heard.value = note.strip;
});

/* ASK, on boot and again on every sandbox switch. A board that opens while the chat is already floating cannot
 * see what is in it, and asking is cheaper than waiting for the next keystroke out there. On a switch the old
 * box's strip is forgotten first: its chats are none of the new board's business, and the roll-call's answer
 * (scoped to the new sandbox by the channel's envelope) is what replaces it. */
watch(
    useSandbox().activeSandboxId,
    () => {
        heard.value = EMPTY_STRIP;
        postChatNote({ kind: `roll` });
    },
    { immediate: true },
);

// One heard strip and one pair of readers per window: a hot update that re-ran this module would leave the
// channel writing the strip into an instance `chatStrip` no longer reads, and every board would freeze at the
// last thing the popped-out chat said before the edit (hotReload.ts).
reloadOnHotUpdate(import.meta);
