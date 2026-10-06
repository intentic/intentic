import { ref } from "vue";

/* Jump palette (Ctrl/Cmd+P) state, as a module-level singleton (like useWorkspaceTabs' refs): the desktop shell's global keydown flips it open. */
// allow(module-state): whether the palette is open
const isOpen = ref(false);
// Which scope the chord that opened it seeds — the palette itself searches every kind, and the field's prefix is what
// narrows it. Two doors, one room: a third chord would be a decision to make before the search.
// allow(module-state): which chord opened the palette
const mode = ref<"all" | "commands">(`all`);

export function useQuickOpen() {
    return { isOpen, mode };
}
