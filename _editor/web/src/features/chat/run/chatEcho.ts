import { computed, type ComputedRef, shallowRef, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { floatingWindowPanel, showsPanel } from "../../../shell/window/floating";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { onChatNote, postChatNote } from "./chatChannel";
import { EMPTY_STRIP, type Strip } from "../tabs/tabFacts";

// The strip, told to windows not drawing the chat: the window holding the popped-out panel publishes its whole strip,
// and every other window only reads that. Only a confirmed holder may publish, and its first snapshot publishes even
// when empty, retracting a previous realm's stale strip on reload.

const shows = showsPanel(`chat`);

/**
 * Whether this window draws the chat; optimistic during boot (reads its own tabs until a holder's first beat arrives),
 * then switches to the echo.
 */
export const drawsChat: ComputedRef<boolean> = shows;

// What the holder last said it's showing; a snapshot, never a patch.
const heard = shallowRef<Strip>(EMPTY_STRIP);

/**
 * The strip as another window draws it; empty whenever this window draws the chat itself, since then its own tabs are
 * the answer.
 */
export const elsewhereStrip: ComputedRef<Strip> = computed(() => (shows.value ? EMPTY_STRIP : heard.value));

// Kept whether or not this window is the holder, so taking ownership or a roll-call can answer without waiting for the
// next change.
let published: Strip = EMPTY_STRIP;

const holdsChat = (): boolean => floatingWindowPanel.value === `chat`;

const speak = (): void => postChatNote({ kind: `strip`, strip: published });

/** Called on every tab-store change; only a proven floating-chat holder actually puts it on the wire. */
export const publishStrip = (strip: Strip): void => {
    published = strip;
    if (holdsChat()) {
        speak();
    }
};

// Taking ownership publishes the restored strip immediately, including empty, retracting whatever the previous realm
// left on other dashboards.
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

// Asks on boot and on every sandbox switch, since a board can't otherwise see an already-floating chat. A switch
// forgets the old box's strip first; the new roll-call answer replaces it.
watch(
    useSandbox().activeSandboxId,
    () => {
        heard.value = EMPTY_STRIP;
        postChatNote({ kind: `roll` });
    },
    { immediate: true },
);

// One heard strip and reader pair per window; a hot-reloaded rerun would freeze every board on the last thing said
// before the edit.
reloadOnHotUpdate(import.meta);
