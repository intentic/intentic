import { expect, test } from "vitest";
import { fastTierModel } from "./fast-tier.js";

// Whether a downgraded turn has anywhere cheaper to land on its current provider; a downgrade must be a genuinely
// cheaper rung of the same catalog and never cross provider, since that retires the session.

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
    // undefined means run the original pick: the safe default when nothing is cheaper.
    expect(fastFor(`claude-haiku-4-5-20251001`)).toBeUndefined();
});

test("never swaps a model for an older build of the same tier", () => {
    expect(fastFor(`claude-sonnet-5`, { models: [`claude-sonnet-5`, `claude-sonnet-4`] })).toBeUndefined();
});

test("never downgrades a model whose family this build does not recognise", () => {
    // An id with no tier word is either the provider's own baseline or an unrecognised family.
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
    // Takes a pinned id verbatim: second-guessing it would run a different model than the settings row names.
    expect(fastFor(`claude-opus-5`, { pinned: [`claude:claude-haiku-9`] })).toBe(`claude-haiku-9`);
});

test("drops a pin naming another provider rather than crossing to it", () => {
    // Crossing provider retires the session (turnRequest.ts's resumes); the pin is ignored instead.
    expect(fastFor(`claude-opus-5`, { pinned: [`gemini:gemini-3-flash-lite`] })).toBe(`claude-haiku-4-5-20251001`);
});

test("skips a pin that is not actually cheaper than what the user picked", () => {
    // A pin picks which cheap rung, never licence to swap to an equal or better model.
    expect(fastFor(`claude-sonnet-5`, { pinned: [`claude:claude-opus-5`] })).toBe(`claude-haiku-4-5-20251001`);
});

test("walks past an unusable pin to the next one that names this provider", () => {
    const pinned = [`gemini:gemini-3-flash`, `claude:claude-opus-5`, `claude:claude-haiku-4-5`];

    expect(fastFor(`claude-opus-5`, { pinned })).toBe(`claude-haiku-4-5`);
});

test("falls back to Auto when no pin survives, rather than to no downgrade at all", () => {
    expect(fastFor(`claude-opus-5`, { pinned: [`nonsense`, `gemini:gemini-3-flash`] })).toBe(`claude-haiku-4-5-20251001`);
});
