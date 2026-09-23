import { t } from "@intentic/ui/i18n";
import type { Ref } from "vue";
import type { CommandRegistration } from "../../../shell/commands/useCommands";
import { showWorkTerminals } from "../useWorkTerminals";
import type { TerminalStrip } from "./useTerminalStrip";

// Every strip action as a command, registered while the panel is mounted. Tab-family chords match the workspace and chat
// strips, gated on this panel's focus; the panel's own verbs keep private, ungated chords. Defaults are Ctrl+Shift+<key>,
// dodging bare Ctrl (the shell's) and Ctrl+Alt (AltGr), and every one is rebindable per surface.

export interface PanelVerbs {
    readonly activeName: Readonly<Ref<string | undefined>>;
    readonly strip: Pick<
        TerminalStrip,
        | `renamingName`
        | `beginRename`
        | `openCustomize`
        | `joinSelected`
        | `selectedNames`
        | `requestKill`
        | `killable`
        | `sweepInactive`
        | `cycleTab`
    >;
    readonly unsplit: (name: string) => void;
    readonly splitTab: ((name: string) => void) | undefined;
    // Whether the strip may end sessions at all; a read-only panel registers none of the kills.
    readonly canKill: boolean;
    readonly openFind: () => void;
}

type PanelCommand = Omit<CommandRegistration, `owner`>;

// Acts on the focused session, and on nothing while none is focused.
const onActive = (activeName: Readonly<Ref<string | undefined>>, act: (name: string) => void) => (): void => {
    if (activeName.value !== undefined) {
        act(activeName.value);
    }
};

const killCommands = ({ activeName, strip }: PanelVerbs): PanelCommand[] => {
    const killActive = onActive(activeName, (name) => strip.requestKill([name]));
    return [
        {
            command: `terminal.kill`,
            title: t(`terminal.terminalPanel.kill`),
            icon: `trash`,
            keybinding: `Ctrl+Shift+X`,
            when: `tabSurface == 'terminal'`,
            // The selection first, else the focused session: the chord has the least aim of the three kill gestures.
            handler: (): void => {
                if (strip.selectedNames.value.length > 0) {
                    strip.requestKill(strip.selectedNames.value);
                    return;
                }
                killActive();
            },
        },
        {
            command: `terminal.killAll`,
            title: t(`terminal.terminalPanel.killAll`),
            icon: `trash`,
            keybinding: `Ctrl+Shift+Backspace`,
            when: `tabSurface == 'terminal'`,
            handler: () => strip.requestKill(strip.killable.value),
        },
        // Unbound: tidying is occasional, and a chord for it would sit one slip from the one that kills your shell.
        { command: `terminal.killInactive`, title: t(`terminal.terminalPanel.killInactive`), icon: `trash`, handler: strip.sweepInactive },
    ];
};

export const panelCommands = (verbs: PanelVerbs): PanelCommand[] => {
    const { activeName, strip, unsplit, splitTab, openFind } = verbs;
    const renameActive = onActive(activeName, strip.beginRename);
    const commands: PanelCommand[] = [
        {
            command: `terminal.rename`,
            title: t(`ui.action.rename`),
            icon: `pencil`,
            // F2 is gated to a keystroke from inside this panel; outside it the chord stays free for other surfaces.
            keybinding: `F2`,
            when: `tabSurface == 'terminal'`,
            handler: (): void => {
                // Already editing (F2 lands in the field): starting again would wipe the draft.
                if (strip.renamingName.value === undefined) {
                    renameActive();
                }
            },
        },
        {
            command: `terminal.changeColor`,
            title: t(`terminal.terminalPanel.changeColor2`),
            icon: `palette`,
            handler: onActive(activeName, (name) => strip.openCustomize(name, `color`)),
        },
        {
            command: `terminal.changeIcon`,
            title: t(`terminal.terminalPanel.changeIcon2`),
            icon: `star`,
            handler: onActive(activeName, (name) => strip.openCustomize(name, `icon`)),
        },
        {
            command: `terminal.join`,
            title: t(`terminal.terminalPanel.joinSelected`),
            icon: `code`,
            keybinding: `Ctrl+Shift+G`,
            handler: strip.joinSelected,
        },
        {
            command: `terminal.unsplit`,
            title: t(`terminal.terminalPanel.unsplit`),
            icon: `code`,
            keybinding: `Ctrl+Shift+U`,
            handler: onActive(activeName, unsplit),
        },
        {
            // Unbound by default, like the cosmetic pickers: it already has two clickable homes.
            command: `terminal.toggleWorkTerminals`,
            title: t(`terminal.terminalPanel.toggleWorkTerminals`),
            icon: `sparkles`,
            handler: (): void => {
                showWorkTerminals.value = !showWorkTerminals.value;
            },
        },
        // Cmd+F on a Mac, Ctrl+F elsewhere, gated to this panel so the page's own find keeps the chord everywhere else.
        {
            command: `terminal.find`,
            title: t(`terminal.terminalPanel.find`),
            icon: `search`,
            keybinding: `Mod+F`,
            when: `tabSurface == 'terminal'`,
            handler: openFind,
        },
        {
            command: `terminal.nextTab`,
            title: t(`ui.action.next`),
            keybinding: `Alt+PageDown`,
            when: `tabSurface == 'terminal'`,
            handler: () => strip.cycleTab(1),
        },
        {
            command: `terminal.previousTab`,
            title: t(`terminal.terminalPanel.previous`),
            keybinding: `Alt+PageUp`,
            when: `tabSurface == 'terminal'`,
            handler: () => strip.cycleTab(-1),
        },
    ];
    if (splitTab !== undefined) {
        commands.push({
            command: `terminal.split`,
            title: t(`terminal.terminalPanel.split`),
            icon: `code`,
            keybinding: `Ctrl+Shift+5`,
            handler: onActive(activeName, splitTab),
        });
    }
    return verbs.canKill ? [...commands, ...killCommands(verbs)] : commands;
};
