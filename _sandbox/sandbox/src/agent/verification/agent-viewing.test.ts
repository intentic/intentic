import { describe, expect, test } from "vitest";
import { createViewLedger, isObservingCall, isSurfacePath, verifyUiEditsMessage } from "./agent-viewing.js";

// Two judgements this ledger rests on: a regex over tool names that arrive under a different prefix per MCP server, and
// whether a whole model turn gets spent.

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

    // An allowlist, the opposite of the proof ledger's stance on prose: a spurious nudge costs a whole model turn and a
    // browser session, so an unrecognised file like `.ts` is let through rather than flagged.
    test.each(["src/parser.ts", "README.md", "package.json", "main.rs", "styles.txt"])("%s is not", (path) => {
        expect(isSurfacePath(path)).toBe(false);
    });
});

describe("the verdict", () => {
    test("says nothing when no surface was touched", () => {
        const ledger = createViewLedger();
        ledger.noteEdit("src/parser.ts");
        expect(verifyUiEditsMessage(ledger)).toBeUndefined();
    });

    test("says nothing when a look followed the last surface edit", () => {
        const ledger = createViewLedger();
        ledger.noteEdit("src/App.vue");
        ledger.noteLook("mcp__web__browser_navigate");
        expect(verifyUiEditsMessage(ledger)).toBeUndefined();
    });

    // ORDER, the same property the proof ledger is built on and for the same reason.
    test("asks when the only look came before the last surface edit", () => {
        const ledger = createViewLedger();
        ledger.noteLook("mcp__web__browser_navigate");
        ledger.noteEdit("src/App.vue");
        const message = verifyUiEditsMessage(ledger) ?? "";
        expect(message).toContain("src/App.vue");
        expect(verifyUiEditsMessage(createViewLedger())).toBeUndefined();
    });

    test("names the surfaces, and counts the ones it does not name", () => {
        const ledger = createViewLedger();
        for (let i = 0; i < 10; i += 1) {
            ledger.noteEdit(`src/C${i}.vue`);
        }
        const message = verifyUiEditsMessage(ledger);
        expect(message).toContain("src/C0.vue");
        expect(message).toContain(`... and ${10 - 8} more`);
    });

    // The ask is for a comparison against a stated expectation, not just a glance: looking alone is not the scarce
    // thing.
    test("asks for the expectation before the observation", () => {
        const ledger = createViewLedger();
        ledger.noteEdit("src/App.vue");
        const message = verifyUiEditsMessage(ledger) ?? "";
        const withoutLook = verifyUiEditsMessage(createViewLedger()) ?? "";
        expect(message).not.toBe(withoutLook);
        expect(message).toContain("src/App.vue");
    });

    // No URL is invented: the daemon doesn't know how this workspace serves the view, and a wrong port would read as a
    // found bug.
    test("names no address", () => {
        const ledger = createViewLedger();
        ledger.noteEdit("src/App.vue");
        expect(verifyUiEditsMessage(ledger)).not.toMatch(/localhost:\d+/);
    });

    // The same file edited five times is one surface to name.
    test("dedupes", () => {
        const ledger = createViewLedger();
        ledger.noteEdit("src/App.vue");
        ledger.noteEdit("src/App.vue");
        expect(createViewLedger().edited()).toEqual([]);
        expect(ledger.edited()).toEqual(["src/App.vue"]);
    });
});
