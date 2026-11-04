import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import { t } from "@intentic/ui/i18n";

// THE `/` COMMANDS THIS EDITOR ANSWERS ITSELF, and how they sit beside the ones the agent publishes. Claude Code's own
// clients answer `/usage`, `/model`, `/context` and the rest without a model turn (the VS Code extension opens its own
// dialog for each), and a person who types one here expects the same. Sent as a message they started a session and cost
// a turn; a runtime that publishes no command list (Devin, an ACP agent) read `/usage` as prose and went off on a task
// of its own (2026-11-04). So these never reach the agent, whichever provider the chat runs on: the composer answers
// them in a card over the box (ChatCommandResult) or with the control they name.
//
// Names follow Claude Code's (code.claude.com/docs/en/commands), aliases included, and so does a clash: a command
// somebody wrote (`builtin: false`, a skill or a project command) keeps its name, as a user's `usage` skill replaces
// `/usage` there; the agent's own built-in of the same name gives it up, since this chat's model, title and usage are
// the editor's to show and change, not the CLI's in one session.

export const LOCAL_COMMANDS = [
    { name: `help`, aliases: [] },
    { name: `usage`, aliases: [`cost`, `stats`] },
    { name: `context`, aliases: [] },
    { name: `model`, aliases: [], hint: true },
    { name: `effort`, aliases: [], hint: true },
    { name: `plan`, aliases: [], hint: true },
    { name: `status`, aliases: [] },
    { name: `todos`, aliases: [] },
    { name: `clear`, aliases: [`new`, `reset`] },
    { name: `rename`, aliases: [], hint: true },
    { name: `copy`, aliases: [] },
    { name: `stop`, aliases: [] },
    { name: `config`, aliases: [`settings`] },
] as const satisfies readonly { readonly name: string; readonly aliases: readonly string[]; readonly hint?: true }[];

export type LocalCommandName = (typeof LOCAL_COMMANDS)[number][`name`];

// One row of the `/` list: an agent's command as published, or one of ours, marked by the name it runs as.
export interface SlashRow extends AgentCommand {
    readonly local?: LocalCommandName;
    readonly aliases?: readonly string[];
}

// Claude Code built-ins that only mean something in its own terminal (the prompt bar's colour, the focus view, a heap
// dump to the CLI's home) or are its server's plumbing: typed, they still go to it, but they are not offered.
const TERMINAL_ONLY: ReadonlySet<string> = new Set([`color`, `focus`, `heapdump`, `workflow-launch-exec`]);
const offeredBuiltin = (command: AgentCommand): boolean => !TERMINAL_ONLY.has(command.name) && !command.name.startsWith(`__`);

const ownedBySomeone = (command: AgentCommand): boolean => command.builtin === false;
const LOCAL_NAMES: ReadonlySet<string> = new Set(LOCAL_COMMANDS.flatMap((spec) => [spec.name, ...spec.aliases]));

const localRow = (spec: (typeof LOCAL_COMMANDS)[number]): SlashRow => {
    const row: SlashRow = { name: spec.name, description: t(`chat.slashCommands.${spec.name}`), local: spec.name, aliases: spec.aliases };
    return `hint` in spec ? { ...row, hint: t(`chat.slashCommands.hint.${spec.name}`) } : row;
};

/** The `/` list: ours (less any whose name a command somebody wrote holds), then the agent's, less its built-ins ours replace. */
export const slashRows = (offered: ReadonlySet<LocalCommandName>, agent: readonly AgentCommand[]): SlashRow[] => {
    const owned = new Set(agent.filter(ownedBySomeone).map((command) => command.name));
    const ours = LOCAL_COMMANDS.filter((spec) => offered.has(spec.name) && !owned.has(spec.name)).map(localRow);
    const theirs = agent.filter(
        (command) => ownedBySomeone(command) || (!LOCAL_NAMES.has(command.name) && (command.builtin !== true || offeredBuiltin(command))),
    );
    return [...ours, ...theirs];
};

// The first word of a `/`-led draft, as the CLI parses it: up to the first whitespace, after any leading whitespace.
const leadingWord = (draft: string): { readonly name: string; readonly args: string } | undefined => {
    const text = draft.trimStart();
    if (!text.startsWith(`/`)) {
        return undefined;
    }
    const [name = ``] = text.slice(1).split(/\s/, 1);
    return { name, args: text.slice(1 + name.length).trim() };
};

const runsAs = (row: SlashRow, name: string): boolean => row.name === name || (row.aliases?.includes(name) ?? false);

/** The row a draft runs as: its whole first word against the names and aliases, the rule the daemon applies too. */
export const slashRunOf = (draft: string, rows: readonly SlashRow[]): SlashRow | undefined => {
    const word = leadingWord(draft);
    return word === undefined || word.name === ``
        ? undefined
        : (rows.find((row) => row.name === word.name) ?? rows.find((row) => runsAs(row, word.name)));
};

// What the composer does itself with a draft. `typed` is the word as written, an alias included, for the card to echo.
export type LocalRun =
    | { readonly kind: `run`; readonly name: LocalCommandName; readonly args: string; readonly typed: string }
    // One of ours this reader is not offered (a guest's `/model`): answered as unavailable rather than sent as prose.
    | { readonly kind: `unavailable`; readonly typed: string };

/** What the composer does itself with this draft; undefined for a message, or a command the agent runs. */
export const localRunOf = (draft: string, rows: readonly SlashRow[], offered: ReadonlySet<LocalCommandName>): LocalRun | undefined => {
    const word = leadingWord(draft);
    if (word === undefined || word.name === ``) {
        return undefined;
    }
    const row = slashRunOf(draft, rows);
    if (row !== undefined) {
        return row.local === undefined ? undefined : { kind: `run`, name: row.local, args: word.args, typed: word.name };
    }
    // Not a row: an alias whose command somebody's own took by name (a `usage` skill leaves `/cost` ours), or one of ours
    // this reader is not offered.
    const spec = LOCAL_COMMANDS.find((candidate) => candidate.name === word.name || candidate.aliases.some((alias) => alias === word.name));
    if (spec === undefined) {
        return undefined;
    }
    return offered.has(spec.name) ? { kind: `run`, name: spec.name, args: word.args, typed: word.name } : { kind: `unavailable`, typed: word.name };
};

/** Which of ours a reader is offered: a guest's model is the one it was handed and its usage is nobody's to read; the
 * agent settings are a maintainer's page. */
export const offeredCommands = (reader: { readonly guest: boolean; readonly maintainer: boolean }): ReadonlySet<LocalCommandName> =>
    new Set(
        LOCAL_COMMANDS.map((spec) => spec.name).filter((name) => {
            if (reader.guest && (name === `model` || name === `effort` || name === `usage` || name === `clear`)) {
                return false;
            }
            return name !== `config` || reader.maintainer;
        }),
    );

/** The rows a typed token could still become: the one it already names first, then the reviewer `leads` names (a bare `/`
 * would otherwise bury it past the popover's eighth row under ours), then ours, then the rest. */
export const slashMatches = (rows: readonly SlashRow[], needle: string, leads: (row: SlashRow) => boolean): SlashRow[] => {
    const rank = (row: SlashRow): number => (runsAs(row, needle) ? 0 : leads(row) ? 1 : row.local !== undefined ? 2 : 3);
    return rows
        .filter((row) => row.name.toLowerCase().includes(needle) || (row.aliases?.some((alias) => alias.includes(needle)) ?? false))
        .toSorted((a, b) => rank(a) - rank(b));
};
