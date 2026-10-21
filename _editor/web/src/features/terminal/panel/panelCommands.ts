import type { Ref } from "vue";
import { builtinRegistration } from "../../../workbench/commands/builtinCommands";
import type { CommandRegistration } from "../../../workbench/commands/useCommands";

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

// The verbs' names, chords and focus gates are declared once (builtinCommands.ts); the strip gives each its handler.
type PanelCommand = CommandRegistration;

// Acts on the focused session, and on nothing while none is focused.
const onActive = (activeName: Readonly<Ref<string | undefined>>, act: (name: string) => void) => (): void => {
    if (activeName.value !== undefined) {
        act(activeName.value);
    }
};

const killCommands = ({ activeName, requestKill, selectedNames, killable, sweepInactive }: PanelVerbs): PanelCommand[] => {
    const killActive = onActive(activeName, (name) => requestKill([name]));
    return [
        // The selection first, else the focused session: the chord has the least aim of the three kill gestures.
        builtinRegistration(`terminal.kill`, (): void => {
            if (selectedNames.value.length > 0) {
                requestKill(selectedNames.value);
                return;
            }
            killActive();
        }),
        builtinRegistration(`terminal.killAll`, () => requestKill(killable.value)),
        builtinRegistration(`terminal.killInactive`, sweepInactive),
    ];
};

export const panelCommands = (verbs: PanelVerbs): PanelCommand[] => {
    const { activeName, renamingName, beginRename, openCustomize, joinSelected, cycleTab, unsplit, splitTab } = verbs;
    const renameActive = onActive(activeName, beginRename);
    const commands: PanelCommand[] = [
        builtinRegistration(`terminal.rename`, (): void => {
            // Already editing (F2 lands in the field): starting again would wipe the draft.
            if (renamingName.value === undefined) {
                renameActive();
            }
        }),
        builtinRegistration(
            `terminal.changeColor`,
            onActive(activeName, (name) => openCustomize(name, `color`)),
        ),
        builtinRegistration(
            `terminal.changeIcon`,
            onActive(activeName, (name) => openCustomize(name, `icon`)),
        ),
        builtinRegistration(`terminal.join`, joinSelected),
        builtinRegistration(`terminal.unsplit`, onActive(activeName, unsplit)),
        builtinRegistration(`terminal.nextTab`, () => cycleTab(1)),
        builtinRegistration(`terminal.previousTab`, () => cycleTab(-1)),
    ];
    if (splitTab !== undefined) {
        commands.push(builtinRegistration(`terminal.split`, onActive(activeName, splitTab)));
    }
    return verbs.canKill ? [...commands, ...killCommands(verbs)] : commands;
};
