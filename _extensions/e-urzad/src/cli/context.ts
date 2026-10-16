import { resolve } from "node:path";
import { findWorkspaceRoot } from "@intentic/connector-runtime";
import type { Held } from "../core/guard.js";

// What every command shares: the workspace, the environment the daemon gave this shell (each connected card's env
// vars, suffixed by card), and how to answer. The agent-CLI contract the other first-party CLIs keep: everything goes
// to stdout, errors included, since an agent may never see stderr; exit 0 is an answer, 2 is a refusal or a failure.

export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
}

export interface Context {
    readonly root: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: (text: string) => void;
    readonly now: () => Date;
}

export const contextOf = (env: NodeJS.ProcessEnv, out: (text: string) => void): Context => ({
    root: findWorkspaceRoot(env, process.cwd()),
    env,
    out,
    now: () => new Date(),
});

// A path the agent typed, relative to where it stands.
export const pathArgument = (value: string): string => resolve(process.cwd(), value);

// Prints a command's answer as JSON; an absent optional field is simply left out.
export const print = <T>(context: Context, value: T): void => context.out(`${JSON.stringify(value ?? null, undefined, 2)}\n`);

// What a held office act answers: it was written to the approvals queue, and nothing reached the office.
export const printHeld = (context: Context, held: Held): void => {
    print(context, { held: true, approvalId: held.approvalId, message: held.message });
};

export const required = (value: string | undefined, what: string): string => {
    if (value === undefined || value.trim() === "") {
        throw new UsageError(`missing ${what}`);
    }
    return value.trim();
};
