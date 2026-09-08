import { expect, test } from "vitest";
import { judgeAnswer } from "./command-judge.js";
import { readRoleAnswer, UnusableAnswerError } from "../models/role-answer.js";

// Routed through readRoleAnswer, not judgeAnswer.read directly: the contract is the pair, an unwrapped value and the
// usability check over it.
const verdict = (reply: string) => readRoleAnswer(judgeAnswer, reply).verdict;

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

// Each of these is a right answer in wrong packaging, worth a rung to strip; refusing it would re-ask a correct
// verdict.
test("survives the wrappers a model adds on its own", () => {
    expect(verdict("```\nDECISION: allow\nWHY: Lists the directory.\n```")).toMatchObject({ decision: `allow`, sentence: `Lists the directory.` });
    expect(verdict(`decision: ALLOW\nwhy: "Lists the directory."`)).toMatchObject({ decision: `allow`, sentence: `Lists the directory.` });
    // A model that qualifies the word has still answered; holding that against it spends a rung on punctuation.
    expect(verdict(`DECISION: ask (the owner)\nWHY: Force-pushes to origin.`)).toMatchObject({ decision: `ask` });
});

// An unreadable reply is never permission: defaulting to allow would make garbling the reply an attack, since a garbled
// reply is what a confused or coerced model produces.
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

// A paragraph is not a sentence; past this length the reply reads as a forbidden stage-by-stage walkthrough rather than
// a verdict's reason.
test("a walkthrough where a sentence was asked for is unusable", () => {
    expect(() => verdict(`DECISION: ask\nWHY: ${`word `.repeat(60)}`)).toThrow(UnusableAnswerError);
});

// A provider's own quota or limit message must never read as a verdict; role-answer.ts catches it ahead of this
// contract.
test("a provider's refusal is a refusal, not a ruling", () => {
    expect(() => verdict(`You have exceeded your current quota.`)).toThrow();
});
