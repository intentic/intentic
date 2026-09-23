import "@intentic/testing/dom";
import { t } from "@intentic/ui/i18n";
import { type App, createApp, h, ref, shallowRef } from "vue";
import { commandContext } from "../../../../shell/commands/contextKeys";
import { boundCommand, commands } from "../../../../shell/commands/useCommands";
import { useBoardCommands } from "./boardCommands";

// Pins what the board claims while it is on screen: it reads the roster and the archive on arriving, Mod+Z undoes an
// archive only while there is one to undo, the filter's accelerator focuses and selects the field, and all of it is
// handed back when the board leaves, so the next board can claim it again.

const mounted: App[] = [];
afterEach(() => {
    for (const app of mounted.splice(0)) {
        app.unmount();
    }
});

const boardOf = () => {
    const agents = {
        refresh: jest.fn(async () => undefined),
        loadArchived: jest.fn(async () => undefined),
        undoArchive: jest.fn(async () => undefined),
        undoable: shallowRef<readonly string[]>([]),
    };
    const focus = jest.fn((_select?: boolean) => undefined);
    const filterField = ref<{ focus: (select?: boolean) => void }>();
    const app = createApp({
        setup: () => {
            useBoardCommands({ agents, filterField });
            return () => h(`div`);
        },
    });
    app.mount(document.createElement(`div`));
    mounted.push(app);
    filterField.value = { focus };
    return { app, agents, focus };
};
const claimed = (): string[] => commands.value.map((entry) => entry.command).filter((command) => command.startsWith(`agents.`));
const undoChord = (): KeyboardEvent => new KeyboardEvent(`keydown`, { key: `z`, ctrlKey: true });

describe(`the board on screen`, () => {
    it(`reads the roster and the archive once, and claims undo and the filter under their titles`, () => {
        const { agents } = boardOf();
        expect([agents.refresh.mock.calls.length, agents.loadArchived.mock.calls.length]).toEqual([1, 1]);
        expect(
            commands.value
                .filter((entry) => entry.command.startsWith(`agents.`))
                .map(({ command, title, keybinding, when }) => ({ command, title, keybinding, when })),
        ).toEqual([
            {
                command: `agents.undoArchive`,
                title: t(`agents.agentsView.undoArchive`),
                keybinding: `Mod+Z`,
                when: `agentsUndoable && !editableTarget`,
            },
            { command: `agents.filter`, title: t(`shared.filter`), keybinding: undefined, when: undefined },
        ]);
    });

    it(`hands Mod+Z to the undo only while there is an archive to undo`, async () => {
        const { agents } = boardOf();
        expect(commandContext(undoChord())[`agentsUndoable`]).toBe(false);
        expect(boundCommand(undoChord(), false)).toBeUndefined();

        agents.undoable.value = [`a1`];
        expect(commandContext(undoChord())[`agentsUndoable`]).toBe(true);
        await boundCommand(undoChord(), false)?.handler();
        expect(agents.undoArchive).toHaveBeenCalledTimes(1);
    });

    it(`focuses and selects the filter from its accelerator`, async () => {
        const { focus } = boardOf();
        await commands.value.find((entry) => entry.command === `agents.filter`)?.handler();
        expect(focus.mock.calls).toEqual([[true]]);
    });

    it(`hands everything back on leaving, so the next board can claim it again`, () => {
        const { app } = boardOf();
        app.unmount();
        mounted.splice(0);
        expect(claimed()).toEqual([]);
        expect(commandContext(undoChord())[`agentsUndoable`]).toBeUndefined();

        boardOf();
        expect(claimed()).toEqual([`agents.undoArchive`, `agents.filter`]);
    });
});
