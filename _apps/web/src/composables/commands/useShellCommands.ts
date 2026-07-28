import type { Disposable } from "@intentic/extension-api";
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { registerCommand, type RegisteredCommand } from "./useCommands";
import { useChatPopout } from "../chat/useChatPopout";
import { useTerminalPanel } from "../terminal/useTerminalPanel";
import { useTerminalPopout } from "../terminal/useTerminalPopout";
import { useQuickOpen } from "../useQuickOpen";

/* The core shell's built-in commands: the palette's `>` command mode is empty until an extension contributes, so
 * the shell seeds its own always-available actions — navigation, the terminal panel, chat pop-out, Go to File —
 * giving a developer migrating from VSCode/Cursor a populated Command Palette (Ctrl/Cmd+Shift+P) on day one, and
 * making Intentic's own surfaces (deploy areas, terminal, previews) one keystroke away rather than a hunt. Each
 * handler calls the real composable directly — the command IS the binding, not a wrapper. Registered on mount and
 * disposed on unmount so a shell remount (mobile↔desktop crossover, HMR) can't double-register into the singleton
 * registry, which throws on a duplicate id. */
export function useShellCommands(): void {
    const router = useRouter();
    const terminal = useTerminalPanel();
    const chat = useChatPopout();
    const terminalPopout = useTerminalPopout();
    const { isOpen, mode } = useQuickOpen();

    let disposables: readonly Disposable[] = [];

    onMounted(() => {
        // Explicitly typed: the members are heterogeneous (some carry a keybinding, some don't), so without the
        // annotation TS infers a narrow union off the first entries and rejects the later push.
        const entries: Omit<RegisteredCommand, `owner`>[] = [
            {
                command: `workspace.goToFile`,
                title: `Go to File…`,
                icon: `search`,
                keybinding: `Mod+P`,
                handler: (): void => {
                    mode.value = `files`;
                    isOpen.value = true;
                },
            },
            {
                command: `workspace.commandPalette`,
                title: `Command Palette…`,
                icon: `search`,
                keybinding: `Mod+Shift+P`,
                handler: (): void => {
                    mode.value = `commands`;
                    isOpen.value = true;
                },
            },
            { command: `view.workspace`, title: `Go to Workspace`, icon: `folder`, handler: () => router.push(`/workspace`) },
            { command: `view.agents`, title: `Go to Agents`, icon: `comments`, handler: () => router.push(`/agents`) },
            { command: `view.secrets`, title: `Go to Secrets`, icon: `key`, handler: () => router.push(`/secrets`) },
            { command: `view.capabilities`, title: `Add a Capability`, icon: `plus`, handler: () => router.push(`/capabilities`) },
            { command: `view.keybindings`, title: `Keyboard Shortcuts`, icon: `sliders-h`, handler: () => router.push(`/settings/keybindings`) },
            { command: `terminal.toggle`, title: `Toggle Terminal Panel`, icon: `code`, keybinding: `Ctrl+\``, handler: () => terminal.toggle() },
            // Global (not panel-scoped like the other terminal.* commands) so it works with the panel closed —
            // spawnShell opens it and routes the create through the mounted panel's spawn hook. Ctrl+Shift+`,
            // VSCode's New Terminal chord, matched by physical key (the Backquote row) so the Shift glyph "~"
            // or a dead-key layout can't break it.
            { command: `terminal.new`, title: `New Terminal`, icon: `code`, keybinding: `Ctrl+Shift+\``, handler: () => terminal.spawnShell() },
            { command: `chat.togglePopout`, title: `Toggle Chat Pop-Out`, icon: `window-maximize`, handler: () => chat.toggle() },
            {
                command: `terminal.togglePopout`,
                title: `Toggle Terminal Pop-Out`,
                icon: `window-maximize`,
                handler: (): void => {
                    // Popping out a closed panel would float an empty window — open it first (docking keeps it open).
                    terminal.setOpen(true);
                    terminalPopout.toggle();
                },
            },
        ];
        disposables = entries.map((entry) => registerCommand({ owner: `builtin`, ...entry }));
    });

    onUnmounted(() => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
        disposables = [];
    });
}
