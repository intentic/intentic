import type { GitChange, RepoChanges } from "@intentic-app/api-contract";
import { describe, expect, test } from "vitest";
import { conventionalSubject, suggestCommitMessage } from "./commitSuggestion";

const change = (path: string, status: GitChange[`status`] = `modified`): GitChange => ({ path, status });
const repo = (name: string, sides: Partial<Pick<RepoChanges, `conflicted` | `staged` | `unstaged` | `origins`>>): RepoChanges => ({
    repo: name,
    conflicted: [],
    staged: [],
    unstaged: [],
    ...sides,
});

describe(`conventionalSubject`, () => {
    test(`a verb that names its type is dropped, article and all`, () => {
        expect(conventionalSubject([`Fix cascading workspace tree truncation markers`])).toBe(`fix: cascading workspace tree truncation markers`);
        expect(conventionalSubject([`Refactor the origins map`])).toBe(`refactor: origins map`);
        expect(conventionalSubject([`Document the panels skill`])).toBe(`docs: panels skill`);
    });

    test(`every other verb stays — the prefix is not a verb and cannot carry the action`, () => {
        expect(conventionalSubject([`Add icons to chat tabs`])).toBe(`feat: add icons to chat tabs`);
        expect(conventionalSubject([`Simplify the seed logic`])).toBe(`refactor: simplify the seed logic`);
        expect(conventionalSubject([`Update the sandbox deps`])).toBe(`chore: update the sandbox deps`);
        expect(conventionalSubject([`Stop the tree from truncating`])).toBe(`fix: stop the tree from truncating`);
    });

    test(`a title already written as a subject keeps its own type`, () => {
        expect(conventionalSubject([`fix: cascading markers`])).toBe(`fix: cascading markers`);
        expect(conventionalSubject([`feat(web)!: drop the legacy panel`])).toBe(`feat(web)!: drop the legacy panel`);
    });

    test(`an unreadable lead word keeps the whole title under the default type`, () => {
        expect(conventionalSubject([`Cascading truncation markers everywhere`])).toBe(`feat: cascading truncation markers everywhere`);
        expect(conventionalSubject([`Why is the tree red?`])).toBe(`feat: why is the tree red?`);
    });

    test(`casing that means something is left alone`, () => {
        expect(conventionalSubject([`GitLab skill`])).toBe(`feat: GitLab skill`);
        expect(conventionalSubject([`Fix GitHub connection`])).toBe(`fix: GitHub connection`);
    });

    test(`a trailing full stop goes, a question mark stays`, () => {
        expect(conventionalSubject([`Fix the flaky auth tests.`])).toBe(`fix: flaky auth tests`);
        expect(conventionalSubject([`Add a retry?`])).toBe(`feat: add a retry?`);
    });

    test(`a verb that was the whole title has nothing to drop`, () => {
        expect(conventionalSubject([`Refactor`])).toBe(`refactor: refactor`);
    });

    test(`several sessions share one commit, so their titles share one subject`, () => {
        expect(conventionalSubject([`Fix the rtk builtin`, `Add hover card placement`])).toBe(`fix: rtk builtin, add hover card placement`);
    });

    test(`identical titles are not repeated`, () => {
        expect(conventionalSubject([`Fix the tree`, `Fix the Tree`])).toBe(`fix: tree`);
    });

    test(`nothing to say`, () => {
        expect(conventionalSubject([])).toBeUndefined();
        expect(conventionalSubject([`  `, `.`])).toBeUndefined();
    });
});

describe(`suggestCommitMessage`, () => {
    const titles: Record<string, string> = { "agent-1": `Fix cascading markers`, "agent-2": `Add chat tab icons` };
    const titleOf = (id: string): string | undefined => titles[id];

    test(`with nothing staged, every side's origins describe the "Commit all"`, () => {
        const repos = [
            repo(`root`, { unstaged: [change(`a.ts`)], origins: { "a.ts": [`agent-2`] } }),
            repo(`intentic`, { unstaged: [change(`b.ts`), change(`c.ts`)], origins: { "b.ts": [`agent-1`], "c.ts": [`agent-1`] } }),
        ];
        // Busiest session first, and it sets the type.
        expect(suggestCommitMessage(repos, titleOf)).toBe(`fix: cascading markers, add chat tab icons`);
    });

    test(`with something staged, the unstaged sessions are not described — the commit records the index`, () => {
        const repos = [
            repo(`root`, {
                staged: [change(`a.ts`)],
                unstaged: [change(`b.ts`)],
                origins: { "a.ts": [`agent-2`], "b.ts": [`agent-1`] },
            }),
        ];
        expect(suggestCommitMessage(repos, titleOf)).toBe(`feat: add chat tab icons`);
    });

    test(`an origin with no title in the fleet mirror is skipped, not named by its id`, () => {
        const repos = [repo(`root`, { unstaged: [change(`a.ts`)], origins: { "a.ts": [`ghost`] } })];
        expect(suggestCommitMessage(repos, titleOf)).toBeUndefined();
    });

    test(`nothing an agent landed, nothing to suggest`, () => {
        expect(suggestCommitMessage([repo(`root`, { unstaged: [change(`mine.ts`)] })], titleOf)).toBeUndefined();
        expect(suggestCommitMessage([], titleOf)).toBeUndefined();
    });
});
