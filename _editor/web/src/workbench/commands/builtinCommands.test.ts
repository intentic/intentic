import "@intentic/testing/dom";
import { BUILTIN_COMMANDS, type CommandDeclaration, declaredChord, keymapCommands, registerBuiltin } from "./builtinCommands";
import { chordSignature } from "./keybindings";
import { chordKeeper } from "./reservedChords";
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
        registerBuiltin(`chat.toggleFloating`, () => ran.push(`toggled`), { title: () => `Dock back` });
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

// The four kinds of window a default is read in: a Mac or not, a browser tab or an app window.
const WINDOWS = [
    { name: `a Mac tab`, isMac: true, app: false },
    { name: `a Mac app window`, isMac: true, app: true },
    { name: `a Windows or Linux tab`, isMac: false, app: false },
    { name: `a Windows or Linux app window`, isMac: false, app: true },
] as const;

const declarations = (): readonly [string, CommandDeclaration][] => Object.entries(BUILTIN_COMMANDS);

describe(`each platform's default chords`, () => {
    it(`gives a Mac its own chord where it names one, an app window its own on top, and the shared one otherwise`, () => {
        const closeTab = BUILTIN_COMMANDS[`workspace.closeTab`];
        expect(WINDOWS.map((window) => declaredChord(closeTab, window.isMac, window.app))).toEqual([`Ctrl+W`, `Mod+W`, `Ctrl+Shift+X`, `Ctrl+Shift+X`]);
        // A Mac without a chord of its own keeps the shared one.
        expect(declaredChord(BUILTIN_COMMANDS[`workspace.commandPalette`], true, false)).toBe(`Mod+Shift+P`);
        // A Mac-only command is unbound elsewhere.
        expect(declaredChord(BUILTIN_COMMANDS[`terminal.clear`], false, false)).toBeUndefined();
        expect(declaredChord(BUILTIN_COMMANDS[`terminal.clear`], true, false)).toBe(`Mod+K`);
    });

    it.each(WINDOWS)(`never defaults to a chord the system or the browser keeps, in $name`, ({ isMac, app }) => {
        const kept = declarations().flatMap(([command, declaration]) => {
            const chord = declaredChord(declaration, isMac, app);
            const keeper = chord === undefined ? undefined : chordKeeper(chord, isMac, app);
            return keeper === undefined ? [] : [`${command}: ${chord} (${keeper})`];
        });
        expect(kept).toEqual([]);
    });

    it.each(WINDOWS)(`never gives two ungated commands the same chord, in $name`, ({ isMac, app }) => {
        const owners = new Map<string, string[]>();
        for (const [command, declaration] of declarations()) {
            const chord = declaredChord(declaration, isMac, app);
            if (chord !== undefined && declaration.when === undefined) {
                const signature = chordSignature(chord, isMac);
                owners.set(signature, [...(owners.get(signature) ?? []), command]);
            }
        }
        expect([...owners.values()].filter((list) => list.length > 1)).toEqual([]);
    });

    it(`keeps a Mac's defaults off keys a MacBook has no key for`, () => {
        // PageUp, PageDown, Home, End, forward Delete and the F-keys are all behind fn on a laptop.
        const behindFn = /\+(PageUp|PageDown|Home|End|Delete)$|^F\d+$/i;
        const laptopOnly = declarations()
            .map(([command, declaration]) => [command, declaredChord(declaration, true, false)] as const)
            .filter(([, chord]) => chord !== undefined && behindFn.test(chord))
            .map(([command]) => command);
        // F2 and F9 stay as they were: a tab renames on a double-click too, and the chat's pop-out has its button; a file
        // renames on Return (treeKeys.ts).
        expect(laptopOnly).toEqual([`chat.toggleFloating`, `chat.rename`, `terminal.rename`]);
    });
});
