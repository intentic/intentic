import "@intentic/testing/dom";
import { describe, expect, it, mock } from "bun:test";
import { computed, ref } from "vue";
import { showWorkTerminals } from "../useWorkTerminals";
import { panelCommands, type PanelVerbs } from "./panelCommands";

// Pins the panel's command set: which verbs exist for which strip (split and the kills only where the strip offers
// them), their default chords and focus gates, and what each does with the focused session or the selection.

const stage = (over: { split?: boolean; canKill?: boolean; selected?: string[] } = {}) => {
    const activeName = ref<string | undefined>(`a`);
    const renamingName = ref<string | undefined>(undefined);
    const strip = {
        renamingName,
        beginRename: mock((_name: string) => undefined),
        openCustomize: mock((_name: string, _mode: `color` | `icon`) => undefined),
        joinSelected: mock(),
        selectedNames: computed(() => over.selected ?? []),
        requestKill: mock((_names: string[]) => undefined),
        killable: computed(() => [`a`, `b`]),
        sweepInactive: mock(),
        cycleTab: mock((_delta: number) => undefined),
    };
    const verbs: PanelVerbs = {
        activeName,
        strip,
        unsplit: mock((_name: string) => undefined),
        splitTab: over.split === false ? undefined : mock((_name: string) => undefined),
        canKill: over.canKill ?? true,
        openFind: mock(),
    };
    const commands = panelCommands(verbs);
    const run = (id: string): void => void commands.find((entry) => entry.command === id)?.handler();
    return { activeName, renamingName, strip, verbs, commands, run };
};

describe(`the panel's commands`, () => {
    it(`registers every verb with its chord and focus gate`, () => {
        expect(stage().commands.map(({ command, keybinding, when }) => [command, keybinding, when])).toEqual([
            [`terminal.rename`, `F2`, `tabSurface == 'terminal'`],
            [`terminal.changeColor`, undefined, undefined],
            [`terminal.changeIcon`, undefined, undefined],
            [`terminal.join`, `Ctrl+Shift+G`, undefined],
            [`terminal.unsplit`, `Ctrl+Shift+U`, undefined],
            [`terminal.toggleWorkTerminals`, undefined, undefined],
            [`terminal.find`, `Mod+F`, `tabSurface == 'terminal'`],
            [`terminal.nextTab`, `Alt+PageDown`, `tabSurface == 'terminal'`],
            [`terminal.previousTab`, `Alt+PageUp`, `tabSurface == 'terminal'`],
            [`terminal.split`, `Ctrl+Shift+5`, undefined],
            [`terminal.kill`, `Ctrl+Shift+X`, `tabSurface == 'terminal'`],
            [`terminal.killAll`, `Ctrl+Shift+Backspace`, `tabSurface == 'terminal'`],
            [`terminal.killInactive`, undefined, undefined],
        ]);
    });

    it(`registers no split and no kill where the strip offers neither`, () => {
        const ids = stage({ split: false, canKill: false }).commands.map((entry) => entry.command);
        expect(ids.filter((id) => id === `terminal.split` || id.startsWith(`terminal.kill`))).toEqual([]);
    });

    it(`acts on the focused session, and on nothing while none is focused`, () => {
        const { activeName, strip, verbs, run } = stage();
        run(`terminal.changeIcon`);
        run(`terminal.unsplit`);
        activeName.value = undefined;
        run(`terminal.changeColor`);
        run(`terminal.split`);
        expect({ customized: strip.openCustomize.mock.calls, unsplit: (verbs.unsplit as ReturnType<typeof mock>).mock.calls }).toEqual({
            customized: [[`a`, `icon`]],
            unsplit: [[`a`]],
        });
        expect(verbs.splitTab).not.toHaveBeenCalled();
    });

    it(`never restarts a rename already under way, since that would wipe the draft`, () => {
        const { renamingName, strip, run } = stage();
        renamingName.value = `b`;
        run(`terminal.rename`);
        renamingName.value = undefined;
        run(`terminal.rename`);
        expect(strip.beginRename.mock.calls).toEqual([[`a`]]);
    });

    it(`kills the selection first, else the focused session, and everything on kill-all`, () => {
        const selected = stage({ selected: [`b`, `c`] });
        selected.run(`terminal.kill`);
        const focused = stage();
        focused.run(`terminal.kill`);
        focused.run(`terminal.killAll`);
        expect([selected.strip.requestKill.mock.calls, focused.strip.requestKill.mock.calls]).toEqual([[[[`b`, `c`]]], [[[`a`]], [[`a`, `b`]]]]);
    });

    it(`walks tabs both ways and toggles the work terminals preference`, () => {
        const { strip, run } = stage();
        const before = showWorkTerminals.value;
        run(`terminal.nextTab`);
        run(`terminal.previousTab`);
        run(`terminal.toggleWorkTerminals`);
        expect({ walked: strip.cycleTab.mock.calls, shown: showWorkTerminals.value }).toEqual({ walked: [[1], [-1]], shown: !before });
        showWorkTerminals.value = before;
    });
});
