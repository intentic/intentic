import { expect, test } from "vitest";
import { pushBadge } from "./pushBadge";
import type { PushQuestion, StandingVerdict } from "./usePushFlow";

// What the rail's Workspace tile and the phone's Review tab say about a push, from anywhere in the app.

const QUESTION: PushQuestion = { kind: `checks`, title: `Checks failed`, command: `pnpm check`, detail: `` };
const HELD: StandingVerdict = {
    push: { verb: `Push`, what: `3 commits`, targets: [{ repo: `intentic`, pull: false, push: true }] },
    question: QUESTION,
    runs: [],
    check: { status: `failed`, command: `pnpm check`, output: `2 tests failed`, exitCode: 1 },
    at: 61_000,
};

test(`a run in flight is a glyph, and the count it outranks is not drawn`, () => {
    expect(pushBadge(`checking`, undefined)).toMatchObject({ mark: `wave-pulse` });
    expect(pushBadge(`pushing`, undefined)).toMatchObject({ mark: `arrow-up-right` });
});

test(`a question owed is the danger mark, wherever the user is`, () => {
    expect(pushBadge(undefined, QUESTION)).toMatchObject({ mark: `exclamation-triangle`, tone: `danger` });
});

/* The tile going quiet the moment the card is closed is the app agreeing the failure is over, when the push is still
 * unsent and the tree still fails. Same glyph, one tone down: no longer interrupting, still owed. */
test(`a verdict whose card was closed keeps the mark, in the tone of something no longer interrupting`, () => {
    const badge = pushBadge(undefined, undefined, HELD);
    expect(badge).toMatchObject({ mark: `exclamation-triangle`, tone: `warning` });
    expect(badge?.tooltip).toContain(QUESTION.title);
});

test(`nothing owed and nothing running draws nothing at all`, () => {
    expect(pushBadge(undefined, undefined)).toBeUndefined();
});
