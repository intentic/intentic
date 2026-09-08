import type { Connection } from "../google/accounts.js";
import type { Session } from "../google/session.js";
import type { Args } from "./args.js";

// What a `gw` subcommand is, as data rather than a switch: what runs, what `--help` prints, and whether a read-only
// connection refuses it all derive from one list. `writes` is a property of the command, not a check inside it, so the
// refusal happens once, in the router.

export interface RootContext {
    readonly args: Args;
    // `--json`: print Google's own response instead of the compact lines, for a field the summary doesn't carry.
    readonly json: boolean;
    readonly out: (line: string) => void;
    // Every connected account, before one has been chosen; what `gw accounts` reports on.
    readonly connections: readonly Connection[];
}

export interface CommandContext extends RootContext {
    readonly connection: Connection;
    readonly session: Session;
}

export interface Command {
    readonly name: string;
    // One line, shown by `gw <group>`; the usage line shows when the command is used wrongly.
    readonly summary: string;
    readonly usage: string;
    readonly writes?: boolean;
    readonly run: (ctx: CommandContext) => Promise<void>;
}

// A command that runs before an account is chosen: listing what's connected, and the login that produces a credential.
// Kept as its own type since these two can't be handed a session, there isn't one yet.
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
