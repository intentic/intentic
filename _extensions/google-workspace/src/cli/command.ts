import type { Connection } from "../google/accounts.js";
import type { Session } from "../google/session.js";
import type { Args } from "./args.js";

/* WHAT A `gw` SUBCOMMAND IS. Declared as data rather than written as a switch, because three separate things
 * have to be derived from the same list and a switch can only answer the first: what runs, what `--help`
 * prints, and which commands a read-only connection refuses.
 *
 * `writes` is that third one, and it is a property of the command rather than a check inside it, a guard the
 * command performs is a guard a new command forgets. The refusal happens once, in the router, for everything
 * flagged here. */

export interface RootContext {
    readonly args: Args;
    // `--json`, print Google's own response instead of the compact lines. The agent reaches for this when it
    // needs a field the summary doesn't carry.
    readonly json: boolean;
    readonly out: (line: string) => void;
    // Every connected account, before one has been chosen. What `gw accounts` reports on.
    readonly connections: readonly Connection[];
}

export interface CommandContext extends RootContext {
    readonly connection: Connection;
    readonly session: Session;
}

export interface Command {
    readonly name: string;
    // One line, shown by `gw <group>`; the usage line is shown when the command is used wrongly.
    readonly summary: string;
    readonly usage: string;
    readonly writes?: boolean;
    readonly run: (ctx: CommandContext) => Promise<void>;
}

/* A command that runs BEFORE an account is chosen, listing what is connected, and the login that produces the
 * credential a connection is made of. Separated by type rather than by a flag on Command because the
 * difference is what the context can offer: everything else here is handed a session, and these two cannot be,
 * since the whole situation they exist for is not having one yet. */
export interface RootCommand {
    readonly name: string;
    readonly summary: string;
    readonly usage: string;
    readonly run: (ctx: RootContext) => Promise<void>;
}

export interface CommandGroup {
    readonly name: string;
    readonly summary: string;
    readonly commands: readonly Command[];
    readonly rootCommands?: readonly RootCommand[];
}

export const printJson = (ctx: RootContext, value: unknown): void => ctx.out(JSON.stringify(value, undefined, 2));
