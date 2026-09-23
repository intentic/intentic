import { describe, it, expect } from "bun:test";
import { orRefusal, refusalText, SandboxHttpError, wordsOf } from "./sandboxHttpError";

// A refusal is an answer the daemon gave, and some callers draw it; a failure to get any answer is not one, and must
// never be drawn as one.

describe(`orRefusal`, () => {
    it(`hands back the answer when there is one`, async () => {
        expect(await orRefusal(Promise.resolve({ ok: true }))).toEqual({ ok: true });
    });

    it(`hands back the daemon's refusal as a value to branch on`, async () => {
        const refused = new SandboxHttpError(409, `This agent is running a turn.`);
        expect(await orRefusal(Promise.reject(refused))).toBe(refused);
    });

    it(`still throws a call that never got an answer`, async () => {
        const dropped = new TypeError(`Failed to fetch`);
        await expect(orRefusal(Promise.reject(dropped))).rejects.toBe(dropped);
    });
});

describe(`how a refusal reads`, () => {
    it(`takes the daemon's message first, a hand-written route's error next, and the bare status last`, () => {
        expect(refusalText(409, { message: `busy`, error: `conflict` })).toBe(`busy`);
        expect(refusalText(403, { error: `not a member` })).toBe(`not a member`);
        expect(refusalText(502, {})).toBe(`Request failed (502).`);
    });

    it(`keeps a body's own words field by field, and nothing that is not words`, () => {
        expect(wordsOf({ message: `busy`, error: `conflict`, code: `CONFLICT` })).toEqual({ message: `busy`, error: `conflict` });
        expect(wordsOf({ message: 42, error: `not a member` })).toEqual({ error: `not a member` });
        expect(wordsOf(`<html>bad gateway</html>`)).toEqual({});
        expect(wordsOf(undefined)).toEqual({});
    });

    it(`carries the words beside its message, empty when the caller gave none`, () => {
        expect(new SandboxHttpError(403, `not a member`, { error: `not a member` }).said).toEqual({ error: `not a member` });
        expect(new SandboxHttpError(502, `Request failed (502).`).said).toEqual({});
    });
});
