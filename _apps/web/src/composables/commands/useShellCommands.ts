import type { Disposable } from "@intentic/extension-api";
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { registerCommand } from "./useCommands";
import { useChatPopout } from "../chat/useChatPopout";
import { useTerminalPanel } from "../terminal/useTerminalPanel";
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
    const { isOpen, mode } = useQuickOpen();

    let disposables: readonly Disposable[] = [];

    onMounted(() => {
        const entries = [
            {
                command: `workspace.goToFile`,
                title: `Go to File…`,
                icon: `search`,
                handler: (): void => {
                    mode.value = `files`;
                    isOpen.value = true;
                },
            },
            { command: `view.workspace`, title: `Go to Workspace`, icon: `folder`, handler: () => router.push(`/workspace`) },
            { command: `view.agents`, title: `Go to Agents`, icon: `comments`, handler: () => router.push(`/agents`) },
            { command: `view.secrets`, title: `Go to Secrets`, icon: `key`, handler: () => router.push(`/secrets`) },
            { command: `view.capabilities`, title: `Add a Capability`, icon: `plus`, handler: () => router.push(`/capabilities`) },
            { command: `terminal.toggle`, title: `Toggle Terminal Panel`, icon: `code`, handler: () => terminal.toggle() },
        ];
        // Pop-out rides the Document Picture-in-Picture API — only offer the command where the button is offered.
        if (chat.supported) {
            entries.push({ command: `chat.togglePopout`, title: `Toggle Chat Pop-Out`, icon: `window-maximize`, handler: () => chat.toggle() });
        }
        disposables = entries.map((entry) => registerCommand({ owner: `builtin`, ...entry }));
    });

    onUnmounted(() => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
        disposables = [];
    });
}
