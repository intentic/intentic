import { beforeEach, expect, test } from "vitest";
import { handleMcpMessage } from "./mcp.js";
import { store } from "./store.js";

/* THE TOOL SURFACE, against a fake browser.
 *
 * What this is really testing is the checkpoint every page tool goes through: a call for a site nobody granted
 * must come back as a READABLE REFUSAL rather than an exception, must name the site, and must tell the agent
 * the one thing it can do about it. That path crosses four modules (mcp → tab-access → policy → audit) and is
 * the difference between an agent that says "ask them to allow github.com" and one that reports a broken
 * sandbox and retries.
 *
 * The fake is deliberately tiny and hand-written: it is a record of exactly which Chrome APIs the tools reach
 * for, so a tool that starts calling something new fails here until this file admits it. */

interface FakeTab {
    id: number;
    windowId: number;
    active: boolean;
    url?: string;
    title?: string;
}

const fakeChrome = (options: { tabs: FakeTab[]; origins: string[] }) => {
    const storage = new Map<string, unknown>();
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
        action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined },
        runtime: { getManifest: () => ({ version: "0.1.0", name: "Intentic" }) },
    };
};

const install = (options: { tabs: FakeTab[]; origins: string[] }): void => {
    Object.assign(globalThis, { chrome: fakeChrome(options), navigator: { userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Windows" } });
};

const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "0.1.0")) as {
        result: { content: { text: string }[]; isError: boolean };
    };
    return { text: answer.result.content[0]?.text ?? "", isError: answer.result.isError };
};

beforeEach(() => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://private.example/inbox" }], origins: [] });
});

test("the tool list is what the model is shown, and every tool describes its own arguments", async () => {
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "0.1.0")) as {
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

test("a site nobody granted refuses by name and points at the one thing that helps", async () => {
    const result = await call("snapshot");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("private.example");
    expect(result.text).toContain("ask_access");
    // And the refusal is on the record the person can read in the popup.
    const log = await store.log();
    expect(log[0]?.tool).toBe("snapshot");
    expect(log[0]?.ok).toBe(false);
    expect(log[0]?.detail).toContain("refused");
});

test("describe tells the agent which sites it may work on before it tries one", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: ["https://github.com/*"] });
    const result = await call("describe");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("github.com — read only");
    expect(result.text).toContain("Chrome 141 on Windows");
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
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, "0.1.0")).toBeUndefined();
    expect(await handleMcpMessage("not a message", "0.1.0")).toMatchObject({ error: { code: -32600 } });
});

/* Each switch on the card is enforced HERE, in the browser, and the refusal names the control to flip. The
 * screenshot one is worth its own test because it is the switch a page-permission check does not imply: the
 * tab was readable, and the pixels still are not. */
test("a switch that is off refuses by name, even on a site that is allowed", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: ["https://github.com/*"] });
    await store.setScopes({ read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "sensitive" });
    const result = await call("screenshot");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Take screenshots");
});

test("handing a session over is refused outright while its switch is off", async () => {
    install({ tabs: [{ id: 7, windowId: 1, active: true, url: "https://github.com/x" }], origins: ["https://github.com/*"] });
    await store.setScopes({ read: "on", act: "on", screenshot: "on", cookies: "off", confirm: "sensitive" });
    const result = await call("connect_site", { account: "gh" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Hand sessions to the sandbox");
});
