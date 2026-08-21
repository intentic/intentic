import { expect, test } from "vitest";
import { fastTierModel } from "./fast-tier.js";

/* WHERE A DOWNGRADED TURN ACTUALLY LANDS. The judge (prompt-complexity.ts) says a turn could be cheaper; this
 * says whether there is anywhere cheaper to put it, on the provider it is already on.
 *
 * Two properties carry the whole feature, and everything below is one of them: a downgrade is only ever to a
 * genuinely CHEAPER rung of the same catalog (so "cheaper" can never quietly become "older", or "the same model
 * with less thinking"), and it never crosses PROVIDER (because that retires the conversation's session, which
 * throws away the context that made the follow-up cheap to answer in the first place). */

const CLAUDE = [`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`];
const GOOGLE = [`gemini-3-pro`, `gemini-3-flash`, `gemini-3-flash-lite`];

const fastFor = (model: string, over: { models?: readonly string[]; pinned?: readonly string[]; provider?: string } = {}) =>
    fastTierModel({ provider: over.provider ?? `claude`, model, models: over.models ?? CLAUDE, pinned: over.pinned ?? [] });

// --- Auto: the cheapest rung the provider publishes ----------------------------------------------------

test("sends a frontier turn to the provider's own cheap rung", () => {
    expect(fastFor(`claude-opus-5`)).toBe(`claude-haiku-4-5-20251001`);
});

test("reads the cheap end the same way the quick model does, on every vendor's vocabulary", () => {
    expect(fastFor(`gemini-3-pro`, { provider: `gemini`, models: GOOGLE })).toBe(`gemini-3-flash-lite`);
});

// --- the ceiling: the user's own pick -------------------------------------------------------------------

test("a user already on the cheap rung has nowhere to be sent", () => {
    // The common case worth being exact about rather than an edge case. Undefined means "run what they asked
    // for", which is the honest answer and the one that costs nothing to be wrong about.
    expect(fastFor(`claude-haiku-4-5-20251001`)).toBeUndefined();
});

test("never swaps a model for an older build of the same tier", () => {
    // A downgrade has to be legible AS a downgrade. Last year's Sonnet under this year's Sonnet is not a
    // saving the feature promised, it is a different turn wearing the user's own model name.
    expect(fastFor(`claude-sonnet-5`, { models: [`claude-sonnet-5`, `claude-sonnet-4`] })).toBeUndefined();
});

test("never downgrades a model whose family this build does not recognise", () => {
    // An id carrying no tier word is a provider's base line or a family nobody here has heard of, and betting
    // a user's turn on the guess that an unknown id is the budget one is the wrong direction to be wrong in.
    expect(fastFor(`claude-opus-5`, { models: [`some-new-thing`] })).toBeUndefined();
    expect(fastFor(`some-new-thing`, { models: CLAUDE })).toBeUndefined();
});

test("an unloaded catalog resolves to no downgrade rather than to a guess", () => {
    expect(fastFor(`claude-opus-5`, { models: [] })).toBeUndefined();
});

test("no pick yet means nothing to be cheaper than", () => {
    expect(fastFor(``)).toBeUndefined();
});

// --- pins -----------------------------------------------------------------------------------------------

test("a pin on this provider wins over the catalog's own cheap end", () => {
    expect(fastFor(`claude-opus-5`, { pinned: [`claude:claude-sonnet-5`] })).toBe(`claude-sonnet-5`);
});

test("takes a pinned id verbatim, so a model the static catalog has not caught up with is still pinnable", () => {
    // The same call resolveQuickModels makes, and for the same reason: the picker offers a custom-id escape
    // hatch, and second-guessing the id here would run a different model than the settings row names.
    expect(fastFor(`claude-opus-5`, { pinned: [`claude:claude-haiku-9`] })).toBe(`claude-haiku-9`);
});

test("drops a pin naming another provider rather than crossing to it", () => {
    // Switching provider retires the conversation's session (turnRequest.ts `resumes`). Starting the
    // conversation over to save a fraction of a cent is not a saving, so the pin is ignored and Auto answers.
    expect(fastFor(`claude-opus-5`, { pinned: [`gemini:gemini-3-flash-lite`] })).toBe(`claude-haiku-4-5-20251001`);
});

test("skips a pin that is not actually cheaper than what the user picked", () => {
    // A pin is a preference about WHICH cheap rung, never a licence to swap a model for its equal or better.
    expect(fastFor(`claude-sonnet-5`, { pinned: [`claude:claude-opus-5`] })).toBe(`claude-haiku-4-5-20251001`);
});

test("walks past an unusable pin to the next one that names this provider", () => {
    const pinned = [`gemini:gemini-3-flash`, `claude:claude-opus-5`, `claude:claude-haiku-4-5`];

    expect(fastFor(`claude-opus-5`, { pinned })).toBe(`claude-haiku-4-5`);
});

test("falls back to Auto when no pin survives, rather than to no downgrade at all", () => {
    expect(fastFor(`claude-opus-5`, { pinned: [`nonsense`, `gemini:gemini-3-flash`] })).toBe(`claude-haiku-4-5-20251001`);
});
