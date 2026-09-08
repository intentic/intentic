// @vitest-environment jsdom
// Needs jsdom: resolving a keystroke reads the focused surface off the event's target (contextKeys.ts).
import { afterEach, describe, expect, it } from "vitest";
import { ref } from "vue";
import { publishContextKey } from "./contextKeys";
import { boundCommand, type CommandRegistration, commands, executeCommand, registerCommand } from "./useCommands";

// Pins the command registry's invariants: unique ids, dispose removes a command, execute reaches the live handler.

const entry = (command: string, handler: CommandRegistration[`handler`]): CommandRegistration => ({
    owner: `builtin`,
    command,
    title: command,
    handler,
});

afterEach(() => {
    commands.value = [];
});

describe(`command registry`, () => {
    it(`registers a command and executes it by id`, async () => {
        const calls: string[] = [];
        registerCommand(entry(`view.workspace`, () => calls.push(`ran`)));
        expect(commands.value.map((c) => c.command)).toEqual([`view.workspace`]);
        await executeCommand(`view.workspace`);
        expect(calls).toEqual([`ran`]);
    });

    it(`passes args through and returns the handler's result`, async () => {
        registerCommand(entry(`sum`, (...args) => (args as number[]).reduce((a, b) => a + b, 0)));
        expect(await executeCommand(`sum`, 2, 3, 4)).toBe(9);
    });

    it(`rejects a duplicate command id`, () => {
        registerCommand(entry(`terminal.toggle`, () => undefined));
        expect(() => registerCommand(entry(`terminal.toggle`, () => undefined))).toThrow(/already registered/);
    });

    it(`disposing removes the command so its id is free again`, () => {
        const disposable = registerCommand(entry(`chat.toggleFloating`, () => undefined));
        disposable.dispose();
        expect(commands.value).toHaveLength(0);
        expect(() => registerCommand(entry(`chat.toggleFloating`, () => undefined))).not.toThrow();
    });

    it(`throws when executing an unknown command`, async () => {
        await expect(executeCommand(`nope`)).rejects.toThrow(/no command "nope"/);
    });
});

// Minimal event stub: boundCommand reads only the modifier flags and `key`.
const keydown = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

describe(`boundCommand`, () => {
    it(`resolves a keydown to the command whose chord it matches`, () => {
        registerCommand(entry(`palette.only`, () => undefined));
        registerCommand({ ...entry(`bound`, () => undefined), keybinding: `Mod+K` });
        expect(boundCommand(keydown({ key: `k`, ctrlKey: true }), false)?.command).toBe(`bound`);
        expect(boundCommand(keydown({ key: `k`, metaKey: true }), true)?.command).toBe(`bound`);
        expect(boundCommand(keydown({ key: `j`, ctrlKey: true }), false)).toBeUndefined();
    });

    it(`skips a command whose when gate is closed, leaving the keystroke to the focused surface`, () => {
        const open = ref(false);
        const key = publishContextKey(`testGateOpen`, open);
        registerCommand({ ...entry(`gated`, () => undefined), keybinding: `Mod+K`, when: `testGateOpen` });
        expect(boundCommand(keydown({ key: `k`, ctrlKey: true }), false)).toBeUndefined();
        open.value = true;
        expect(boundCommand(keydown({ key: `k`, ctrlKey: true }), false)?.command).toBe(`gated`);
        key.dispose();
    });

    // An unpublished context key reads as false, not a throw.
    it(`closes a gate over a context key nobody publishes`, () => {
        registerCommand({ ...entry(`unknown`, () => undefined), keybinding: `Mod+K`, when: `neverPublished` });
        expect(boundCommand(keydown({ key: `k`, ctrlKey: true }), false)).toBeUndefined();
    });

    it(`refuses a command whose condition does not parse`, () => {
        expect(() => registerCommand({ ...entry(`broken`, () => undefined), when: `&& nonsense` })).toThrow();
    });
});
