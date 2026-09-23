import { t } from "@intentic/ui/i18n";
import type { Ref } from "vue";
import type { CommandRegistration } from "../../../shell/commands/useCommands";
import { showWorkTerminals } from "../useWorkTerminals";

// Every strip action as a command, registered while the strip is mounted. Tab-family chords match the workspace and chat
// strips, gated on this panel's focus; the panel's own verbs keep private, ungated chords. Defaults are Ctrl+Shift+<key>,
// dodging bare Ctrl (the shell's) and Ctrl+Alt (AltGr), and every one is rebindable per surface.

export interface PanelVerbs {
    readonly activeName: Readonly<Ref<string | undefined>>;
    readonly renamingName: Readonly<Ref<string | undefined>>;
    readonly selectedNames: Readonly<Ref<string[]>>;
    readonly killable: Readonly<Ref<string[]>>;
    readonly beginRename: (name: string) => void;
    readonly openCustomize: (name: string, mode: `color` | `icon`) => void;
    readonly joinSelected: () => void;
    readonly requestKill: (names: string[]) => void;
    readonly sweepInactive: () => void;
    readonly cycleTab: (delta: number) => void;
    readonly unsplit: (name: string) => void;
    readonly splitTab: ((name: string) => void) | undefined;
    // Whether the strip may end sessions at all; a read-only panel registers none of the kills.
    readonly canKill: boolean;
}

type PanelCommand = Omit<CommandRegistration, `owner`>;

// Acts on the focused session, and on nothing while none is focused.
const onActive = (activeName: Readonly<Ref<string | undefined>>, act: (name: string) => void) => (): void => {
    if (activeName.value !== undefined) {
        act(activeName.value);
    }
};

const killCommands = ({ activeName, requestKill, selectedNames, killable, sweepInactive }: PanelVerbs): PanelCommand[] => {
    const killActive = onActive(activeName, (name) => requestKill([name]));
    return [
        {
            command: `terminal.kill`,
            title: t(`terminal.terminalPanel.kill`),
            icon: `trash`,
            keybinding: `Ctrl+Shift+X`,
            when: `tabSurface == 'terminal'`,
            // The selection first, else the focused session: the chord has the least aim of the three kill gestures.
            handler: (): void => {
                if (selectedNames.value.length > 0) {
                    requestKill(selectedNames.value);
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
            handler: () => requestKill(killable.value),
        },
        // Unbound: tidying is occasional, and a chord for it would sit one slip from the one that kills your shell.
        { command: `terminal.killInactive`, title: t(`terminal.terminalPanel.killInactive`), icon: `trash`, handler: sweepInactive },
    ];
};

export const panelCommands = (verbs: PanelVerbs): PanelCommand[] => {
    const { activeName, renamingName, beginRename, openCustomize, joinSelected, cycleTab, unsplit, splitTab } = verbs;
    const renameActive = onActive(activeName, beginRename);
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
                if (renamingName.value === undefined) {
                    renameActive();
                }
            },
        },
        {
            command: `terminal.changeColor`,
            title: t(`terminal.terminalPanel.changeColor2`),
            icon: `palette`,
            handler: onActive(activeName, (name) => openCustomize(name, `color`)),
        },
        {
            command: `terminal.changeIcon`,
            title: t(`terminal.terminalPanel.changeIcon2`),
            icon: `star`,
            handler: onActive(activeName, (name) => openCustomize(name, `icon`)),
        },
        {
            command: `terminal.join`,
            title: t(`terminal.terminalPanel.joinSelected`),
            icon: `code`,
            keybinding: `Ctrl+Shift+G`,
            handler: joinSelected,
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
        {
            command: `terminal.nextTab`,
            title: t(`ui.action.next`),
            keybinding: `Alt+PageDown`,
            when: `tabSurface == 'terminal'`,
            handler: () => cycleTab(1),
        },
        {
            command: `terminal.previousTab`,
            title: t(`terminal.terminalPanel.previous`),
            keybinding: `Alt+PageUp`,
            when: `tabSurface == 'terminal'`,
            handler: () => cycleTab(-1),
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
