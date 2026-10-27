import type { Disposable } from "@intentic/extension-api";
import { onMounted, onUnmounted, watch, type WatchStopHandle } from "vue";
import { useRouter } from "vue-router";
import { registerBuiltin } from "../../workbench/commands/builtinCommands";
import { chatOnRail, toggleChatFloating, toggleChatHome } from "../../models/conversations/panel/chatPanelLayout";
import { useChatFloating } from "../../models/conversations/panel/chatFloating";
import { toggleBrowsersFloating, useBrowsersFloating } from "../../workbench/browsers/browsersFloating";
import { useTerminalPanel } from "../../models/terminal/useTerminalPanel";
import { useTerminalFloating } from "../../features/terminal/terminalFloating";
import { useQuickOpen } from "../../workbench/commands/useQuickOpen";
import { useHeldDoor } from "../../components/heldPlace";
import { t } from "@intentic/ui/i18n";

// Core shell's built-in actions: what the shell can *do*, against the panels it owns. Where these commands can take
// you is useNavigationCommands' half, derived from the rail and the hubs rather than listed. Each handler calls the
// real composable directly; what each command is called and bound to is declared once, in builtinCommands.ts.
// Registered on mount and disposed on unmount so a shell remount (mobile/desktop crossover, HMR) can't double-register into the registry.
export function useShellCommands(): void {
    const router = useRouter();
    const terminal = useTerminalPanel();
    // A terminal is a maintainer's (components/heldPlace.ts): below one its commands are not offered at all, rather than
    // listed and doing nothing, since the daemon refuses the socket they would open.
    const terminalDoor = useHeldDoor();
    const chat = useChatFloating();
    const terminalFloat = useTerminalFloating();
    const browsersFloat = useBrowsersFloating();
    const { isOpen, mode } = useQuickOpen();

    let disposables: readonly Disposable[] = [];
    let terminalCommands: readonly Disposable[] = [];
    let stopTerminal: WatchStopHandle | undefined;
    const releaseTerminal = (): void => {
        for (const disposable of terminalCommands) {
            disposable.dispose();
        }
        terminalCommands = [];
    };

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
            registerBuiltin(`view.settings`, (): void => void router.push(`/settings`)),
            registerBuiltin(`chat.toggleFloating`, () => toggleChatFloating(), { title: () => dockWord(chat.floats.value) }),
            // In-app counterpart to the pop-out: rail vs. side column.
            registerBuiltin(
                `chat.toggleHome`,
                () => toggleChatHome(router),
                { title: () => (chatOnRail.value ? t(`shell.useShellCommands.dockBackToSide`) : t(`shell.useShellCommands.dockToRail`)) },
            ),
            // The jump to its area is a destination (useNavigationCommands), like every other area's.
            registerBuiltin(`browsers.toggleFloating`, () => toggleBrowsersFloating(), { title: () => dockWord(browsersFloat.floats.value) }),
        ];
        stopTerminal = watch(
            terminalDoor,
            (open) => {
                releaseTerminal();
                if (!open) {
                    return;
                }
                terminalCommands = [
                    registerBuiltin(`terminal.toggle`, () => terminal.toggle()),
                    registerBuiltin(`terminal.new`, () => terminal.spawnShell()),
                    registerBuiltin(
                        `terminal.toggleFloating`,
                        (): void => {
                            // Open first: popping out a closed panel would float an empty window.
                            terminal.setOpen(true);
                            terminalFloat.toggle();
                        },
                        { title: () => dockWord(terminalFloat.floats.value) },
                    ),
                ];
            },
            { immediate: true },
        );
    });

    onUnmounted(() => {
        stopTerminal?.();
        releaseTerminal();
        for (const disposable of disposables) {
            disposable.dispose();
        }
        disposables = [];
    });
}
