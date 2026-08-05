import type { Browser, PageState } from "@intentic/browser";
import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ScopeError } from "../policy.js";
import { clickElement, fillElement, listTabs, openPage, readPage, snapshotPage } from "./browser.js";

/* Browser control at the layer that decides what is allowed and what comes back.
 *
 * The scope split is the same rule the rest of the tools follow, and worth pinning here too: reading a page is
 * LOOKING (screen), clicking and typing CHANGE things (control), and opening may start a browser process
 * (shell). The other half worth pinning is that every action answers with the page AFTER it — which is what
 * makes a sequence of calls one step each instead of three. */

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({ shell: "on", write: "on", screen: "on", control: "on", sandboxes: "on", ...overrides });

const page = (overrides: Partial<PageState> = {}): PageState => ({
    url: "https://example.com/",
    title: "Example",
    elements: [{ ref: "e0", role: "button", name: "Send" }],
    ...overrides,
});

const fakeBrowser = () => {
    const calls: string[] = [];
    let current = page();
    const web: Browser = {
        open: async (url) => {
            calls.push(`open ${url ?? ""}`);
            current = page({ url: url ?? current.url });
            return current;
        },
        snapshot: async () => current,
        click: async (ref) => void calls.push(`click ${ref}`),
        fill: async (ref, text, submit) => void calls.push(`fill ${ref} ${text}${submit === true ? " submit" : ""}`),
        press: async (combo) => void calls.push(`press ${combo}`),
        text: async () => "The readable text of the page.",
        screenshot: async () => Buffer.alloc(0),
        tabs: async () => [
            { id: "T1", title: "Example", url: "https://example.com/", active: true },
            { id: "T2", title: "Docs", url: "https://docs.example.com/", active: false },
        ],
        selectTab: async (id) => {
            calls.push(`select ${id}`);
            return current;
        },
        disconnect: async () => void calls.push("disconnect"),
    };
    return { web, calls };
};

test("opening a page may start a browser, so it rides the shell grant", async () => {
    const { web, calls } = fakeBrowser();
    await expect(openPage(web, "example.com", scopes({ shell: "off" }))).rejects.toThrow(/Run commands/);
    expect(calls).toEqual([]);
    await openPage(web, "example.com", scopes());
    // A bare host is what people type; refusing over a missing scheme would be pedantry rather than safety.
    expect(calls).toEqual(["open https://example.com"]);
});

test("a URL that already has a scheme is left alone", async () => {
    const { web, calls } = fakeBrowser();
    await openPage(web, "http://localhost:3000/admin", scopes());
    expect(calls).toEqual(["open http://localhost:3000/admin"]);
});

test("reading a page is looking, so it needs the screen grant", async () => {
    const { web } = fakeBrowser();
    await expect(snapshotPage(web, scopes({ screen: "off" }))).rejects.toThrow(ScopeError);
    await expect(readPage(web, scopes({ screen: "off" }))).rejects.toThrow(ScopeError);
    expect(await readPage(web, scopes())).toContain("readable text");
});

test("acting on a page needs the control grant, not the screen one", async () => {
    const { web, calls } = fakeBrowser();
    await expect(clickElement(web, "e0", scopes({ control: "off" }))).rejects.toThrow(/mouse and keyboard/);
    expect(calls).toEqual([]);
    await clickElement(web, "e0", scopes({ screen: "off" }));
    expect(calls).toEqual(["click e0"]);
});

/* The page after a click is a different page. Answering with it is what stops the agent either forgetting to
 * look or spending a whole round trip finding out what its own action did. */
test("every action answers with the page as it stands afterwards", async () => {
    const { web } = fakeBrowser();
    const clicked = await clickElement(web, "e0", scopes());
    expect(clicked).toContain("Clicked e0");
    expect(clicked).toContain("Page: Example");
    expect(clicked).toContain("[e0] button");
});

// A password typed into a login form is a password; it is counted, never echoed back into the transcript.
test("filling reports a length, never the text", async () => {
    const { web } = fakeBrowser();
    const said = await fillElement(web, "e0", "hunter2", false, scopes());
    expect(said).toContain("7 characters");
    expect(said).not.toContain("hunter2");
});

test("submitting is stated, because it is the step that sends the form", async () => {
    const { web, calls } = fakeBrowser();
    const said = await fillElement(web, "e0", "invoice", true, scopes());
    expect(calls).toEqual(["fill e0 invoice submit"]);
    expect(said).toContain("and submitted");
});

test("acting without a reference says where references come from", async () => {
    const { web } = fakeBrowser();
    await expect(clickElement(web, "", scopes())).rejects.toThrow(/take a snapshot/);
    await expect(fillElement(web, "", "text", false, scopes())).rejects.toThrow(/\[e…\]/);
});

test("the tab list marks the one the tools are acting on", async () => {
    const { web } = fakeBrowser();
    const listed = await listTabs(web, scopes());
    expect(listed).toContain("[T1] Example");
    expect(listed).toContain("[T2] Docs");
    expect(
        listed
            .split("\n")
            .find((line) => line.includes("[T1]"))
            ?.startsWith("*"),
    ).toBe(true);
});
