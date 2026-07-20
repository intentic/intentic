import { afterEach, describe, expect, it } from "vitest";
import { commands, executeCommand, registerCommand, type RegisteredCommand } from "./useCommands";

/* The command registry backs the palette's `>` command mode: the shell's built-in commands and every extension's
 * contributed ones register here, and Quick Open filters + runs them by id. These pin the invariants the palette
 * relies on — unique ids, dispose really removes, and execute reaches the live handler. */

const entry = (command: string, handler: RegisteredCommand[`handler`]): RegisteredCommand => ({ owner: `builtin`, command, title: command, handler });

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
        const disposable = registerCommand(entry(`chat.togglePopout`, () => undefined));
        disposable.dispose();
        expect(commands.value).toHaveLength(0);
        // Re-registering the same id must now succeed — this is what lets the shell remount without colliding.
        expect(() => registerCommand(entry(`chat.togglePopout`, () => undefined))).not.toThrow();
    });

    it(`throws when executing an unknown command`, async () => {
        await expect(executeCommand(`nope`)).rejects.toThrow(/no command "nope"/);
    });
});
