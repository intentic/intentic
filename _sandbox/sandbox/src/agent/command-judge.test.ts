import { expect, test } from "vitest";
import { judgeAnswer } from "./command-judge.js";
import { readQuickAnswer, UnusableAnswerError } from "./quick-answer.js";

/* READING THE JUDGE'S REPLY, which is the one piece of this seam that is pure and the one where being wrong is
 * expensive: an off-shape reply is not a missing sentence, it is a MISSING VERDICT on a command about to run.
 *
 * Driven through `readQuickAnswer` rather than by calling `judgeAnswer.read` directly, because the contract is
 * the pair: a value the unwrapper produced AND the usability check over it. Calling one half would test a
 * function; calling both tests what the chain actually does with a rung's answer. */
const verdict = (reply: string) => readQuickAnswer(judgeAnswer, reply).verdict;

test("reads the three decisions and the sentence", () => {
    expect(verdict(`DECISION: allow\nWHY: Runs the test suite.`)).toEqual({ decision: `allow`, sentence: `Runs the test suite.` });
    expect(verdict(`DECISION: refuse\nWHY: Publishes to npm.`)).toEqual({ decision: `refuse`, sentence: `Publishes to npm.` });
});

test("carries the proposed policy line when the judge offered one", () => {
    expect(verdict(`DECISION: ask\nWHY: Deletes the build directory.\nPOLICY: Deleting build output is fine.`)).toEqual({
        decision: `ask`,
        sentence: `Deletes the build directory.`,
        policyLine: `Deleting build output is fine.`,
    });
});

/* The packaging a model reaches for even when told not to. Each of these is a RIGHT answer wearing the wrong
 * clothes, so stripping it is worth a rung; refusing it would send a correct verdict back to be asked again. */
test("survives the wrappers a model adds on its own", () => {
    expect(verdict("```\nDECISION: allow\nWHY: Lists the directory.\n```")).toMatchObject({ decision: `allow`, sentence: `Lists the directory.` });
    expect(verdict(`decision: ALLOW\nwhy: "Lists the directory."`)).toMatchObject({ decision: `allow`, sentence: `Lists the directory.` });
    // A model that qualifies the word has still answered; holding that against it spends a rung on punctuation.
    expect(verdict(`DECISION: ask (the owner)\nWHY: Force-pushes to origin.`)).toMatchObject({ decision: `ask` });
});

/* AN UNREADABLE REPLY IS NEVER PERMISSION. Each of these costs the rung and the next model down rules; the
 * gate's own fallback covers nothing ruling at all. Defaulting any of them to `allow` would make garbling the
 * reply an attack, and a garbled reply is exactly what a confused or coerced model produces. */
test("a reply with no recognisable decision is unusable, not an allow", () => {
    for (const reply of [
        `I think this is probably fine to run.`,
        `DECISION: maybe\nWHY: Hard to say.`,
        `WHY: Deletes the build directory.`,
        `DECISION:\nWHY: Deletes the build directory.`,
    ]) {
        expect(() => verdict(reply), reply).toThrow(UnusableAnswerError);
    }
});

test("a decision with no sentence is unusable: the sentence is the reason for every verdict", () => {
    expect(() => verdict(`DECISION: ask`)).toThrow(UnusableAnswerError);
});

/* The ceiling past which the reply is the stage-by-stage walkthrough the prompt forbids, or a model answering
 * something else at length. The card gets a couple of seconds of somebody's attention; a paragraph is not a
 * sentence, and storing one leaves a blob where the reason should be. */
test("a walkthrough where a sentence was asked for is unusable", () => {
    expect(() => verdict(`DECISION: ask\nWHY: ${`word `.repeat(60)}`)).toThrow(UnusableAnswerError);
});

/* A PROVIDER'S OWN LIMIT SENTENCE MUST NEVER READ AS A VERDICT. It arrives as the reply text on some providers
 * rather than as an error, and on a safety card it would land in the exact spot a person looks to find out what
 * they are approving. The seam catches it ahead of this contract (quick-answer.ts), and this is the assertion
 * that says the judge inherits that rather than having to know about it. */
test("a provider's refusal is a refusal, not a ruling", () => {
    expect(() => verdict(`You have exceeded your current quota.`)).toThrow();
});
