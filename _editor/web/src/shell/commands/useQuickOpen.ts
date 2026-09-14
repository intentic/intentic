import { ref } from "vue";

/* Quick Open (Ctrl/Cmd+P) palette state, as a module-level singleton (like useWorkspaceTabs' refs): the desktop shell's global keydown flips it open. */
const isOpen = ref(false);
const mode = ref<"files" | "commands">(`files`);

export function useQuickOpen() {
    return { isOpen, mode };
}
