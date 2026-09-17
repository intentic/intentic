import { describe, expect, test } from "vitest";
import { toUrl } from "./address";

// The address bar is the client's own now, so what a typed line becomes is decided here, not by an omnibox.
describe("toUrl", () => {
    test("an address with a scheme is taken as written", () => {
        expect(toUrl(`https://example.com/a?b=1`)).toBe(`https://example.com/a?b=1`);
        expect(toUrl(`about:blank`)).toBe(`about:blank`);
        expect(toUrl(`data:text/html,<p>hi</p>`)).toBe(`data:text/html,<p>hi</p>`);
        expect(toUrl(`  http://x.test  `)).toBe(`http://x.test`);
    });

    test("a host is asked over https, a local one over http", () => {
        expect(toUrl(`example.com`)).toBe(`https://example.com`);
        expect(toUrl(`docs.example.com/guide#top`)).toBe(`https://docs.example.com/guide#top`);
        expect(toUrl(`localhost:5173/app`)).toBe(`http://localhost:5173/app`);
        expect(toUrl(`10.0.0.2:8080`)).toBe(`http://10.0.0.2:8080`);
    });

    test("anything else is a search, spaces included", () => {
        expect(toUrl(`how to center a div`)).toBe(`https://duckduckgo.com/?q=how%20to%20center%20a%20div`);
        // Host-like first word, but a sentence: a search, not an address.
        expect(toUrl(`example.com pricing`)).toBe(`https://duckduckgo.com/?q=example.com%20pricing`);
        expect(toUrl(`intentic`)).toBe(`https://duckduckgo.com/?q=intentic`);
    });

    test("nothing typed goes nowhere", () => {
        expect(toUrl(`   `)).toBeUndefined();
    });
});
