import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import { LOCAL_COMMANDS, localRunOf, offeredCommands, slashMatches, slashRows, slashRunOf } from "./slashCommands";

// Pins which `/` names the composer answers itself, how a clash with the agent's list settles (Claude Code's rule: a
// command somebody wrote keeps its name, the agent's built-in gives it up, an alias stays ours), and which drafts are
// prose after all.

const EVERY = offeredCommands({ guest: false, maintainer: true });
const AGENT: AgentCommand[] = [
    { name: `compact`, description: `Free up context.`, builtin: true },
    { name: `usage`, description: `The CLI's own usage panel.`, builtin: true },
    { name: `color`, description: `Set the prompt bar color.`, builtin: true },
    { name: `__remote-workflow`, description: `Plumbing.`, builtin: true },
    { name: `code-review`, description: `Review the diff.`, builtin: true },
    { name: `todo`, description: `The owner's own todo skill.`, builtin: false },
];
const names = (rows: readonly { readonly name: string }[]): string[] => rows.map((row) => row.name);

describe(`the / list`, () => {
    it(`puts ours first and keeps the agent's commands that no name of ours replaces`, () => {
        const rows = slashRows(EVERY, AGENT);
        expect(names(rows)).toEqual([...LOCAL_COMMANDS.map((spec) => spec.name), `compact`, `code-review`, `todo`]);
        expect(rows.find((row) => row.name === `usage`)?.local).toBe(`usage`);
    });

    it(`gives a name to a command somebody wrote, while the alias stays ours`, () => {
        const rows = slashRows(EVERY, [...AGENT, { name: `usage`, description: `The team's usage skill.`, builtin: false }]);
        expect(rows.filter((row) => row.name === `usage`)).toEqual([{ name: `usage`, description: `The team's usage skill.`, builtin: false }]);
        expect(localRunOf(`/usage`, rows, EVERY)).toBeUndefined();
        expect(localRunOf(`/cost`, rows, EVERY)).toEqual({ kind: `run`, name: `usage`, args: ``, typed: `cost` });
    });

    it(`keeps a command of unknown provenance that no name of ours claims`, () => {
        const rows = slashRows(EVERY, [{ name: `deploy`, description: `Ship it.` }, { name: `model`, description: `An ACP agent's own.` }]);
        expect(names(rows).filter((name) => name === `deploy` || name === `model`)).toEqual([`model`, `deploy`]);
        expect(rows.find((row) => row.name === `model`)?.local).toBe(`model`);
    });
});

describe(`a draft`, () => {
    const rows = slashRows(EVERY, AGENT);

    it(`runs here when its whole first word is one of ours, its words after it the arguments`, () => {
        expect(localRunOf(`  /model  opus 4  `, rows, EVERY)).toEqual({ kind: `run`, name: `model`, args: `opus 4`, typed: `model` });
        expect(localRunOf(`/new`, rows, EVERY)).toEqual({ kind: `run`, name: `clear`, args: ``, typed: `new` });
    });

    it(`goes to the agent as before when it is the agent's command, a path, prose or a bare slash`, () => {
        expect(localRunOf(`/compact keep the API notes`, rows, EVERY)).toBeUndefined();
        expect(localRunOf(`/todo buy milk`, rows, EVERY)).toBeUndefined();
        expect(slashRunOf(`/todo buy milk`, rows)?.name).toBe(`todo`);
        expect(localRunOf(`/ext/deployments looks off`, rows, EVERY)).toBeUndefined();
        expect(localRunOf(`/usages are spiking`, rows, EVERY)).toBeUndefined();
        expect(localRunOf(`what does /usage show?`, rows, EVERY)).toBeUndefined();
        expect(localRunOf(`/`, rows, EVERY)).toBeUndefined();
    });

    it(`is answered as unavailable when it names one of ours this reader is not offered`, () => {
        const guest = offeredCommands({ guest: true, maintainer: false });
        expect(localRunOf(`/model sonnet`, slashRows(guest, AGENT), guest)).toEqual({ kind: `unavailable`, typed: `model` });
        expect(localRunOf(`/settings`, slashRows(guest, AGENT), guest)).toEqual({ kind: `unavailable`, typed: `settings` });
    });
});

describe(`who is offered what`, () => {
    it(`withholds a guest's model, effort, usage and new chat, and the agent settings from all but a maintainer`, () => {
        expect([...offeredCommands({ guest: true, maintainer: false })]).toEqual([`help`, `context`, `plan`, `status`, `todos`, `rename`, `copy`, `stop`]);
        expect(offeredCommands({ guest: false, maintainer: false }).has(`config`)).toBe(false);
        expect(EVERY.size).toBe(LOCAL_COMMANDS.length);
    });
});

describe(`matching a typed token`, () => {
    const rows = slashRows(EVERY, AGENT);
    const isReviewer = (row: { readonly name: string }): boolean => row.name === `code-review`;

    // `usage` by its alias `cost`.
    it(`ranks the row the token names whole first, then the reviewer, then ours`, () => {
        expect(names(slashMatches(rows, `co`, isReviewer))).toEqual([`code-review`, `usage`, `context`, `copy`, `config`, `compact`]);
        expect(names(slashMatches(rows, `compact`, isReviewer))).toEqual([`compact`]);
        expect(names(slashMatches(rows, `todo`, isReviewer))).toEqual([`todo`, `todos`]);
    });

    it(`finds ours by an alias`, () => {
        expect(names(slashMatches(rows, `stats`, isReviewer))).toEqual([`usage`]);
        expect(names(slashMatches(rows, `reset`, isReviewer))).toEqual([`clear`]);
    });
});
