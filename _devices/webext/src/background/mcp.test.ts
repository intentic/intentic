import { handleMcpMessage } from "./mcp.js";
import { store } from "./store.js";

// Tests the checkpoint every page tool goes through: a call for an unsanctioned site must come back as a readable
// refusal naming the site and what to do about it, not an exception, crossing mcp → tab-access → policy → audit.
// The fake is tiny and hand-written, so a tool reaching for a new Chrome API fails here until this file admits it.

interface FakeTab {
    id: number;
    windowId: number;
    active: boolean;
    url?: string;
    title?: string;
}

// How many times the extension opened its own popup, across the current install.
let popupsOpened = 0;

const fakeChrome = (options: { tabs: FakeTab[]; origins: string[] }) => {
    const storage = new Map<string, unknown>();
    popupsOpened = 0;
    return {
        storage: {
            local: {
                get: async (keys: string[] | null) =>
                    Object.fromEntries((keys ?? [...storage.keys()]).filter((key) => storage.has(key)).map((key) => [key, storage.get(key)])),
                set: async (items: Record<string, unknown>) => {
                    for (const [key, value] of Object.entries(items)) {
                        storage.set(key, value);
                    }
                },
                remove: async (keys: string[]) => {
                    for (const key of keys) {
                        storage.delete(key);
                    }
                },
            },
        },
        tabs: {
            query: async () => options.tabs,
            get: async (id: number) => options.tabs.find((tab) => tab.id === id),
        },
        permissions: {
            getAll: async () => ({ origins: options.origins }),
            contains: async (request: { origins?: string[] }) => (request.origins ?? []).every((origin) => options.origins.includes(origin)),
        },
        action: {
            setBadgeText: async () => undefined,
            setBadgeBackgroundColor: async () => undefined,
            setTitle: async () => undefined,
            openPopup: async () => {
                popupsOpened += 1;
            },
        },
        runtime: { getManifest: () => ({ version: "0.1.0", name: "Intentic" }) },
    };
};

const install = (options: { tabs: FakeTab[]; origins: string[]; brave?: boolean }): void => {
    // Brave's user agent IS Chrome's, verbatim: the flag is the whole difference between the two installs.
    const navigator = {
        userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Windows",
        ...(options.brave === true ? { brave: { isBrave: async () => true } } : {}),
    };
    Object.assign(globalThis, { chrome: fakeChrome(options), navigator });
};

const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, undefined)) as {
        result: { content: { text: string }[]; isError: boolean };
    };
    return { text: answer.result.content[0]?.text ?? "", isError: answer.result.isError };
};

beforeEach(() => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://private.example/inbox" }], origins: [] });
});

test("the tool list is what the model is shown, and every tool describes its own arguments", async () => {
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined)) as {
        result: { tools: { name: string; description: string; inputSchema: { type?: string } }[] };
    };
    const names = answer.result.tools.map((tool) => tool.name);
    expect(names).toContain("snapshot");
    expect(names).toContain("ask_access");
    expect(names).toContain("connect_site");
    for (const tool of answer.result.tools) {
        expect(tool.description.length).toBeGreaterThan(40);
        // MCP clients expect an object schema at the root; a union or a bare string breaks the tool listing.
        expect(tool.inputSchema.type).toBe("object");
    }
});

// The runtime reads these hints: a read-only tool may run beside other reads, and every other one runs alone.
test("the tool list says which tools only read and which can lose something", async () => {
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined)) as {
        result: { tools: { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[] };
    };
    const { tools } = answer.result;
    expect(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual([
        "describe",
        "snapshot",
        "read",
        "wait_for",
        "screenshot",
    ]);
    expect(tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name)).toEqual([
        "click",
        "fill",
        "key",
        "connect_site",
        "lend_site",
    ]);
});

test("a site nobody granted refuses by name and points at the one thing that helps", async () => {
    const result = await call("snapshot");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("private.example");
    expect(result.text).toContain("ask_access");
    // And the refusal is on the record the person can read in the popup.
    const log = await store.log();
    expect(log[0]?.tool).toBe("snapshot");
    expect(log[0]?.ok).toBe(false);
    expect(log[0]?.detail).toBe("Looked over the page");
    expect(log[0]?.note).toContain("refused");
});

// The popup comes to the person for a new request, since the agent is blocked on it; a repeat of the same request
// is a reminder the badge already gives, and the person can turn the whole thing off.
test("asking for a site opens the popup once per new request, unless the person turned that off", async () => {
    await call("ask_access", { origin: "github.com", reason: "To read the alert." });
    expect(popupsOpened).toBe(1);
    await call("ask_access", { origin: "github.com", reason: "Still need it." });
    expect(popupsOpened).toBe(1);
    expect((await store.pending())?.origin).toBe("https://github.com/*");
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: [] });
    await store.setSettings({ openOnAsk: false });
    await call("ask_access", { origin: "gitlab.com", reason: "To read the pipeline." });
    expect(popupsOpened).toBe(0);
    expect((await store.pending())?.origin).toBe("https://gitlab.com/*");
});

test("a site the person declined is refused as a decision, and asking again is refused too", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://private.example/inbox" }], origins: [] });
    await store.decline("https://private.example/*", Date.now());
    const snapshot = await call("snapshot");
    expect(snapshot.isError).toBe(true);
    expect(snapshot.text).toContain("declined access to private.example");
    const again = await call("ask_access", { origin: "private.example", reason: "Please." });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("Do not ask again");
    expect(await store.pending()).toBeUndefined();
});

// The extension holds the sandbox's own origin to reach it, and policy.ts refuses it as a target: listing it as a
// site to work on told the agent something false and offered the person a "remove" that cut the connection.
test("the sandbox's own origin is not listed as a site to work on", async () => {
    install({
        tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }],
        origins: ["https://github.com/*", "https://sandbox-1.example.dev/*"],
    });
    await store.setSandbox({ url: "https://sandbox-1.example.dev", token: "t" });
    const result = await call("describe");
    expect(result.text).toContain("github.com — read only");
    expect(result.text).not.toContain("sandbox-1.example.dev");
});

test("describe tells the agent which sites it may work on before it tries one", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: ["https://github.com/*"] });
    const result = await call("describe");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("github.com — read only");
    expect(result.text).toContain("Chrome 141 on Windows");
});

// A browser the person calls Brave must not introduce itself as Chrome: the card, this answer and the turn's prompt
// all carry this string, and an agent that cannot match it to the browser in front of them reaches somewhere else.
test("Brave says Brave, though its user agent says Chrome", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: [], brave: true });
    const result = await call("describe");
    expect(result.text).toContain("Brave 141 on Windows");
});

test("a tool this browser does not have is an answer, not a transport error", async () => {
    const result = await call("run_command", { command: "rm -rf /" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`no tool called "run_command"`);
});

test("bad arguments come back readable enough for the model to fix its own call", async () => {
    const result = await call("wait_for", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("textGone");
});

test("a notification is not answered, and a malformed message does not throw", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, undefined)).toBeUndefined();
    expect(await handleMcpMessage("not a message", undefined)).toMatchObject({ error: { code: -32600 } });
});

// Each switch is enforced here, in the browser, naming the control to flip. Screenshot gets its own test since a
// page-permission check doesn't imply it: the tab is readable but the pixels aren't.
test("a switch that is off refuses by name, even on a site that is allowed", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: ["https://github.com/*"] });
    await store.setScopes({ read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "sensitive" });
    const result = await call("screenshot");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Take screenshots");
});

// A stored grant this build cannot parse still holds the owner's choices, and the defaults turn reading and acting on:
// read as the defaults, a switch the owner turned off would come back on.
test("a stored grant that no longer parses refuses every switch rather than falling back to the defaults", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: ["https://github.com/*"] });
    await chrome.storage.local.set({ scopes: { read: "off", act: "off", screenshot: "off", cookies: "off", confirm: "sometimes" } });
    expect(await store.scopes()).toEqual({ read: "off", act: "off", screenshot: "off", cookies: "off", confirm: "always" });
    const result = await call("snapshot");
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`"Read the page" is switched off`);
});

test("a stored pause that is not a boolean holds as paused, and nothing stored is running", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: ["https://github.com/*"] });
    expect(await store.paused()).toBe(false);
    await chrome.storage.local.set({ paused: "yes" });
    expect(await store.paused()).toBe(true);
    const result = await call("snapshot");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("This browser is paused");
});

test("handing a session over is refused outright while its switch is off", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: ["https://github.com/*"] });
    await store.setScopes({ read: "on", act: "on", screenshot: "on", cookies: "off", confirm: "sensitive" });
    const result = await call("connect_site", { account: "gh" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Hand sessions to the sandbox");
});

// The popup's `activeTab` hands Chrome's URL for the tab in front to this extension until that tab navigates, so a
// listing that trusted Chrome's redaction would name a site the person never allowed.
test("a tab on a site nobody allowed is listed without its address, even when Chrome reveals it", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://bank.example/accounts", title: "Your accounts" }], origins: [] });
    const result = await call("tabs");
    expect(result.text).not.toContain("bank.example");
    expect(result.text).not.toContain("Your accounts");
});

// What the person reads afterwards: a sentence per call, and never what was typed.
test("the activity list records a fill by its length, not its text", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: [] });
    await call("fill", { ref: "e9", text: "hunter2 is my password", submit: true });
    const [entry] = await store.log();
    expect(entry?.detail).toBe("Typed 22 characters into e9 and submitted");
    expect(JSON.stringify(entry)).not.toContain("hunter2");
});
