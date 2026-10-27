import type { QueryRequest } from "../types.js";
import { phraseWantsMeaning } from "./hints.js";

// When a `find` that matched nothing is answered by meaning instead: for the CLI's phrase, never for a search box.

const request = (query: string, overrides: Partial<QueryRequest> = {}): QueryRequest => ({
    verb: "find",
    query,
    scope: {},
    render: { budget: 2_000 },
    options: {},
    echo: `find "${query}"`,
    ...overrides,
});

test("a phrase asked of the CLI wants meaning; one word, a pattern or --literal does not", () => {
    expect(phraseWantsMeaning(request("where is the session renewed"))).toBe(true);
    expect(phraseWantsMeaning(request("renewSession"))).toBe(false);
    expect(phraseWantsMeaning(request("renew.*session"))).toBe(false);
    expect(phraseWantsMeaning(request("where is the session renewed", { options: { literal: true } }))).toBe(false);
});

test("a list caller (the search box) asked for the text, and never gets an answer by meaning", () => {
    expect(phraseWantsMeaning(request("where is the session renewed", { render: { budget: 2_000, list: { hits: 1_000, files: 300 } } }))).toBe(false);
});
