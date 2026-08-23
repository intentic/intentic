import { expect, test } from "vitest";
import { type ComplexityInput, FAST_CEILING, judgeComplexity } from "./prompt-complexity.js";

/* WHETHER A TURN COULD HAVE RUN ON THE CHEAP RUNG, judged before anything is spent.
 *
 * What these tests pin is the ASYMMETRY, not the accuracy: the judge can only ever route down, so every one of
 * its mistakes in the "standard" direction costs a fraction of a cent and every mistake in the "fast" direction
 * costs a user their turn. So the properties worth nailing down are that silence resolves to standard, that a
 * gate or an escalating rule ends the question whatever else the sentence says, and that no rule ORDER can
 * change an answer. The weights themselves are a hypothesis with a ledger under it (settings.autoTier
 * "shadow"), and a test that froze them would be a test that made them impossible to fit. */

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

// --- silence, and what it is read as -----------------------------------------------------------------

test("a prompt matching nothing at all stays on the model the user picked", () => {
    // The single most important default in the file. An unrecognised request is MEDIUM, never simple: the
    // conservative reading of silence is the only safe one when a wrong downgrade costs a retry and a
    // user who stops trusting the feature.
    const verdict = judgeComplexity(turn(`Have another go at the thing we were discussing yesterday afternoon`));

    expect(verdict.tier).toBe(`standard`);
    expect(verdict.score).toBeGreaterThan(FAST_CEILING);
    // Nothing in the sentence made a positive claim in either direction, so only the two absence features
    // fired, and the pair of them cannot reach the ceiling by design.
    expect(verdict.rules).toEqual([`short-prompt`, `no-workspace-reference`]);
});

test("a short vague request is not read as an easy one", () => {
    // Absence of complexity is not evidence of simplicity. Weighted the obvious way, "short and naming no
    // file" reached the ceiling by itself and downgraded every terse request in the product.
    expect(tierOf(`fix the bug`)).toBe(`standard`);
    expect(tierOf(`have a look at the thing we discussed`)).toBe(`standard`);
});

test("an empty-ish prompt is not mistaken for an easy one", () => {
    expect(tierOf(`   `)).toBe(`standard`);
});

// --- the fast end ------------------------------------------------------------------------------------

test("a short question about nothing in the workspace is the case this feature exists for", () => {
    expect(tierOf(`what is a closure?`)).toBe(`fast`);
});

test("naming a file keeps an otherwise easy question on the user's own model", () => {
    // "explain" is the easiest word in the lexicon, but the turn is now about real code in this repo rather
    // than about a concept, and the cheap rung's failures on real code are the silent kind.
    expect(tierOf(`explain what is a closure`)).toBe(`fast`);
    expect(tierOf(`explain what src/agent/turn-plan.ts does`)).toBe(`standard`);
});

test("a trivial aside inside a hard conversation still gets through", () => {
    // The reason afterHardTurn is a weight and not a lock: a conversation that has been doing hard work is
    // still allowed to be asked an easy question, and locking it out is a mechanism that saves nothing.
    expect(tierOf(`what is a closure?`, { afterHardTurn: true })).toBe(`fast`);
});

test("a workspace-adjacent errand stops being cheap once the conversation has done hard work", () => {
    // The contrast with the test above is the whole rule. A pure knowledge question survives the penalty
    // because it earns every easing feature there is; an errand about this repo does not, and after hard work
    // it is far likelier to be the deceptive follow-up than a genuine aside.
    expect(tierOf(`list the exports`, { afterHardTurn: false })).toBe(`fast`);
    expect(tierOf(`list the exports`, { afterHardTurn: true })).toBe(`standard`);
});

// --- gates: the turn's situation, whatever its words say ---------------------------------------------

test("a screenshot is never sent to the cheap rung, however simple the question about it", () => {
    // The tier most likely to misread an image, on the turn least likely to notice that it did.
    expect(tierOf(`what is this?`, { hasImages: true, attachments: 1 })).toBe(`standard`);
});

test("plan mode is a request to think, so it is never answered by the model that thinks least", () => {
    expect(tierOf(`what is a closure?`, { planMode: true })).toBe(`standard`);
});

test("a surface-started run is never downgraded, because nobody is watching it fail", () => {
    // Same call agentRunModels already makes in the other direction: a run billed whole, with a worktree in
    // it, is not the place to spend a guess.
    expect(tierOf(`what is a closure?`, { unattended: true })).toBe(`standard`);
});

test("a gate reports itself and scores 1, so the ledger can tell a gate from a hard sentence", () => {
    const verdict = judgeComplexity(turn(`hi`, { unattended: true }));

    expect(verdict.score).toBe(1);
    expect(verdict.rules).toContain(`unattended`);
});

// --- escalating rules: any one ends the question ------------------------------------------------------

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
    // Short, easy-worded, no workspace reference, a bare question: every negative weight in the file, plus one
    // escalating rule. Monotone escalation means the rule wins, which is what makes adding a rule tomorrow a
    // safe change: it can only ever move turns UP a tier.
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

// --- the verdict as a record --------------------------------------------------------------------------

test("names every rule that fired, because a score alone cannot say which feature did the work", () => {
    // The ledger stores these. Re-fitting the weights against real traffic needs to know WHICH feature moved a
    // turn, not merely that a threshold was crossed.
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

// --- the one dial, and the property it may not move ------------------------------------------------------

/* The owner can move the cutoff (settings.autoTierEagerness) because "err toward my model or toward the cheap
 * one" is a preference nobody else can hold for them. What these pin is that the dial moves the cutoff and
 * NOTHING else, in particular not the rule that a downgrade needs something positively easy to have been said,
 * which was the property the old ceiling held only by arithmetic coincidence. */

test("the dial widens what counts as simple, in the direction it says", () => {
    // A question about a real file: eased by its words, held back by naming a path. The middle stop keeps it on
    // the user's pick, and the eager stop is precisely the choice to let it through.
    const aboutAFile = `explain what src/app.ts does`;

    expect(tierOf(aboutAFile, { eagerness: `balanced` })).toBe(`standard`);
    expect(tierOf(aboutAFile, { eagerness: `eager` })).toBe(`fast`);
});

test("the cautious stop wants every easing signal at once, not merely an easy word", () => {
    // Its whole content: leave no room for doubt. A statement in easy words still qualifies at the default,
    // and does not here; only a short bare question naming no file survives every stop.
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
    // The whole safety argument for offering an eager stop at all. Absence of complexity is not evidence of
    // simplicity at ANY cutoff, so this is a rule in the judge rather than a sum that happens to clear it.
    for (const eagerness of [`cautious`, `balanced`, `eager`] as const) {
        expect(tierOf(`fix the bug`, { eagerness })).toBe(`standard`);
        expect(tierOf(`have a look at the thing we discussed`, { eagerness })).toBe(`standard`);
    }
});

test("the deceptive follow-up is standard at every stop, because it never says anything easy", () => {
    /* "now do the same for the other file" is the case the whole afterHardTurn signal was built for, and the
     * easing rule turns out to answer it more strongly than any cutoff can: those words make no positive claim
     * of ease, so no setting of the dial reaches them. The weight still does its own job one test down. */
    for (const eagerness of [`cautious`, `balanced`, `eager`] as const) {
        expect(tierOf(`now do the same for the other file`, { eagerness, afterHardTurn: true })).toBe(`standard`);
    }
});

test("a turn following hard work has to clear a higher bar, and at the default an eased one no longer does", () => {
    // It raises the bar rather than locking the door (see ComplexityInput.afterHardTurn), so this is a shift of
    // one stop's worth, not a gate: the same words that route in a fresh conversation stay put in a hard one.
    expect(tierOf(`explain closures`)).toBe(`fast`);
    expect(tierOf(`explain closures`, { afterHardTurn: true })).toBe(`standard`);
});

test("the verdict carries the cutoff it was judged against, because a score alone stopped being an answer", () => {
    // With the cutoff an owner setting, the same 0.35 is standard on one stop and fast on another. A ledger of
    // bare scores could not tell those two rows apart; the ceiling beside each is what keeps a refit honest.
    const cautious = judgeComplexity(turn(`explain closures`, { eagerness: `cautious` }));
    const eager = judgeComplexity(turn(`explain closures`, { eagerness: `eager` }));

    expect(cautious.ceiling).toBeLessThan(FAST_CEILING);
    expect(eager.ceiling).toBeGreaterThan(FAST_CEILING);
    // Same words, same score, opposite verdicts: the pair that a column of bare scores could not have told apart.
    expect(cautious.score).toBe(eager.score);
    expect([cautious.tier, eager.tier]).toEqual([`standard`, `fast`]);
});
