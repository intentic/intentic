import type { Disposable } from "@intentic/extension-api";
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { registerBuiltin } from "../../workbench/commands/builtinCommands";
import { chatOnRail, toggleChatFloating, toggleChatHome } from "../../models/conversations/panel/chatPanelLayout";
import { useChatFloating } from "../../models/conversations/panel/chatFloating";
import { toggleBrowsersFloating, useBrowsersFloating } from "../../workbench/browsers/browsersFloating";
import { useTerminalPanel } from "../../models/terminal/useTerminalPanel";
import { useTerminalFloating } from "../../features/terminal/terminalFloating";
import { useQuickOpen } from "../../workbench/commands/useQuickOpen";
import { useRole } from "../../client/sandbox/useRole";
import { t } from "@intentic/ui/i18n";

// Core shell's built-in actions: what the shell can *do*, against the panels it owns. Where these commands can take
// you is useNavigationCommands' half, derived from the rail and the hubs rather than listed. Each handler calls the
// real composable directly; what each command is called and bound to is declared once, in builtinCommands.ts.
// Registered on mount and disposed on unmount so a shell remount (mobile/desktop crossover, HMR) can't double-register into the registry.
export function useShellCommands(): void {
    const router = useRouter();
    const terminal = useTerminalPanel();
    const { canShip } = useRole();
    const chat = useChatFloating();
    const terminalFloat = useTerminalFloating();
    const browsersFloat = useBrowsersFloating();
    const { isOpen, mode } = useQuickOpen();

    let disposables: readonly Disposable[] = [];

    onMounted(() => {
        // The three window toggles' titles say which way a press goes, so they are read live from the state.
        const dockWord = (floats: boolean): string => (floats ? t(`shell.useShellCommands.dockBack`) : t(`shell.useShellCommands.moveIntoNewWindow`));
        disposables = [
            registerBuiltin(`workspace.goToAnything`, (): void => {
                mode.value = `all`;
                isOpen.value = true;
            }),
            registerBuiltin(`workspace.commandPalette`, (): void => {
                mode.value = `commands`;
                isOpen.value = true;
            }),
            // Both terminal commands no-op below maintainer, where the daemon refuses the socket.
            registerBuiltin(`terminal.toggle`, () => (canShip.value ? terminal.toggle() : undefined)),
            registerBuiltin(`terminal.new`, () => (canShip.value ? terminal.spawnShell() : undefined)),
            registerBuiltin(`chat.toggleFloating`, () => toggleChatFloating(), { title: () => dockWord(chat.floats.value) }),
            // In-app counterpart to the pop-out: rail vs. side column.
            registerBuiltin(
                `chat.toggleHome`,
                () => toggleChatHome(router),
                { title: () => (chatOnRail.value ? t(`shell.useShellCommands.dockBackToSide`) : t(`shell.useShellCommands.dockToRail`)) },
            ),
            registerBuiltin(
                `terminal.toggleFloating`,
                (): void => {
                    // Open first: popping out a closed panel would float an empty window.
                    terminal.setOpen(true);
                    terminalFloat.toggle();
                },
                { title: () => dockWord(terminalFloat.floats.value) },
            ),
            // The jump to its area is a destination (useNavigationCommands), like every other area's.
            registerBuiltin(`browsers.toggleFloating`, () => toggleBrowsersFloating(), { title: () => dockWord(browsersFloat.floats.value) }),
        ];
    });

    onUnmounted(() => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
        disposables = [];
    });
}
