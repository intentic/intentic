import { describe, expect, it } from "vitest";
import { sessionIdFrom } from "./sessionRef";

const ID = `a8b5f00f-cf24-40d4-aaea-525d2a5086f0`;
// What a workflow calls its steps' sessions: proof that ids are opaque, and the case the uuid shape misses.
const STEP = `wf-a3f19c22-review-perf`;

describe(`sessionIdFrom`, () => {
    it(`reads the four costumes one session id is copied in`, () => {
        expect(sessionIdFrom(ID)).toBe(ID);
        expect(sessionIdFrom(`agent/${ID}`)).toBe(ID);
        expect(sessionIdFrom(`https://sandbox.example.com/agents/${ID}`)).toBe(ID);
        expect(sessionIdFrom(`/history/worktrees/${ID}`)).toBe(ID);
    });

    it(`forgives what a paste picks up on the way`, () => {
        expect(sessionIdFrom(`  ${ID}  `)).toBe(ID);
        expect(sessionIdFrom(`https://sandbox.example.com/agents/${ID}/`)).toBe(ID);
        expect(sessionIdFrom(ID.toUpperCase())).toBe(ID);
    });

    /* An id is whatever minted it. A workflow's step sessions are named, not uuids, so the costume has to be
     * what carries them: a shape check alone would take the branch chip's own value and refuse it. */
    it(`carries an id that is not a uuid, on the strength of its costume`, () => {
        expect(sessionIdFrom(`agent/${STEP}`)).toBe(STEP);
        expect(sessionIdFrom(`https://sandbox.example.com/agents/${STEP}`)).toBe(STEP);
        expect(sessionIdFrom(`/history/worktrees/${STEP}`)).toBe(STEP);
    });

    // Bare and unshapely: only the roster can vouch for it, and the identity panel offers exactly this string.
    it(`takes a bare non-uuid id only when the roster knows it`, () => {
        expect(sessionIdFrom(STEP)).toBeUndefined();
        expect(sessionIdFrom(STEP, (id) => id === STEP)).toBe(STEP);
        expect(sessionIdFrom(`README.md`, (id) => id === STEP)).toBeUndefined();
    });

    /* The strictness that keeps Quick Open a file palette. Every one of these is something a person types while
     * looking for a file, and the middle two are the traps: a folder called `agents`, and a path that happens
     * to end in a uuid. */
    it(`leaves an ordinary file search alone`, () => {
        expect(sessionIdFrom(`AgentCard.vue`)).toBeUndefined();
        expect(sessionIdFrom(`src/agents/AgentCard.vue`)).toBeUndefined();
        expect(sessionIdFrom(`/work/intentic/_editor/web/src/agents/AgentCard.vue`)).toBeUndefined();
        expect(sessionIdFrom(`src/fixtures/${ID}.json`)).toBeUndefined();
        expect(sessionIdFrom(`${ID} what did this one do?`)).toBeUndefined();
        expect(sessionIdFrom(`agent/`)).toBeUndefined();
        expect(sessionIdFrom(`a8b5f00f`)).toBeUndefined();
    });
});
