import { ref } from "vue";

/* Quick Open (Ctrl/Cmd+P) palette state, as a module-level singleton (like useWorkspaceTabs' refs): the desktop
 * shell's global keydown flips it open, and the QuickOpen overlay, mounted once in the shell, binds its Dialog
 * to it, so a mask click / Esc flips it back. `mode` is which face the palette opens in: `files` for Ctrl/Cmd+P
 * (VSCode Go to File) or `commands` for Ctrl/Cmd+Shift+P (the Command Palette). The overlay seeds its query from
 * this on open, so the two shortcuts land on the two faces of the same field. */
const isOpen = ref(false);
const mode = ref<"files" | "commands">(`files`);

export function useQuickOpen() {
    return { isOpen, mode };
}
