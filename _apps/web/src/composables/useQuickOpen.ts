import { ref } from "vue";

/* Quick Open (Ctrl/Cmd+P) palette visibility, as a module-level singleton (like useWorkspaceTabs' refs): the
 * desktop shell's global keydown flips it open, and the QuickOpen overlay — mounted once in the shell — binds its
 * Dialog to it, so a mask click / Esc flips it back. */
const isOpen = ref(false);

export function useQuickOpen() {
    return { isOpen };
}
