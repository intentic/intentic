import { describeCall } from "../activity.js";
import { installBrowser, PERSON_TAB } from "../browser-testing.js";
import { handleMcpMessage } from "../mcp.js";
import { store } from "../store.js";
import { answerScriptRequest, personToggle } from "../tools/scripts.js";
import { kept } from "./kept.js";
import { handleUserScriptMessage, syncScripts } from "./runtime.js";

// User scripts end to end in the worker, against a browser that holds registrations the way Chrome's userScripts API
// does: what an agent may ask for, what only the person's click installs, what the browser is then told to run and with
// which reach, and what stops it. The popup's own buttons call the same functions answerScriptRequest and personToggle.

const SANDBOX = "https://sandbox-1.example.dev";
const OTHER = "https://sandbox-2.example.dev";
const SCOPES = { read: "on", act: "on", screenshot: "off", cookies: "off", scripts: "on", confirm: "sensitive" } as const;
const GITHUB = "https://github.com/*";

interface FakeScripts {
    permission: boolean;
    // The browser's own switch: off leaves chrome.userScripts undefined, as Chrome does.
    toggle: boolean;
    origins: string[];
    readonly registered: Map<string, chrome.RegisteredUserScript>;
    readonly worlds: Map<string, { csp?: string; messaging?: boolean }>;
    executed: chrome.UserScriptSource[][];
    answer: unknown;
}

let fake: FakeScripts;

const install = (): void => {
    installBrowser();
    fake = { permission: true, toggle: true, origins: [GITHUB], registered: new Map(), worlds: new Map(), executed: [], answer: undefined };
    const api: chrome.UserScriptsApi = {
        register: async (scripts) => {
            for (const script of scripts) {
                fake.registered.set(script.id, script);
            }
        },
        update: async (scripts) => {
            for (const script of scripts) {
                fake.registered.set(script.id, { ...fake.registered.get(script.id), ...script });
            }
        },
        unregister: async (filter) => {
            for (const id of filter?.ids ?? [...fake.registered.keys()]) {
                fake.registered.delete(id);
            }
        },
        getScripts: async () => [...fake.registered.values()],
        configureWorld: async ({ worldId, ...properties }) => {
            fake.worlds.set(worldId ?? "", properties);
        },
        execute: async (injection) => {
            fake.executed.push(injection.js);
            return [{ frameId: 0, result: fake.answer }];
        },
    };
    // The browser's own switch decides whether the API is there at all, read on every access as Chrome's is.
    Object.defineProperty(globalThis.chrome, "userScripts", { configurable: true, get: () => (fake.toggle ? api : undefined) });
    Object.assign(globalThis.chrome, {
        permissions: {
        contains: async (request: { origins?: string[]; permissions?: string[] }) =>
            (request.permissions ?? []).every((permission) => permission === "userScripts" && fake.permission) &&
            (request.origins ?? []).every((origin) => fake.origins.includes(origin)),
            getAll: async () => ({ origins: fake.origins }),
        },
    });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Mozilla/5.0 Chrome/156.0.0.0 Windows" } });
};

const call = async (name: string, args: Record<string, unknown> = {}, from = SANDBOX): Promise<{ text: string; isError: boolean }> => {
    // SAFETY: a tools/call is always answered with a result envelope (peer-mcp-server.ts), a failure as isError.
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, from)) as {
        result: { content: { text: string }[]; isError: boolean };
    };
    return { text: answer.result.content[0]?.text ?? "", isError: answer.result.isError };
};

const source = (name: string, ...extra: string[]): string =>
    [
        "// ==UserScript==",
        `// @name ${name}`,
        "// @match https://github.com/*/pulls*",
        ...extra.map((line) => `// ${line}`),
        "// ==/UserScript==",
        `document.body.dataset.sized = "yes";`,
    ].join("\n");

// The request the agent's call left for the person, once it is there.
const waitingRequest = async (): Promise<string> => {
    for (let tries = 0; tries < 200; tries++) {
        const [request] = await kept.requests();
        if (request !== undefined) {
            return request.id;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("No request was left for the person.");
};

// An install the person accepts; answers with the installed script's id.
const installed = async (name: string, ...extra: string[]): Promise<string> => {
    const asked = call("script_install", { source: source(name, ...extra), from: `userscripts/${name}.user.js` });
    expect(await answerScriptRequest(await waitingRequest(), true, false)).toBe(true);
    expect((await asked).text).toContain(`installed "${name}"`);
    const script = (await kept.scripts()).find((each) => each.name === name);
    return script!.id;
};

beforeEach(async () => {
    install();
    await store.addSandbox({ url: SANDBOX, token: "t1", name: "intentic" });
    await store.addSandbox({ url: OTHER, token: "t2", name: "marketing" });
    await store.setScopes(SANDBOX, SCOPES);
    await store.setScopes(OTHER, SCOPES);
    await store.setMode(GITHUB, "act");
});

test("no script tool works until the card's switch and the browser both allow scripts, and each says which is off", async () => {
    await store.setScopes(SANDBOX, { ...SCOPES, scripts: "off" });
    expect((await call("script_install", { source: source("A") })).text).toContain(`"Run scripts it writes" is switched off`);
    await store.setScopes(SANDBOX, SCOPES);
    fake.permission = false;
    expect((await call("script_install", { source: source("A") })).text).toContain("not turned on in this browser");
    fake.permission = true;
    fake.toggle = false;
    expect((await call("script_install", { source: source("A") })).text).toContain(`"Allow User Scripts"`);
});

test("a script may only name sites its agent may click and type on", async () => {
    const elsewhere = source("A").replace("https://github.com/*/pulls*", "https://gitlab.com/*");
    expect((await call("script_install", { source: elsewhere })).text).toContain("gitlab.com is not allowed. Call ask_access");
    await store.setMode(GITHUB, "read");
    expect((await call("script_install", { source: source("A") })).text).toContain("read only");
    expect(await kept.requests()).toEqual([]);
});

test("only the person's click installs a script, and the browser then runs it in a world that reaches its sites and hosts alone", async () => {
    const id = await installed("PR sizes", "@connect api.github.com");
    const registration = fake.registered.get(id);
    expect(registration).toMatchObject({ id, matches: ["https://github.com/*/pulls*"], worldId: id, runAt: "document_idle" });
    expect(registration?.js?.[1]?.code).toContain(`document.body.dataset.sized = "yes";`);
    const csp = fake.worlds.get(id)?.csp ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src https://github.com:* https://api.github.com;");
    expect(fake.worlds.get(id)?.messaging).toBe(true);
    expect((await call("scripts")).text).toContain(`[${id}] PR sizes`);
});

test("a declined script is not asked again as it is, and nothing is registered", async () => {
    const asked = call("script_install", { source: source("A") });
    await answerScriptRequest(await waitingRequest(), false, false);
    expect((await asked).text).toContain(`declined "A"`);
    expect((await call("script_install", { source: source("A") })).text).toContain("declined");
    expect(fake.registered.size).toBe(0);
});

test("an update is reviewed like an install, unless the person let it update while its sites and hosts stay the same", async () => {
    const id = await installed("A");
    const asked = call("script_update", { id, source: `${source("A")}\n// v2` });
    const request = await waitingRequest();
    expect((await kept.request(request))?.kind).toBe("update");
    await answerScriptRequest(request, true, true);
    expect((await asked).text).toContain(`accepted the update to "A"`);

    expect((await call("script_update", { id, source: `${source("A")}\n// v3` })).text).toContain("without asking");
    expect(fake.registered.get(id)?.js?.[1]?.code).toContain("// v3");
    expect(await kept.requests()).toEqual([]);

    // A new host is more than they allowed: asked again, whatever the setting.
    const wider = call("script_update", { id, source: `${source("A", "@connect api.example.com")}\n// v4` });
    const ask = await waitingRequest();
    await answerScriptRequest(ask, false, false);
    expect((await wider).text).toContain("declined");
});

test("a sandbox changes only the scripts it installed, and an agent never turns back on what the person turned off", async () => {
    const id = await installed("A");
    expect((await call("script_remove", { id }, OTHER)).text).toContain("installed from intentic");
    await personToggle(id, false);
    expect(fake.registered.has(id)).toBe(false);
    expect((await call("script_toggle", { id, on: true })).text).toContain("Only they turn it back on");
    await personToggle(id, true);
    expect(fake.registered.has(id)).toBe(true);
    expect((await call("script_remove", { id })).text).toContain(`Removed "A"`);
    expect(fake.registered.size).toBe(0);
});

test("a script stops while its site is not allowed for acting, or the browser is paused, and comes back after", async () => {
    const id = await installed("A");
    await store.setMode(GITHUB, "read");
    await syncScripts();
    expect(fake.registered.has(id)).toBe(false);
    expect((await call("scripts")).text).toContain("stopped: github.com is read only");
    await store.setMode(GITHUB, "act");
    await store.setPaused(true);
    await syncScripts();
    expect(fake.registered.has(id)).toBe(false);
    await store.setPaused(false);
    await syncScripts();
    expect(fake.registered.has(id)).toBe(true);
});

test("a script's messages count only with its own secret, and its log and storage are its own", async () => {
    const id = await installed("A");
    const secret = (await kept.script(id))!.secret;
    expect(await handleUserScriptMessage({ script: id, secret: "guessed", op: "log", text: "hi" }, {})).toMatchObject({ ok: false });
    expect(await handleUserScriptMessage({ script: id, secret, op: "log", level: "error", text: "boom" }, { url: "https://github.com/a/b/pulls?q=secret" })).toEqual({ ok: true });
    expect(await handleUserScriptMessage({ script: id, secret, op: "set", key: "seen", value: { count: 2 } }, {})).toEqual({ ok: true });
    expect(await handleUserScriptMessage({ script: id, secret, op: "get", key: "seen" }, {})).toEqual({ ok: true, value: { count: 2 } });
    const log = (await call("script_logs", { id })).text;
    expect(log).toContain("github.com/a/b/pulls  boom");
    expect(log).not.toContain("q=secret");
});

test("script_try runs the code once in the tab, after the person's yes for the site, and reads back what it did", async () => {
    await chrome.tabs.update(PERSON_TAB, { url: "https://github.com/a/b/pulls" });
    fake.answer = { parsed: true, ok: true, value: "3", logs: [{ level: "log", text: "found 3 rows" }] };
    const tried = await call("script_try", { source: "return document.querySelectorAll('tr').length;", tab: PERSON_TAB });
    expect(tried.text).toContain("returned 3");
    expect(tried.text).toContain("found 3 rows");
    expect(fake.executed[0]?.[1]?.code).toContain("document.querySelectorAll('tr').length");
    fake.answer = { parsed: false, logs: [] };
    expect((await call("script_try", { source: "return (", tab: PERSON_TAB })).text).toContain("does not parse");
});

test("the activity list names a script, never its code", () => {
    expect(describeCall("script_install", { source: source("PR sizes") })).toBe("Asked to install “PR sizes”");
    expect(describeCall("script_install", { source: source("PR sizes") })).not.toContain("dataset");
});
