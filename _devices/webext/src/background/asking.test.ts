import { answerAsking, clearStaleAsking } from "./asking.js";
import { type FakeBrowser, injectedInto, installBrowser, PERSON_TAB, PERSON_WINDOW } from "./browser-testing.js";
import { handleMcpMessage } from "./mcp.js";
import { DEFAULT_SETTINGS, store } from "./store.js";

// The person's yes, when the page it is about is in the agent's own window behind theirs (asking.ts): the question is
// put on the extension's icon and in the popup, which can answer it, and the agent's window flashes without taking
// focus. The page's own panel still asks, and whichever answers first is the answer.

let browser: FakeBrowser;

const call = async (name: string, args: Record<string, string | number | boolean> = {}): Promise<{ text: string; isError: boolean }> => {
    // SAFETY: a tools/call is always answered with a result envelope (peer-mcp-server.ts), a failure as isError.
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, undefined)) as {
        result: { content: { text: string }[]; isError: boolean };
    };
    return { text: answer.result.content[0]?.text ?? "", isError: answer.result.isError };
};

// The question the agent is waiting on, once it is being asked.
const asked = async (): Promise<{ id: string; tabId: number; origin: string; question: string }> => {
    for (let tries = 0; tries < 100; tries += 1) {
        const asking = await store.asking();
        if (asking !== undefined) {
            return asking;
        }
        await new Promise((tick) => setTimeout(tick, 2));
    }
    throw new Error(`nothing was asked`);
};

const flashes = (): unknown[] => browser.calls.filter(([api, , info]) => api === "windows.update" && JSON.stringify(info).includes("drawAttention"));

beforeEach(async () => {
    browser = installBrowser();
    await store.setScopes({ read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "always" });
    await store.setMode("https://app.example/*", "act");
    await store.setMode("https://mail.example/*", "act");
});

test("a question on a page behind the person's window is put on the icon and answered from the popup", async () => {
    await call("open", { url: "app.example/invoices" });
    const agentWindow = await store.agentWindowId();
    browser.pageAnswer = "wait";
    browser.calls.length = 0;

    const pressing = call("key", { key: "Enter" });
    const asking = await asked();
    expect(asking.origin).toBe("https://app.example/*");
    expect(asking.question).toBe("Your agent wants to press Enter. Allow it?");
    // The badge lights, the popup opens by itself, and the agent's window flashes: none of it takes their focus.
    expect(browser.calls).toContainEqual(["badge", "!"]);
    expect(browser.calls).toContainEqual(["popup"]);
    expect(flashes()).toEqual([["windows.update", agentWindow, { drawAttention: true }]]);
    expect(browser.windows.find((window) => window.id === PERSON_WINDOW)?.focused).toBe(true);

    expect(await answerAsking(asking.id, true)).toBe(true);
    const pressed = await pressing;
    expect(pressed.isError).toBe(false);
    // The panel still asking on the page is taken down, the flashing stops, and the icon goes quiet.
    expect(injectedInto(browser, "dismiss").map((injection) => injection.args)).toEqual([[asking.id]]);
    expect(flashes()).toEqual([
        ["windows.update", agentWindow, { drawAttention: true }],
        ["windows.update", agentWindow, { drawAttention: false }],
    ]);
    expect(await store.asking()).toBeUndefined();
    expect(browser.calls.findLast(([api]) => api === "badge")).toEqual(["badge", ""]);
});

test("a no from the popup is a no the agent is told about, and a late answer finds nothing to settle", async () => {
    await call("open", { url: "app.example/invoices" });
    browser.pageAnswer = "wait";
    const pressing = call("key", { key: "Delete" });
    const asking = await asked();
    expect(await answerAsking(asking.id, false)).toBe(true);
    const pressed = await pressing;
    expect(pressed.isError).toBe(true);
    expect(pressed.text).toContain("said no");
    expect(await answerAsking(asking.id, true)).toBe(false);
});

test("a question on the page in front of the person flashes nothing and opens no popup", async () => {
    await store.setSettings({ ...DEFAULT_SETTINGS, workIn: "front-tab" });
    browser.pageAnswer = true;
    const pressed = await call("key", { key: "Enter", tab: PERSON_TAB });
    expect(pressed.isError).toBe(false);
    expect(flashes()).toEqual([]);
    expect(browser.calls).not.toContainEqual(["popup"]);
    // Still on the icon while it waits, since the badge is the one place every question shows.
    expect(browser.calls).toContainEqual(["badge", "!"]);
});

test("a person who turned off the popup opening by itself still gets the badge and the flash", async () => {
    await store.setSettings({ ...DEFAULT_SETTINGS, openOnAsk: false });
    await call("open", { url: "app.example/invoices" });
    browser.pageAnswer = false;
    expect((await call("key", { key: "Enter" })).isError).toBe(true);
    expect(browser.calls).not.toContainEqual(["popup"]);
    expect(flashes()).toHaveLength(2);
});

test("a question left stored by a worker that died is cleared when the next one starts", async () => {
    await store.setAsking({ id: "gone", tabId: 7, origin: "https://app.example/*", question: "Your agent wants to press Enter. Allow it?", at: 1 });
    await clearStaleAsking();
    expect(await store.asking()).toBeUndefined();
    expect(await answerAsking("gone", true)).toBe(false);
});
