import { rememberBounds } from "./agent-window.js";
import { type FakeBrowser, injectedInto, installBrowser, moves, PERSON_TAB, PERSON_WINDOW } from "./browser-testing.js";
import { handleMcpMessage } from "./mcp.js";
import { DEFAULT_SETTINGS, store } from "./store.js";
import { screenshot } from "./tools/page.js";

// The agent's own window (agent-window.ts): the person's tab, in front of them, is never pointed somewhere else,
// focused or captured, while the agent opens and works on pages of its own behind it. The live failure: `open` loaded
// a URL into the very tab the person was reading, and every tool given no tab acted on whatever they had in front.

let browser: FakeBrowser;

const call = async (name: string, args: Record<string, string | number | boolean> = {}): Promise<{ text: string; isError: boolean }> => {
    // SAFETY: a tools/call is always answered with a result envelope (peer-mcp-server.ts), a failure as isError.
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, undefined)) as {
        result: { content: { text: string }[]; isError: boolean };
    };
    return { text: answer.result.content[0]?.text ?? "", isError: answer.result.isError };
};

const agentWindowId = async (): Promise<number> => {
    const id = await store.agentWindowId();
    if (id === undefined) {
        throw new Error(`the agent has no window`);
    }
    return id;
};

// The person closes a window, as they would with its X.
const close = (id: number): void => {
    browser.windows.splice(
        browser.windows.findIndex((window) => window.id === id),
        1,
    );
};

// What the person sees: their window in front, focused, on the page they left it on.
const personUndisturbed = (): void => {
    const window = browser.windows.find((each) => each.id === PERSON_WINDOW);
    expect(window?.focused).toBe(true);
    expect(browser.tabs.find((tab) => tab.id === PERSON_TAB)).toMatchObject({ active: true, url: "https://mail.example/inbox" });
    expect(
        moves(browser).filter(([api, id]) => (api === "tabs.update" && id === PERSON_TAB) || (api === "windows.update" && id === PERSON_WINDOW)),
    ).toEqual([]);
};

beforeEach(async () => {
    browser = installBrowser();
    await store.setScopes({ read: "on", act: "on", screenshot: "on", cookies: "off", confirm: "sensitive" });
    await store.setMode("https://app.example/*", "act");
    await store.setMode("https://mail.example/*", "act");
});

test("open puts the page in a window of the agent's own, unfocused, and leaves the person's tab alone", async () => {
    const opened = await call("open", { url: "app.example/invoices" });
    expect(opened.isError).toBe(false);
    expect(opened.text).toContain("a window of your own, behind the person's");
    // Never asked minimized: Brave opens that one normal and focused, on top of theirs.
    expect(browser.calls.filter(([api]) => api === "windows.create")).toEqual([
        ["windows.create", { url: "https://app.example/invoices", focused: false }],
    ]);
    const id = await agentWindowId();
    expect(browser.tabs.filter((tab) => tab.windowId === id).map((tab) => tab.url)).toEqual(["https://app.example/invoices"]);
    personUndisturbed();
});

test("the next open reuses the agent's tab, and a new tab goes beside it in the agent's window", async () => {
    await call("open", { url: "app.example/one" });
    const id = await agentWindowId();
    await call("open", { url: "app.example/two" });
    expect(browser.calls.filter(([api]) => api === "windows.create")).toHaveLength(1);
    expect(browser.tabs.filter((tab) => tab.windowId === id).map((tab) => tab.url)).toEqual(["https://app.example/two"]);

    const fresh = await call("open", { url: "app.example/three", tab: "new" });
    expect(fresh.text).not.toContain("a window of your own");
    expect(browser.calls.filter(([api]) => api === "tabs.create")).toEqual([
        ["tabs.create", { windowId: id, url: "https://app.example/three", active: true }],
    ]);
    expect(browser.tabs.find((tab) => tab.windowId === id && tab.active)?.url).toBe("https://app.example/three");
    personUndisturbed();
});

test("a tool given no tab works on the agent's tab, not on the one in front of the person", async () => {
    await call("open", { url: "app.example/invoices" });
    const id = await agentWindowId();
    const agentTab = browser.tabs.find((tab) => tab.windowId === id)?.id ?? -1;
    browser.injections.length = 0;
    expect((await call("snapshot")).isError).toBe(false);
    expect(injectedInto(browser, "snapshot").map((injection) => injection.tabId)).toEqual([agentTab]);

    // Their own tab, named, is worked on where it is.
    browser.injections.length = 0;
    expect((await call("read", { tab: PERSON_TAB })).isError).toBe(false);
    expect(browser.injections.map((injection) => injection.tabId)).toEqual([PERSON_TAB]);
    personUndisturbed();
});

test("with no window of its own yet, a tool given no tab says how to get one instead of using the person's tab", async () => {
    const result = await call("snapshot");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("`open` one");
    expect(browser.injections).toEqual([]);
});

test("a closed agent window is forgotten, and the next open makes another", async () => {
    await call("open", { url: "app.example/one" });
    const first = await agentWindowId();
    close(first);
    expect((await call("snapshot")).text).toContain("`open` one");
    await call("open", { url: "app.example/two" });
    expect(await agentWindowId()).not.toBe(first);
    personUndisturbed();
});

test("where the person put the window is where the next one opens, unless that screen has gone", async () => {
    await call("open", { url: "app.example/one" });
    const first = await agentWindowId();
    // Dragged to a spare monitor; the person's own window moving says nothing about the agent's.
    await rememberBounds({ id: first, focused: false, state: "normal", left: 2600, top: 40, width: 900, height: 800 });
    await rememberBounds({ id: PERSON_WINDOW, focused: true, state: "normal", left: 5, top: 5, width: 10, height: 10 });
    close(first);
    await call("open", { url: "app.example/two" });
    expect(browser.calls.findLast(([api]) => api === "windows.create")).toEqual([
        "windows.create",
        { url: "https://app.example/two", focused: false, left: 2600, top: 40, width: 900, height: 800 },
    ]);

    // That monitor is unplugged now: Chrome refuses the bounds, and the window opens where Chrome puts it.
    browser.refuseBounds = true;
    close(await agentWindowId());
    const opened = await call("open", { url: "app.example/three" });
    expect(opened.isError).toBe(false);
    expect(browser.calls.findLast(([api]) => api === "windows.create")).toEqual([
        "windows.create",
        { url: "https://app.example/three", focused: false },
    ]);
    expect(await store.agentWindowBounds()).toBeUndefined();
});

test("switching tabs moves among the agent's own, and one of the person's is never brought forward", async () => {
    await call("open", { url: "app.example/one" });
    await call("open", { url: "app.example/two", tab: "new" });
    const id = await agentWindowId();
    const first = browser.tabs.find((tab) => tab.windowId === id && !tab.active)?.id ?? 0;
    expect((await call("tabs", { select: first })).text).toContain(`Switched to tab ${first}`);
    expect(browser.tabs.find((tab) => tab.id === first)?.active).toBe(true);

    const theirs = await call("tabs", { select: PERSON_TAB });
    expect(theirs.text).toContain("one of the person's own tabs");
    personUndisturbed();

    const listed = await call("tabs");
    expect(listed.text).toContain("Your own window, behind the person's");
    expect(listed.text).toContain("The person's tabs");
});

test("working in the person's tab, as they may choose, open and the tools go where they look", async () => {
    await store.setSettings({ ...DEFAULT_SETTINGS, workIn: "front-tab" });
    await call("open", { url: "app.example/invoices" });
    expect(browser.calls.filter(([api]) => api === "windows.create")).toEqual([]);
    expect(browser.calls.filter(([api]) => api === "tabs.update")).toEqual([["tabs.update", PERSON_TAB, { url: "https://app.example/invoices" }]]);
    browser.injections.length = 0;
    await call("snapshot");
    expect(injectedInto(browser, "snapshot").map((injection) => injection.tabId)).toEqual([PERSON_TAB]);
});

test("a screenshot of the agent's minimized window restores it unfocused, and minimizes it again", async () => {
    await call("open", { url: "app.example/chart" });
    const id = await agentWindowId();
    await chrome.windows.update(id, { state: "minimized" });
    browser.calls.length = 0;
    const shot = await screenshot();
    expect(shot.mimeType).toBe("image/png");
    expect(browser.calls.filter(([api]) => api === "windows.update" || api === "tabs.captureVisibleTab")).toEqual([
        ["windows.update", id, { state: "normal", focused: false }],
        ["tabs.captureVisibleTab", id, "normal"],
        ["windows.update", id, { state: "minimized" }],
    ]);
    personUndisturbed();
});

test("a capture that never comes is a refusal, not a hang, and a page not showing in its window is not captured", async () => {
    await call("open", { url: "app.example/chart" });
    browser.captureHangs = true;
    await expect(screenshot(undefined, 30)).rejects.toThrow("did not hand over a picture");

    // Another of its tabs is behind the one in front, and a picture of the window would be of that one instead.
    browser.captureHangs = false;
    const behind = browser.tabs.find((tab) => tab.windowId === PERSON_WINDOW && tab.id === PERSON_TAB);
    await call("open", { url: "app.example/other", tab: "new" });
    const hidden = browser.tabs.find((tab) => tab.url === "https://app.example/chart")?.id ?? 0;
    await expect(screenshot(hidden)).rejects.toThrow("not the one showing in its window");
    expect(behind?.active).toBe(true);
});
