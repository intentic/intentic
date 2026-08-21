import { afterEach, expect, it, vi } from "vitest";
import { uuid } from "./uuid";

/* The reason this file exists is one line of the platform's small print: `crypto.randomUUID` is a secure-context
 * api, so it is missing on plain http, which is where a self-hosted instance on a home network is served from.
 * Every id in the app comes through here, so "it throws there" is "the app does nothing there", and the way it
 * surfaced was a floating window that booted, crashed in its route's setup, wiped this origin's stored state and
 * came back empty. The tests below are the two contexts, told apart by nothing else. */

const V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

afterEach(() => {
    vi.unstubAllGlobals();
});

it(`uses the platform's generator where the context is secure enough to have one`, () => {
    const randomUUID = vi.fn(() => `f81d4fae-7dec-41d0-a765-00a0c91e6bf6`);
    vi.stubGlobal(`crypto`, { ...globalThis.crypto, randomUUID });

    expect(uuid()).toBe(`f81d4fae-7dec-41d0-a765-00a0c91e6bf6`);
    expect(randomUUID).toHaveBeenCalledOnce();
});

it(`still answers with a v4 uuid on plain http, where that generator is simply absent`, () => {
    // Exactly what a browser hands an insecure page: getRandomValues, and nothing else off `Crypto`.
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal(`crypto`, { getRandomValues });

    const ids = Array.from({ length: 200 }, () => uuid());
    for (const id of ids) {
        expect(id).toMatch(V4);
    }
    // Same entropy source as the real thing, so the ids are ids: distinctness is the only property a caller
    // (a conversation id, a window's claim, an attachment path) actually leans on.
    expect(new Set(ids).size).toBe(ids.length);
});
