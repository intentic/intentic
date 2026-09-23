import type { Disposable } from "@intentic/extension-api";
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { CHAT, GO_TO, PREVIEW, TERMINAL } from "./categories";
import { type CommandRegistration, registerCommand } from "./useCommands";
import { chatOnRail, toggleChatFloating, toggleChatHome } from "../../features/chat/panel/chatPanelLayout";
import { useChatFloating } from "../../features/chat/panel/chatFloating";
import { togglePreviewFloating, usePreviewFloating } from "../../features/preview/previewFloating";
import { useTerminalPanel } from "../../features/terminal/useTerminalPanel";
import { useTerminalFloating } from "../../features/terminal/terminalFloating";
import { useQuickOpen } from "./useQuickOpen";
import { useRole } from "../../features/sandbox/secrets/useRole";
import { t } from "@intentic/ui/i18n";

// Core shell's built-in actions: what the shell can *do*, against the panels it owns. Where these commands can take
// you is useNavigationCommands' half, derived from the rail and the hubs rather than listed. Each handler calls the
// real composable directly; the command is the binding. Registered on mount and disposed on unmount so a shell
// remount (mobile/desktop crossover, HMR) can't double-register into the registry.
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
                command: `workspace.goToAnything`,
                title: t(`shell.useShellCommands.anything`),
                category: GO_TO,
                icon: `search`,
                keybinding: `Mod+P`,
                handler: (): void => {
                    mode.value = `all`;
                    isOpen.value = true;
                },
            },
            {
                command: `workspace.commandPalette`,
                // The one command with no family: it is the list the others are read from.
                title: t(`shell.useShellCommands.commandPalette`),
                icon: `search`,
                keybinding: `Mod+Shift+P`,
                handler: (): void => {
                    mode.value = `commands`;
                    isOpen.value = true;
                },
            },
            // Both terminal commands no-op below maintainer, where the daemon refuses the socket.
            {
                command: `terminal.toggle`,
                title: t(`shell.useShellCommands.togglePanel`),
                category: TERMINAL,
                icon: `code`,
                keybinding: `Ctrl+\``,
                handler: () => (canShip.value ? terminal.toggle() : undefined),
            },
            // Match the physical key globally so terminal.new works while its panel is closed.
            {
                command: `terminal.new`,
                title: t(`shared.new`),
                category: TERMINAL,
                icon: `code`,
                keybinding: `Ctrl+Shift+\``,
                handler: () => (canShip.value ? terminal.spawnShell() : undefined),
            },
            // Getter title, so the palette re-reads it live; gated off the terminal, where F9 belongs to whatever's
            // there.
            {
                command: `chat.toggleFloating`,
                get title(): string {
                    return chat.floats.value ? `Dock Back` : `Move into New Window`;
                },
                category: CHAT,
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
                    return chatOnRail.value ? `Dock Back to the Side` : `Dock to Rail`;
                },
                category: CHAT,
                // `layout-left`, not `expand`: the rail is a left-edge dock, not something this command maximises.
                icon: `layout-left`,
                handler: () => toggleChatHome(router),
            },
            {
                command: `terminal.toggleFloating`,
                get title(): string {
                    return terminalFloat.floats.value ? `Dock Back` : `Move into New Window`;
                },
                category: TERMINAL,
                icon: `external-link`,
                handler: (): void => {
                    // Open first: popping out a closed panel would float an empty window.
                    terminal.setOpen(true);
                    terminalFloat.toggle();
                },
            },
            // The window toggle whose title says which way the press goes; the jump to its area is a destination
            // (useNavigationCommands), like every other area's.
            {
                command: `preview.toggleFloating`,
                get title(): string {
                    return previewFloat.floats.value ? `Dock Back` : `Move into New Window`;
                },
                category: PREVIEW,
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
