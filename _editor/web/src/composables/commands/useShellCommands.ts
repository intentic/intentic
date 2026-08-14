import type { Disposable } from "@intentic/extension-api";
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { type CommandRegistration, registerCommand } from "./useCommands";
import { chatOnRail, toggleChatHome, toggleChatPopout } from "../chat/chatSurface";
import { useChatPopout } from "../chat/useChatPopout";
import { useTerminalPanel } from "../terminal/useTerminalPanel";
import { useTerminalPopout } from "../terminal/useTerminalPopout";
import { useQuickOpen } from "../useQuickOpen";
import { useRole } from "../sandbox/useRole";

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
    const { canShip } = useRole();
    const chat = useChatPopout();
    const terminalPopout = useTerminalPopout();
    const { isOpen, mode } = useQuickOpen();

    let disposables: readonly Disposable[] = [];

    onMounted(() => {
        // Explicitly typed: the members are heterogeneous (some carry a keybinding, some don't), so without the
        // annotation TS infers a narrow union off the first entries and rejects the later push.
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
            // The same glyphs the rail gives these two areas: a command that jumps somewhere should be wearing
            // what it jumps to.
            { command: `view.workspace`, title: `Go to Workspace`, icon: `file-tree`, handler: () => router.push(`/workspace`) },
            { command: `view.agents`, title: `Go to Agents`, icon: `robot`, handler: () => router.push(`/agents`) },
            { command: `view.secrets`, title: `Go to Sandbox Secrets`, icon: `key`, handler: () => router.push(`/sandbox/secrets`) },
            // Logs sits on the sandbox hub rather than the rail (it is read-only forensics about the box, not a
            // surface you work from) — so the palette is what makes it one keystroke away when something broke,
            // instead of a permanently present tile that never carries a signal.
            { command: `view.logs`, title: `Go to Sandbox Logs`, icon: `file`, handler: () => router.push(`/sandbox/logs`) },
            // Ports likewise lives on the hub; the rail carries only its exposure indicator, which is absent
            // exactly when there is nothing exposed — so this is the way in when you want to look rather than
            // when the sandbox wants to tell you something.
            { command: `view.ports`, title: `Go to Sandbox Ports`, icon: `globe`, handler: () => router.push(`/sandbox/ports`) },
            { command: `view.capabilities`, title: `Add a Capability`, icon: `plus`, handler: () => router.push(`/capabilities`) },
            { command: `view.keybindings`, title: `Keyboard Shortcuts`, icon: `sliders-h`, handler: () => router.push(`/settings/keybindings`) },
            // Both terminal commands no-op below maintainer — the daemon refuses the socket there, and a chord that
            // opens a panel only to show it failing to connect reads as breakage, not as a boundary.
            {
                command: `terminal.toggle`,
                title: `Toggle Terminal Panel`,
                icon: `code`,
                keybinding: `Ctrl+\``,
                handler: () => (canShip.value ? terminal.toggle() : undefined),
            },
            // Global (not panel-scoped like the other terminal.* commands) so it works with the panel closed —
            // spawnShell opens it and routes the create through the mounted panel's spawn hook. Ctrl+Shift+`,
            // VSCode's New Terminal chord, matched by physical key (the Backquote row) so the Shift glyph "~"
            // or a dead-key layout can't break it.
            {
                command: `terminal.new`,
                title: `New Terminal`,
                icon: `code`,
                keybinding: `Ctrl+Shift+\``,
                handler: () => (canShip.value ? terminal.spawnShell() : undefined),
            },
            /* MOVING THE CHAT INTO ITS OWN WINDOW, in the words the tab strip's menu row already uses. The old
             * "Toggle Chat Pop-Out" was a third name for it — and the palette matches on the title and the id
             * (QuickOpen), so typing the thing the user actually wants ("window", "new window") found nothing.
             * The title says which DIRECTION the press will take, because a row promising a new window while it
             * docks is worse than no row: a getter, so the palette's computed re-reads it when the state flips.
             *
             * F9 is the point of the exercise. This is a several-times-an-hour gesture for anyone working with
             * the chat on a second screen, and a menu row three clicks deep can't be that; every surface that
             * offers the action now teaches this key. Bare, because a modifier chord is the thing the hand
             * hesitates on — and gated off the terminal, where F9 belongs to whatever TUI is running in it
             * (mc's menu, an editor's key) rather than to the shell. */
            {
                command: `chat.togglePopout`,
                get title(): string {
                    return chat.poppedOut.value ? `Dock Chat Back` : `Move Chat into New Window`;
                },
                icon: `external-link`,
                keybinding: `F9`,
                when: `tabSurface != 'terminal'`,
                // toggleChatPopout, not the bare window toggle: docking back must land the chat in its home,
                // which with the rail as home means walking to /chat — the reasoning is on the function.
                handler: () => toggleChatPopout(router),
            },
            /* THE POP-OUT'S IN-WINDOW SIBLING: which of the two IN-APP homes the chat lives in — the side
             * column beside every view, or the rail (a Chat tile whose area the chat fills, and no column
             * anywhere else). The title says which direction the press will take, for the pop-out row's reason
             * (the palette matches on words, and a row promising the rail while it undoes it is worse than no
             * row). The move itself is toggleChatHome (chatSurface.ts), shared with the chat bar's button and
             * menu row. Unbound by default — F9's bare-key trick is spent, and those two are one click. */
            {
                command: `chat.toggleHome`,
                get title(): string {
                    return chatOnRail.value ? `Dock Chat Back to the Side` : `Dock Chat to Rail`;
                },
                icon: `expand`,
                handler: () => toggleChatHome(router),
            },
            {
                command: `terminal.togglePopout`,
                get title(): string {
                    return terminalPopout.poppedOut.value ? `Dock Terminal Back` : `Move Terminal into New Window`;
                },
                icon: `external-link`,
                handler: (): void => {
                    // Popping out a closed panel would float an empty window — open it first (docking keeps it open).
                    terminal.setOpen(true);
                    terminalPopout.toggle();
                },
            },
        ];
        // Object.assign rather than `{ owner, ...entry }`: a spread READS every property, which would freeze the
        // two dynamic titles above at whatever they said the moment the shell mounted.
        disposables = entries.map((entry) => registerCommand(Object.assign(entry, { owner: `builtin` })));
    });

    onUnmounted(() => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
        disposables = [];
    });
}
