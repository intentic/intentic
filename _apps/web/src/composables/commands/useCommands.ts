import type { Disposable } from "@intentic/extension-api";
import { shallowRef } from "vue";

/* The command registry: commands registered by extensions (and, opportunistically, builtins) surfaced in Quick
 * Open's `>` command mode and executable by id. A module-level singleton ref, like the extension registry —
 * every consumer reads the same reactive list. */

export interface RegisteredCommand {
    // "builtin" or the owning extension's id.
    readonly owner: string;
    readonly command: string;
    readonly title: string;
    readonly icon?: string | undefined;
    readonly handler: (...args: unknown[]) => unknown;
}

export const commands = shallowRef<readonly RegisteredCommand[]>([]);

export const registerCommand = (entry: RegisteredCommand): Disposable => {
    if (commands.value.some((existing) => existing.command === entry.command)) {
        throw new Error(`command "${entry.command}" is already registered`);
    }
    commands.value = [...commands.value, entry];
    return {
        dispose: (): void => {
            commands.value = commands.value.filter((existing) => existing !== entry);
        },
    };
};

export const executeCommand = async (command: string, ...args: unknown[]): Promise<unknown> => {
    const found = commands.value.find((entry) => entry.command === command);
    if (found === undefined) {
        throw new Error(`no command "${command}" is registered`);
    }
    return await found.handler(...args);
};
