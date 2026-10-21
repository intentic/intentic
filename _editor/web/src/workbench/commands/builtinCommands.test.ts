import "@intentic/testing/dom";
import { BUILTIN_COMMANDS, keymapCommands, registerBuiltin } from "./builtinCommands";
import { commands, executeCommand, registerCommand } from "./useCommands";

// Pins what the Keyboard page lists: every declared built-in whatever this window has mounted (a desktop window on a
// folder of this computer mounts almost none of them), a live registration in its declared one's place, and an
// extension's command beside them.

afterEach(() => {
    commands.value = [];
    delete window.__INTENTIC_DESKTOP__;
});

const listed = (): readonly string[] => keymapCommands.value.map((entry) => entry.command);

describe(`the keymap's commands`, () => {
    it(`lists every declared built-in with its default chord while nothing is registered`, () => {
        const chords = Object.fromEntries(keymapCommands.value.map((entry) => [entry.command, entry.keybinding]));
        expect({ total: listed().length, palette: chords[`workspace.commandPalette`], closeTab: chords[`workspace.closeTab`], slot: chords[`sandbox.switch3`] }).toEqual({
            // Alt+0 is the desktop app's alone, and this is no desktop app.
            total: Object.keys(BUILTIN_COMMANDS).length - 1,
            palette: `Mod+Shift+P`,
            closeTab: `Ctrl+Shift+X`,
            slot: `Alt+3`,
        });
    });

    it(`offers Alt+0 for this computer only inside the desktop app`, () => {
        expect(listed()).not.toContain(`sandbox.thisComputer`);
        // SAFETY: only its presence is read, by desktopApp().
        window.__INTENTIC_DESKTOP__ = {} as NonNullable<typeof window.__INTENTIC_DESKTOP__>;
        // The listing reads the window when the registry moves, as it does on every mount.
        commands.value = [];
        expect(listed()).toContain(`sandbox.thisComputer`);
    });

    it(`lists a mounted command once, under the live title its surface gives it, and runs that surface's handler`, async () => {
        const ran: string[] = [];
        registerBuiltin(`chat.toggleFloating`, () => ran.push(`toggled`), () => `Dock back`);
        await executeCommand(`chat.toggleFloating`);
        const rows = keymapCommands.value.filter((entry) => entry.command === `chat.toggleFloating`);
        expect({ rows: rows.map((entry) => [entry.title, entry.keybinding, entry.when]), ran }).toEqual({
            rows: [[`Dock back`, `F9`, `tabSurface != 'terminal'`]],
            ran: [`toggled`],
        });
    });

    it(`lists an extension's command beside the built-ins`, () => {
        registerCommand({ owner: `acme.tools`, command: `acme.run`, title: `Run`, handler: () => undefined });
        expect(listed()).toContain(`acme.run`);
    });
});
