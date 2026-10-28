import { type FakeBrowser, installBrowser, PERSON_TAB } from "./browser-testing.js";
import { handleMcpMessage } from "./mcp.js";
import { store } from "./store.js";

// One extension, several sandboxes (2026-10-28). Until then the extension held one sandbox, and pairing a second
// replaced the first. Each paired sandbox now has its own token, its own switches, its own agent window and its own
// request, while the sites the person allows, pause and settings stay the browser's.

const FIRST = "https://sandbox-1.example.dev";
const SECOND = "https://sandbox-2.example.dev";
const ON = { read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "sensitive" } as const;

let browser: FakeBrowser;

const call = async (from: string, name: string, args: Record<string, string | number | boolean> = {}): Promise<{ text: string; isError: boolean }> => {
    // SAFETY: a tools/call is always answered with a result envelope (peer-mcp-server.ts), a failure as isError.
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, from)) as {
        result: { content: { text: string }[]; isError: boolean };
    };
    return { text: answer.result.content[0]?.text ?? "", isError: answer.result.isError };
};

beforeEach(async () => {
    browser = installBrowser();
    await store.addSandbox({ url: FIRST, token: "t1", name: "intentic" });
    await store.addSandbox({ url: SECOND, token: "t2", name: "marketing" });
    await store.setScopes(FIRST, ON);
    await store.setScopes(SECOND, ON);
    await store.setMode("https://app.example/*", "act");
});

test("a build that kept one sandbox has it moved into the list with its switches, and pairing more keeps it", async () => {
    browser = installBrowser();
    await chrome.storage.local.set({
        sandbox: { url: FIRST, token: "t1" },
        scopes: { ...ON, act: "off" },
        pending: { origin: "https://app.example/*", reason: "", at: 1 },
    });
    await store.migrate();
    expect(await store.sandboxes()).toEqual([{ url: FIRST, token: "t1" }]);
    expect((await store.scopes(FIRST)).act).toBe("off");
    expect(await chrome.storage.local.get(["sandbox", "scopes", "pending"])).toEqual({});

    // Running it again changes nothing, and a second sandbox is added beside the first rather than over it.
    await store.migrate();
    await store.addSandbox({ url: `${SECOND}/`, token: "t2" });
    expect((await store.sandboxes()).map((sandbox) => sandbox.url)).toEqual([FIRST, `${SECOND}/`]);
});

test("pairing a sandbox again renews its token in its place, and forgetting one leaves the other", async () => {
    await store.addSandbox({ url: `${FIRST}/`, token: "fresh", name: "intentic" });
    expect((await store.sandboxes()).map((sandbox) => [sandbox.url, sandbox.token])).toEqual([
        [`${FIRST}/`, "fresh"],
        [SECOND, "t2"],
    ]);
    await store.setPending(FIRST, { origin: "https://github.com/*", reason: "", at: 1 });
    await store.forgetSandbox(FIRST);
    expect((await store.sandboxes()).map((sandbox) => sandbox.url)).toEqual([SECOND]);
    expect(await store.pending()).toEqual([]);
    expect((await store.scopes(SECOND)).act).toBe("on");
});

test("each sandbox's switches hold for its own agent only, on the same allowed site", async () => {
    await store.setScopes(SECOND, { ...ON, act: "off" });
    expect((await call(FIRST, "open", { url: "app.example/one" })).isError).toBe(false);
    const refused = await call(SECOND, "open", { url: "app.example/two" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`"Click and type" is switched off`);
});

// The live failure this split prevents: both agents on one window's front tab, each pointing it somewhere else.
test("each sandbox's agent opens its own window and works in it, never in the other's", async () => {
    await call(FIRST, "open", { url: "app.example/invoices" });
    await call(SECOND, "open", { url: "app.example/campaigns" });
    const windows = await store.agentWindows();
    expect(Object.keys(windows).toSorted()).toEqual([FIRST, SECOND]);
    expect(windows[FIRST]).not.toBe(windows[SECOND]);
    const front = (id: number | undefined) => browser.tabs.find((tab) => tab.windowId === id && tab.active)?.url;
    expect(front(windows[FIRST])).toBe("https://app.example/invoices");
    expect(front(windows[SECOND])).toBe("https://app.example/campaigns");

    // The other agent's tabs are listed as its own, apart from the person's, and are not this agent's to select.
    const listed = await call(FIRST, "tabs");
    expect(listed.text).toContain("Another sandbox's agent works in these");
    const theirs = browser.tabs.find((tab) => tab.windowId === windows[SECOND]);
    expect((await call(FIRST, "tabs", { select: theirs?.id ?? 0 })).text).toContain("another sandbox's agent window");
    expect(browser.tabs.find((tab) => tab.id === PERSON_TAB)?.active).toBe(true);
});

test("another paired sandbox's own app is no site to work on, whatever the browser holds", async () => {
    await store.setMode(`${SECOND}/*`, "act");
    const opened = await call(FIRST, "open", { url: `${SECOND}/conversations` });
    expect(opened.text).toContain("another of the person's sandboxes");
    const described = await call(FIRST, "describe");
    expect(described.text).not.toContain("sandbox-2.example.dev");
});

test("two agents asking for sites keep a request each, and the activity list says whose call was whose", async () => {
    await call(FIRST, "ask_access", { origin: "github.com", reason: "To read the alert." });
    await call(SECOND, "ask_access", { origin: "x.com", reason: "To draft the post." });
    await call(FIRST, "ask_access", { origin: "gitlab.com", reason: "Actually the pipeline." });
    expect((await store.pending()).map((request) => [request.sandbox, request.origin])).toEqual([
        [SECOND, "https://x.com/*"],
        [FIRST, "https://gitlab.com/*"],
    ]);
    expect((await store.log()).map((entry) => entry.sandbox)).toEqual([FIRST, SECOND, FIRST]);
});
