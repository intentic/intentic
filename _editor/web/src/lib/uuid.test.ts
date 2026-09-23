import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { uuid } from "./uuid";

/* The reason this file exists is one line of the platform's small print: `crypto.randomUUID` is a secure-context api, so it is missing on plain http. */

const V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

afterEach(() => {
    unstubAllGlobals();
});

it(`uses the platform's generator where the context is secure enough to have one`, () => {
    const randomUUID = jest.fn(() => `f81d4fae-7dec-41d0-a765-00a0c91e6bf6`);
    stubGlobal(`crypto`, { ...globalThis.crypto, randomUUID });

    expect(uuid()).toBe(`f81d4fae-7dec-41d0-a765-00a0c91e6bf6`);
    expect(randomUUID).toHaveBeenCalledTimes(1);
});

it(`still answers with a v4 uuid on plain http, where that generator is simply absent`, () => {
    // Exactly what a browser hands an insecure page: getRandomValues, and nothing else off `Crypto`.
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    stubGlobal(`crypto`, { getRandomValues });

    const ids = Array.from({ length: 200 }, () => uuid());
    for (const id of ids) {
        expect(id).toMatch(V4);
    }
    // Same entropy source as the real thing, so the ids are ids: distinctness is the only property a caller
    // (a conversation id, a window's claim, an attachment path) actually leans on.
    expect(new Set(ids).size).toBe(ids.length);
});
