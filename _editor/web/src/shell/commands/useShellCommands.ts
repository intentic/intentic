import type { Disposable } from "@intentic/extension-api";
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { type CommandRegistration, registerCommand } from "./useCommands";
import { chatOnRail, toggleChatFloating, toggleChatHome } from "../../features/chat/panel/chatPanelLayout";
import { useChatFloating } from "../../features/chat/panel/chatFloating";
import { openPreview } from "../../features/preview/previewSurface";
import { togglePreviewFloating, usePreviewFloating } from "../../features/preview/previewFloating";
import { useTerminalPanel } from "../../features/terminal/useTerminalPanel";
import { useTerminalFloating } from "../../features/terminal/terminalFloating";
import { useQuickOpen } from "./useQuickOpen";
import { useRole } from "../../features/sandbox/secrets/useRole";

// Core shell's built-in commands, since the palette's `>` mode is empty until an extension contributes one. Each
// handler calls the real composable directly; the command is the binding. Registered on mount and disposed on
// unmount so a shell remount (mobile/desktop crossover, HMR) can't double-register into the registry.
export function useShellCommands(): void {
    const router = useRouter();
    const terminal = useTerminalPanel();
    const { canShip } = useRole();
    const chat = useChatFloating();
    const terminalFloat = useTerminalFloating();
    const previewFloat = usePreviewFloating();
    const { isOpen, mode } = useQuickOpen();

    let disposables: readonly Disposable[] = [];

    onMounted(() => {
        // Explicitly typed: heterogeneous members would otherwise infer a narrow union from the first entries.
        const entries: Omit<CommandRegistration, `owner`>[] = [
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
            // Icons match the rail's glyphs for these areas.
            { command: `view.workspace`, title: `Go to Workspace`, icon: `file-tree`, handler: () => router.push(`/workspace`) },
            { command: `view.agents`, title: `Go to Agents`, icon: `robot`, handler: () => router.push(`/agents`) },
            { command: `view.secrets`, title: `Go to Sandbox Secrets`, icon: `key`, handler: () => router.push(`/sandbox/secrets`) },
            // Logs lives on the sandbox hub, not the rail; the palette is the one-keystroke path when something breaks.
            { command: `view.logs`, title: `Go to Sandbox Logs`, icon: `file`, handler: () => router.push(`/sandbox/logs`) },
            // Ports lives on the hub too; the rail only shows an exposure indicator, absent when nothing is exposed.
            { command: `view.ports`, title: `Go to Sandbox Ports`, icon: `globe`, handler: () => router.push(`/sandbox/ports`) },
            { command: `view.capabilities`, title: `Add a Capability`, icon: `plus`, handler: () => router.push(`/capabilities`) },
            { command: `view.keybindings`, title: `Keyboard Shortcuts`, icon: `sliders-h`, handler: () => router.push(`/settings/keybindings`) },
            // Both terminal commands no-op below maintainer, where the daemon refuses the socket.
            {
                command: `terminal.toggle`,
                title: `Toggle Terminal Panel`,
                icon: `code`,
                keybinding: `Ctrl+\``,
                handler: () => (canShip.value ? terminal.toggle() : undefined),
            },
            // Global, not panel-scoped: works with the panel closed; matched by physical key so Shift's "~" can't break
            // it.
            {
                command: `terminal.new`,
                title: `New Terminal`,
                icon: `code`,
                keybinding: `Ctrl+Shift+\``,
                handler: () => (canShip.value ? terminal.spawnShell() : undefined),
            },
            // Getter title, so the palette re-reads it live; gated off the terminal, where F9 belongs to whatever's
            // there.
            {
                command: `chat.toggleFloating`,
                get title(): string {
                    return chat.floats.value ? `Dock Chat Back` : `Move Chat into New Window`;
                },
                icon: `external-link`,
                keybinding: `F9`,
                when: `tabSurface != 'terminal'`,
                handler: () => toggleChatFloating(),
            },
            // In-app counterpart to the pop-out: rail vs. side column; title getter tracks state; unbound (F9 is
            // spent).
            {
                command: `chat.toggleHome`,
                get title(): string {
                    return chatOnRail.value ? `Dock Chat Back to the Side` : `Dock Chat to Rail`;
                },
                // `layout-left`, not `expand`: the rail is a left-edge dock, not something this command maximises.
                icon: `layout-left`,
                handler: () => toggleChatHome(router),
            },
            {
                command: `terminal.toggleFloating`,
                get title(): string {
                    return terminalFloat.floats.value ? `Dock Terminal Back` : `Move Terminal into New Window`;
                },
                icon: `external-link`,
                handler: (): void => {
                    // Open first: popping out a closed panel would float an empty window.
                    terminal.setOpen(true);
                    terminalFloat.toggle();
                },
            },
            // Preview's two doors: jump to its area, and the window toggle whose title says which way the press goes.
            { command: `view.preview`, title: `Go to Preview`, icon: `eye`, handler: () => openPreview(router) },
            {
                command: `preview.toggleFloating`,
                get title(): string {
                    return previewFloat.floats.value ? `Dock Preview Back` : `Move Preview into New Window`;
                },
                icon: `external-link`,
                handler: () => togglePreviewFloating(),
            },
        ];
        // Object.assign, not a spread: a spread would read (and freeze) the two dynamic title getters above.
        disposables = entries.map((entry) => registerCommand(Object.assign(entry, { owner: `builtin` })));
    });

    onUnmounted(() => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
        disposables = [];
    });
}
