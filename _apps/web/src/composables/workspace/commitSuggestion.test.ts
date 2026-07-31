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
        // The shape title.ts actually stores that prompt as — it capitalizes every title it derives. Read as
        // prose this filed the type twice: `feat: fix: cascading markers`.
        expect(conventionalSubject([`Fix: cascading markers`])).toBe(`fix: cascading markers`);
        expect(conventionalSubject([`Feat(web)!: drop the legacy panel`])).toBe(`feat(web)!: drop the legacy panel`);
    });

    test(`a word with a colon after it is not a type`, () => {
        expect(conventionalSubject([`Note: the tree is red`])).toBe(`feat: note: the tree is red`);
        expect(conventionalSubject([`Fixing: the flaky tests`])).toBe(`feat: fixing: the flaky tests`);
    });

    test(`an unreadable lead word keeps the whole title under the default type`, () => {
        expect(conventionalSubject([`Cascading truncation markers everywhere`])).toBe(`feat: cascading truncation markers everywhere`);
        expect(conventionalSubject([`Why is the tree red?`])).toBe(`feat: why is the tree red?`);
    });

    /* The commit-msg hook's rule, and the bug it caught: commitlint refuses a subject that opens with a capital
     * (`subject-case`, never sentence-case), so every reading of a title has to undo the sentence case title.ts
     * put there. `fix: Codex agents broken transcript loading` was thrown back; `fix: codex agents…` — the same
     * line, retyped by hand — committed. */
    test(`a subject never opens with a capital, whichever reading produced it`, () => {
        expect(conventionalSubject([`Fix Codex agents broken transcript loading`])).toBe(`fix: codex agents broken transcript loading`);
        expect(conventionalSubject([`fix: Codex agents broken transcript loading`])).toBe(`fix: codex agents broken transcript loading`);
        expect(conventionalSubject([`Codex transcripts stopped loading`])).toBe(`feat: codex transcripts stopped loading`);
    });

    test(`casing that means something keeps it, in the backticks commitlint reads past`, () => {
        expect(conventionalSubject([`GitLab skill`])).toBe(`feat: \`GitLab\` skill`);
        expect(conventionalSubject([`Fix GitHub connection`])).toBe(`fix: \`GitHub\` connection`);
        expect(conventionalSubject([`Fix ChatPanel.vue truncation`])).toBe(`fix: \`ChatPanel.vue\` truncation`);
        // Only the name is quoted — the punctuation after it is the sentence's, not the name's.
        expect(conventionalSubject([`GitLab, GitHub and Codex`])).toBe(`feat: \`GitLab\`, GitHub and Codex`);
        // Nothing to undo: these already open lowercase, and mid-subject casing was never at risk.
        expect(conventionalSubject([`useAgents refresh loop`])).toBe(`feat: useAgents refresh loop`);
        expect(conventionalSubject([`Add API retries`])).toBe(`feat: add API retries`);
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

    /* The model-written shape, `<subject> · <action>` (agent/title-namer.ts): the same two verb tables read
     * from the other end of the title. */

    test(`an action tag that names its type is dropped, exactly as a leading verb is`, () => {
        expect(conventionalSubject([`Sandbox freezes · fix`])).toBe(`fix: sandbox freezes`);
        expect(conventionalSubject([`ChatTabs hover card · refactor`])).toBe("refactor: `ChatTabs` hover card");
    });

    test(`an action tag that only implies its type moves to the front, where a subject wants its verb`, () => {
        expect(conventionalSubject([`Resume-with-Claude prompt · remove`])).toBe(`refactor: remove Resume-with-Claude prompt`);
        expect(conventionalSubject([`Agent card line counts · add`])).toBe(`feat: add agent card line counts`);
        expect(conventionalSubject([`Pipeline execution speed · audit`])).toBe(`chore: audit pipeline execution speed`);
        // The article goes with it, for the reason it goes with a dropped verb: a subject should not open by
        // pointing at something.
        expect(conventionalSubject([`The auth tests · fix`])).toBe(`fix: auth tests`);
    });

    test(`the words the naming prompt itself offers all resolve to a type`, () => {
        // The tag vocabulary is whatever agent/title-namer.ts invites, so its examples are the ones that must
        // not fall through to `feat` — a title suggested by the prompt and then mistyped by this file is a gap
        // between two halves of one feature.
        expect(conventionalSubject([`Turn latency · benchmark`])).toBe(`perf: benchmark turn latency`);
        expect(conventionalSubject([`Nimbalyst editor · compare`])).toBe(`chore: compare nimbalyst editor`);
        expect(conventionalSubject([`Sandbox freezes · diagnose`])).toBe(`fix: diagnose sandbox freezes`);
        expect(conventionalSubject([`Dead imports · cleanup`])).toBe(`refactor: cleanup dead imports`);
    });

    test(`a tag in neither table is the title's last noun, not a verb`, () => {
        // `logging` names no commit type and is not something done TO state management — it is what the work
        // is. Moving it would read as an instruction the title never gave.
        expect(conventionalSubject([`State management · logging`])).toBe(`feat: state management logging`);
    });

    test(`a middle dot that is punctuation rather than a tag is left alone`, () => {
        // Only ONE trailing word can be a tag; anything longer was the title using the separator as a comma.
        expect(conventionalSubject([`Fix the tree · it truncates mid-word`])).toBe(`fix: tree · it truncates mid-word`);
    });

    /* One assertion for what the commit-msg hook actually checks, over every shape above — a filled box that the
     * hook throws back is the whole failure this file exists to avoid, and it is one rule per half of the line:
     *   type-enum    the type is one of commitlint's eleven
     *   subject-case the subject, with backticked spans deleted exactly as `@commitlint/ensure` deletes them
     *                before it looks, does not open with a capital. */
    const TYPES = [`build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`];

    test(`no title yields a line the commit-msg hook refuses`, () => {
        const titles = [
            `Fix Codex agents broken transcript loading`,
            `fix: Codex agents broken transcript loading`,
            `Fix: cascading markers`,
            `Feat(web)!: drop the legacy panel`,
            `GitLab skill`,
            `Fix GitHub connection`,
            `Refactor ChatPanel.vue`,
            `Add API retries`,
            `CI/CD pipelines rail view`,
            `Note: the tree is red`,
            `Update the sandbox deps`,
            `Why is the tree red?`,
            `Refactor`,
            `Sandbox freezes · fix`,
            `Resume-with-Claude prompt · remove`,
            `ChatPanel.vue scroll anchor · rewrite`,
            `State management · logging`,
            `CI/CD rail view · add`,
            `· fix`,
        ];
        for (const title of titles) {
            const message = conventionalSubject([title]);
            const [, type = ``, subject = ``] = /^([a-z]+)(?:\([^)]*\))?!?: (.+)$/.exec(message ?? ``) ?? [];
            expect(TYPES, message).toContain(type);
            expect(subject.replaceAll(/`.*?`/g, ``).trim(), message).not.toMatch(/^\p{Lu}/u);
        }
    });

    test(`nothing to say`, () => {
        expect(conventionalSubject([])).toBeUndefined();
        expect(conventionalSubject([`  `, `.`])).toBeUndefined();
    });
});
