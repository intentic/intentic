import { createViewLedger, isObservingCall, isSurfacePath } from "./agent-viewing.js";

// Two judgements this ledger rests on: a regex over tool names that arrive under a different prefix per MCP server, and
// which rendered files the conversation's card records as changed without a look (AgentSummary.proof).

describe("what counts as looking", () => {
    // The same tool arrives under a different prefix per server, or bare on a runtime that flattens MCP names; the
    // prefix is a deployment detail, not a fact about the call.
    test.each([
        "mcp__web__browser_navigate",
        "mcp__browser__browser_take_screenshot",
        "mcp__radarsu-omen__browser_snapshot",
        "browser_evaluate",
        "mcp__web__browser_console_messages",
        "mcp__web__browser_find",
    ])("%s observes the page", (name) => {
        expect(isObservingCall(name)).toBe(true);
    });

    // Opening or closing a browser is not looking at anything; a gate any browser call could clear would be cleared by
    // the very turn it exists to catch.
    test.each(["mcp__web__browser_close", "mcp__web__browser_resize", "mcp__web__browser_press_key", "mcp__web__browser_tabs"])(
        "%s does not",
        (name) => {
            expect(isObservingCall(name)).toBe(false);
        },
    );

    test.each(["Read", "Bash", "Edit", "mcp__web__fetch", "WebFetch"])("%s is not a browser call at all", (name) => {
        expect(isObservingCall(name)).toBe(false);
    });
});

describe("what counts as a rendered surface", () => {
    test.each(["src/App.vue", "a/b/theme.css", "site/index.astro", "x.scss", "Card.tsx", "page.html"])("%s is one", (path) => {
        expect(isSurfacePath(path)).toBe(true);
    });

    // An allowlist, the opposite of the proof ledger's stance on prose: the card must never badge a file nobody could
    // render, so an unrecognised file like `.ts` is let through rather than flagged.
    test.each(["src/parser.ts", "README.md", "package.json", "main.rs", "styles.txt"])("%s is not", (path) => {
        expect(isSurfacePath(path)).toBe(false);
    });
});

describe("the verdict", () => {
    test("says nothing when no surface was touched", () => {
        const ledger = createViewLedger();
        ledger.noteEdit("src/parser.ts");
        expect(ledger.verdict()).toBeUndefined();
    });

    test("says nothing when a look followed the last surface edit", () => {
        const ledger = createViewLedger();
        ledger.noteEdit("src/App.vue");
        ledger.noteLook("mcp__web__browser_navigate");
        expect(ledger.verdict()).toBeUndefined();
    });

    // ORDER, the same property the proof ledger is built on and for the same reason.
    test("names the surface when the only look came before the last surface edit", () => {
        const ledger = createViewLedger();
        ledger.noteLook("mcp__web__browser_navigate");
        ledger.noteEdit("src/App.vue");
        expect(ledger.verdict()).toEqual({ paths: ["src/App.vue"] });
        expect(createViewLedger().verdict()).toBeUndefined();
    });

    // Every one of them, not a listing's first few: the card records how many went unlooked at.
    test("names every unviewed surface, in the order they were edited", () => {
        const ledger = createViewLedger();
        for (let i = 0; i < 10; i += 1) {
            ledger.noteEdit(`src/C${i}.vue`);
        }
        expect(ledger.verdict()?.paths).toEqual(Array.from({ length: 10 }, (_, i) => `src/C${i}.vue`));
    });

    // The same file edited five times is one surface to name.
    test("dedupes", () => {
        const ledger = createViewLedger();
        ledger.noteEdit("src/App.vue");
        ledger.noteEdit("src/App.vue");
        expect(createViewLedger().edited()).toEqual([]);
        expect(ledger.edited()).toEqual(["src/App.vue"]);
        expect(ledger.verdict()).toEqual({ paths: ["src/App.vue"] });
    });
});
