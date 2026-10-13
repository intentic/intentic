import { ref } from "vue";

/* Jump palette (Ctrl/Cmd+P) state, as a module-level singleton (like useWorkspaceTabs' refs): the desktop shell's global keydown flips it open. */
// allow(module-state): whether the palette is open
const isOpen = ref(false);
// Which scope the chord that opened it seeds — the palette itself searches every kind, and the field's prefix is what
// narrows it. Two doors, one room: a third chord would be a decision to make before the search.
// allow(module-state): which chord opened the palette
const mode = ref<"all" | "commands">(`all`);
// What the field opens holding, once, when something other than a chord opened it (a "Search files for…" button); the
// palette takes it as it shows.
// allow(module-state): the words the palette's next opening starts from
const seed = ref<string | undefined>(undefined);
// Whether this window draws a palette at all: a popped-out chat does not, and a button that would open one there opens
// nothing, so it is not offered.
// allow(module-state): whether a palette is mounted in this window
const mounted = ref(false);

export function useQuickOpen() {
    return { isOpen, mode, seed, mounted };
}

// Opens the palette already searching for `query`.
export const searchInQuickOpen = (query: string): void => {
    seed.value = query;
    mode.value = `all`;
    isOpen.value = true;
};
