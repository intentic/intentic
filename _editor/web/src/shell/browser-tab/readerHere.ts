import { computed, type ComputedRef, ref } from "vue";
import { uuid } from "../../lib/uuid";

// Is the reader in the app right now: this window focused, or one of its popped-out panels. Stricter than onScreen,
// which a window visible on a second monitor answers yes to while the reader types elsewhere: a sound and a "finished
// while you were away" mark are for exactly that reader. Every window of the app answers for itself over a channel,
// so a chat popped out beside the main window does not read as the reader having left.

type ReaderNote = { readonly kind: `focus`; readonly id: string; readonly focused: boolean } | { readonly kind: `roll` };

const id = uuid();

// allow(module-state): whether this window has the reader's focus, one answer per document
const focusedHere = ref(false);
// allow(module-state): the other windows of the app that say the reader is in them
const focusedElsewhere = ref<ReadonlySet<string>>(new Set());

export const readerHere: ComputedRef<boolean> = computed(() => focusedHere.value || focusedElsewhere.value.size > 0);

const channel = window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.reader`);

const post = (note: ReaderNote): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
    channel?.postMessage(note);
};

const sync = (): void => {
    const focused = document.visibilityState === `visible` && document.hasFocus();
    if (focused) {
        // One window has the focus at a time, so whatever another window said last is over. Also what heals a claim a
        // crashed window never took back.
        focusedElsewhere.value = new Set();
    }
    if (focused !== focusedHere.value) {
        focusedHere.value = focused;
        post({ kind: `focus`, id, focused });
    }
};

/** The one entry point for a note from another window; exported for tests. */
export const receiveReaderNote = (note: ReaderNote): void => {
    if (note.kind === `roll`) {
        post({ kind: `focus`, id, focused: focusedHere.value });
        return;
    }
    if (note.focused === focusedElsewhere.value.has(note.id)) {
        return;
    }
    const next = new Set(focusedElsewhere.value);
    if (note.focused) {
        next.add(note.id);
    } else {
        next.delete(note.id);
    }
    focusedElsewhere.value = next;
};

window.addEventListener(`focus`, sync);
// Read a beat later: focus moving into one of this page's own frames (the preview, an extension) blurs the window first
// and only then settles where hasFocus() can see it.
window.addEventListener(`blur`, () => setTimeout(sync, 0));
document.addEventListener(`visibilitychange`, sync);
window.addEventListener(`pagehide`, () => post({ kind: `focus`, id, focused: false }));
channel?.addEventListener(`message`, (event: MessageEvent<ReaderNote>) => receiveReaderNote(event.data));
sync();
post({ kind: `roll` });
