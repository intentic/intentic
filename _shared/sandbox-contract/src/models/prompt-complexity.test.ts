import { expect, test } from "vitest";
import { type ComplexityInput, FAST_CEILING, judgeComplexity } from "./prompt-complexity.js";

// Pins the asymmetry: the judge only ever routes down, so silence resolves to standard, any escalating rule or gate
// wins regardless of order, and the weights (settings.autoTier "shadow") stay unpinned.

const turn = (prompt: string, over: Partial<ComplexityInput> = {}): ComplexityInput => ({
    prompt,
    attachments: 0,
    hasImages: false,
    editorContext: false,
    unattended: false,
    planMode: false,
    afterHardTurn: false,
    ...over,
});

const tierOf = (prompt: string, over: Partial<ComplexityInput> = {}) => judgeComplexity(turn(prompt, over)).tier;

test("a prompt matching nothing at all stays on the model the user picked", () => {
    const verdict = judgeComplexity(turn(`Have another go at the thing we were discussing yesterday afternoon`));

    expect(verdict.tier).toBe(`standard`);
    expect(verdict.score).toBeGreaterThan(FAST_CEILING);
    // Only the two absence features fire on this input; together they cannot reach the ceiling.
    expect(verdict.rules).toEqual([`short-prompt`, `no-workspace-reference`]);
});

test("a short vague request is not read as an easy one", () => {
    expect(tierOf(`fix the bug`)).toBe(`standard`);
    expect(tierOf(`have a look at the thing we discussed`)).toBe(`standard`);
});

test("an empty-ish prompt is not mistaken for an easy one", () => {
    expect(tierOf(`   `)).toBe(`standard`);
});

test("a short question about nothing in the workspace is the case this feature exists for", () => {
    expect(tierOf(`what is a closure?`)).toBe(`fast`);
});

test("naming a file keeps an otherwise easy question on the user's own model", () => {
    // Same easy word; naming a real file, not a concept, tips the verdict to standard.
    expect(tierOf(`explain what is a closure`)).toBe(`fast`);
    expect(tierOf(`explain what src/agent/turn-plan.ts does`)).toBe(`standard`);
});

test("a trivial aside inside a hard conversation still gets through", () => {
    expect(tierOf(`what is a closure?`, { afterHardTurn: true })).toBe(`fast`);
});

test("a workspace-adjacent errand stops being cheap once the conversation has done hard work", () => {
    expect(tierOf(`list the exports`, { afterHardTurn: false })).toBe(`fast`);
    expect(tierOf(`list the exports`, { afterHardTurn: true })).toBe(`standard`);
});

test("a screenshot is never sent to the cheap rung, however simple the question about it", () => {
    expect(tierOf(`what is this?`, { hasImages: true, attachments: 1 })).toBe(`standard`);
});

test("plan mode is a request to think, so it is never answered by the model that thinks least", () => {
    expect(tierOf(`what is a closure?`, { planMode: true })).toBe(`standard`);
});

test("a surface-started run is never downgraded, because nobody is watching it fail", () => {
    expect(tierOf(`what is a closure?`, { unattended: true })).toBe(`standard`);
});

test("a gate reports itself and scores 1, so the ledger can tell a gate from a hard sentence", () => {
    const verdict = judgeComplexity(turn(`hi`, { unattended: true }));

    expect(verdict.score).toBe(1);
    expect(verdict.rules).toContain(`unattended`);
});

test.each([
    [`pasted code`, "explain this\n```ts\nconst x = 1;\n```"],
    [`a stack trace`, "it broke\n  at Object.run (/work/x.ts:12:3)"],
    [`a thrown error`, "help\nTypeError: cannot read properties of undefined"],
    [`a hard word`, `why does the picker reset`],
    [`another hard word`, `refactor this`],
    [`a second job`, `rename it and then update the tests`],
    [`a checklist`, `- rename it\n- update the tests`],
    [`a cross-cutting scope`, `rename it across the codebase`],
])("%s forces the user's own model even in an otherwise tiny prompt", (_name, prompt) => {
    expect(tierOf(prompt)).toBe(`standard`);
});

test("an escalating rule beats every easing feature at once, so rule order cannot change an answer", () => {
    // This prompt trips every easing weight in the file, plus one escalating rule; escalation still wins.
    const verdict = judgeComplexity(turn(`what is a race condition?`));

    expect(verdict.tier).toBe(`standard`);
    expect(verdict.score).toBe(1);
    expect(verdict.rules).toEqual([`hard-words`]);
});

test("a long brief is standard on its length alone, whatever words it happens to use", () => {
    expect(tierOf(`explain `.repeat(400))).toBe(`standard`);
});

test("three files in, the job is about a shape rather than about a file", () => {
    expect(tierOf(`have a look`, { attachments: 3 })).toBe(`standard`);
    expect(tierOf(`have a look`, { attachments: 1 })).toBe(`standard`);
});

test("names every rule that fired, because a score alone cannot say which feature did the work", () => {
    const verdict = judgeComplexity(turn(`what is this?`));

    expect(verdict.rules).toEqual([`short-prompt`, `easy-words`, `bare-question`, `no-workspace-reference`]);
});

test("scores are rounded, so two turns the same rules judged compare equal on the ledger", () => {
    const score = judgeComplexity(turn(`what is this?`)).score;

    expect(score).toBe(Number(score.toFixed(3)));
});

test("the score never leaves 0..1, so a stored row is always comparable against the ceiling", () => {
    const floor = judgeComplexity(turn(`what is this?`));
    const ceiling = judgeComplexity(turn(`refactor everything`));

    expect(floor.score).toBeGreaterThanOrEqual(0);
    expect(ceiling.score).toBeLessThanOrEqual(1);
});

// eagerness moves only the cutoff; a downgrade still needs a positive easy signal at any setting.

test("the dial widens what counts as simple, in the direction it says", () => {
    // Eased by its words, held back by naming a real file; balanced keeps it standard, eager lets it through.
    const aboutAFile = `explain what src/app.ts does`;

    expect(tierOf(aboutAFile, { eagerness: `balanced` })).toBe(`standard`);
    expect(tierOf(aboutAFile, { eagerness: `eager` })).toBe(`fast`);
});

test("the cautious stop wants every easing signal at once, not merely an easy word", () => {
    // "explain closures" fails the cautious stop (not a bare question); only a bare question clears every stop.
    expect(tierOf(`explain closures`, { eagerness: `balanced` })).toBe(`fast`);
    expect(tierOf(`explain closures`, { eagerness: `cautious` })).toBe(`standard`);
    expect(tierOf(`what is a closure?`, { eagerness: `cautious` })).toBe(`fast`);
});

test("an absent dial is the balanced stop, so every row recorded before it existed still compares", () => {
    const bare = judgeComplexity(turn(`what is this?`));

    expect(bare.ceiling).toBe(FAST_CEILING);
    expect(bare.tier).toBe(judgeComplexity(turn(`what is this?`, { eagerness: `balanced` })).tier);
});

test("no setting of the dial can downgrade a short vague request", () => {
    for (const eagerness of [`cautious`, `balanced`, `eager`] as const) {
        expect(tierOf(`fix the bug`, { eagerness })).toBe(`standard`);
        expect(tierOf(`have a look at the thing we discussed`, { eagerness })).toBe(`standard`);
    }
});

test("the deceptive follow-up is standard at every stop, because it never says anything easy", () => {
    for (const eagerness of [`cautious`, `balanced`, `eager`] as const) {
        expect(tierOf(`now do the same for the other file`, { eagerness, afterHardTurn: true })).toBe(`standard`);
    }
});

test("a turn following hard work has to clear a higher bar, and at the default an eased one no longer does", () => {
    expect(tierOf(`explain closures`)).toBe(`fast`);
    expect(tierOf(`explain closures`, { afterHardTurn: true })).toBe(`standard`);
});

test("the verdict carries the cutoff it was judged against, because a score alone stopped being an answer", () => {
    const cautious = judgeComplexity(turn(`explain closures`, { eagerness: `cautious` }));
    const eager = judgeComplexity(turn(`explain closures`, { eagerness: `eager` }));

    expect(cautious.ceiling).toBeLessThan(FAST_CEILING);
    expect(eager.ceiling).toBeGreaterThan(FAST_CEILING);
    expect(cautious.score).toBe(eager.score);
    expect([cautious.tier, eager.tier]).toEqual([`standard`, `fast`]);
});
