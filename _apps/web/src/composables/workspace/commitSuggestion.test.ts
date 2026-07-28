import { describe, expect, test } from "vitest";
import { conventionalSubject } from "./commitSuggestion";

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
