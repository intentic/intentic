import { pushBadge } from "./pushBadge";
import type { PushQuestion, StandingVerdict } from "./usePushFlow";

// What the rail's Workspace tile and the phone's Review tab say about a push, from anywhere in the app.

const QUESTION: PushQuestion = { title: `Push failed`, command: `git push origin main`, detail: `was refused by this repository's pre-push hook.` };
const HELD: StandingVerdict = {
    push: { verb: `Push`, what: `3 commits`, targets: [{ repo: `intentic`, pull: false, push: true }] },
    question: QUESTION,
    runs: [{ status: `failed`, repo: `intentic`, command: `git push origin main`, output: `2 tests failed`, exitCode: 1, refusedBy: `hook` }],
    at: 61_000,
    mark: 3,
};

test(`a push in flight is a glyph, and the count it outranks is not drawn`, () => {
    expect(pushBadge(true, undefined)).toMatchObject({ mark: `arrow-up-right` });
});

test(`a question owed is the danger mark, wherever the user is`, () => {
    expect(pushBadge(false, QUESTION)).toMatchObject({ mark: `exclamation-triangle`, tone: `danger` });
});

/* The tile going quiet the moment the card is closed is the app agreeing the failure is over, when the push is still unsent and the tree still fails. */
test(`a verdict whose card was closed keeps the mark, in the tone of something no longer interrupting`, () => {
    const badge = pushBadge(false, undefined, HELD);
    expect(badge).toMatchObject({ mark: `exclamation-triangle`, tone: `warning` });
    expect(badge?.tooltip).toContain(QUESTION.title);
});

test(`nothing owed and nothing running draws nothing at all`, () => {
    expect(pushBadge(false, undefined)).toBeUndefined();
});
