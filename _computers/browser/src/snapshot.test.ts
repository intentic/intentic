import { expect, test } from "vitest";
import { browserCandidates } from "./launch.js";
import { refIndex, renderPage, SNAPSHOT_SCRIPT, toPageState } from "./snapshot.js";

/* The parts of browser control that can be tested without a browser: how a page is rendered for the agent, how
 * references are read back, and which binaries would be looked for. The CDP calls themselves end in a real
 * Chrome painting a real page: those need a machine, not a test. */

test("a page renders as its identity and then things to act on", () => {
    const rendered = renderPage({
        url: "https://mail.example.com/inbox",
        title: "Inbox (3)",
        elements: [
            { ref: "e0", role: "link", name: "Compose" },
            { ref: "e1", role: "textbox", name: "Search mail", value: "invoice" },
            { ref: "e2", role: "button", name: "Send" },
        ],
    });
    expect(rendered).toContain("Page: Inbox (3)");
    expect(rendered).toContain("https://mail.example.com/inbox");
    expect(rendered).toContain(`[e0] link "Compose"`);
    // What a field HOLDS matters as much as what it is called: it is how the agent knows a form is already
    // filled, or filled with the wrong thing.
    expect(rendered).toContain(`[e1] textbox "Search mail" = "invoice"`);
});

test("a page with nothing to act on says so instead of listing nothing", () => {
    const rendered = renderPage({ url: "https://example.com/report.pdf", title: "Report", elements: [] });
    expect(rendered).toMatch(/Nothing on this page can be clicked/);
    expect(rendered).toContain("read");
});

test("an untitled page still names itself", () => {
    expect(renderPage({ url: "about:blank", title: "", elements: [] })).toContain("(untitled)");
});

// Truncation must be visible: a list that silently stops at 150 reads as "that is everything on the page".
test("a truncated list says it was truncated", () => {
    const many = Array.from({ length: 3 }, (_unused, index) => ({ ref: `e${index}`, role: "link", name: `link ${index}` }));
    expect(renderPage({ url: "u", title: "t", elements: many }, true)).toMatch(/only the first \d+ are listed/);
    expect(renderPage({ url: "u", title: "t", elements: many }, false)).not.toMatch(/only the first/);
});

test("references are read back, and anything that is not one of ours is refused", () => {
    expect(refIndex("e0")).toBe(0);
    expect(refIndex("e42")).toBe(42);
    expect(refIndex("  e7 ")).toBe(7);
    // A model improvising a CSS selector should get a refusal, not a silent no-op against element 0.
    expect(refIndex("button.submit")).toBe(-1);
    expect(refIndex("#send")).toBe(-1);
    expect(refIndex("")).toBe(-1);
});

test("a missing snapshot answers as an empty page rather than throwing", () => {
    expect(toPageState({})).toEqual({ url: "", title: "", elements: [] });
    expect(toPageState({ url: "u", title: "t" }).elements).toEqual([]);
});

/* The injected script runs inside somebody's page, where a syntax error is invisible until it happens on a site
 * nobody tested. Parsing it here is the cheapest guard available without a browser. */
test("the injected script is syntactically valid javascript", () => {
    expect(() => new Function(`return ${SNAPSHOT_SCRIPT}`)).not.toThrow();
});

test("the injected script avoids the template literals it is embedded in", () => {
    // Nesting template literals inside this one is how this file would acquire a bug that only appears at
    // runtime, so the script is written without them on purpose.
    expect(SNAPSHOT_SCRIPT).not.toContain("`");
});

test("a Chromium-family browser is looked for where each platform keeps one", () => {
    const windows = browserCandidates("win32");
    expect(windows.some((path) => path.includes("chrome.exe"))).toBe(true);
    expect(windows.some((path) => path.includes("msedge.exe"))).toBe(true);
    const linux = browserCandidates("linux");
    expect(linux).toContain("/usr/bin/google-chrome");
    expect(linux.some((path) => path.includes("chromium"))).toBe(true);
});
