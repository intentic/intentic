import { askConfirm } from "../../page/overlay.js";
import { type FocusedField, pinFocusedField, typeSecretInto } from "../../page/driver.js";
import { handleMcpMessage } from "../mcp.js";
import { store } from "../store.js";

// The sandbox's `type_secret` aimed at this browser, as the extension's half of it runs: the field in focus is read,
// the ticket is presented at the sandbox's own door with the page's address, and the value that comes back on that
// answer goes into the field and nowhere else: not the tool's answer, not the activity list. The page is stood in for
// by which injected function ran with what; the page side itself is page/driver.test.ts.

const PAGE = "https://app.example/login";
const SANDBOX = "https://sandbox-1.example.dev";
// A second paired sandbox; its agent window is the same one here, so only which sandbox is asked differs.
const OTHER = "https://sandbox-2.example.dev";
const VALUE = "s3cret-value-never-shown";

interface Injected {
    readonly name: string;
    readonly args: unknown[];
}

let injected: Injected[] = [];
let focused: FocusedField = { ok: true, field: "password", message: "" };
let confirmAnswer = false;
// Where the tab is when it is asked for again by id, after the value came back.
let urlLater = PAGE;
// What the sandbox's door answers the ticket with.
interface DoorReply {
    readonly status: number;
    readonly body: unknown;
}
let door: DoorReply = { status: 200, body: { ok: true, value: VALUE } };
let posted: { url: string; headers: Record<string, string>; body: unknown }[] = [];

const nameOf = (func: unknown): string =>
    func === pinFocusedField ? "focus" : func === typeSecretInto ? "type" : func === askConfirm ? "ask" : "banner";

const answerFor = (name: string) => {
    switch (name) {
        case "focus":
            return focused;
        case "type":
            return { ok: true, message: "typed" };
        case "ask":
            return confirmAnswer;
        default:
            return undefined;
    }
};

const realFetch = globalThis.fetch;

const area = (storage: Map<string, unknown>) => ({
    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)])),
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
});

beforeEach(async () => {
    injected = [];
    focused = { ok: true, field: "password", message: "" };
    confirmAnswer = false;
    urlLater = PAGE;
    door = { status: 200, body: { ok: true, value: VALUE } };
    posted = [];
    const storage = new Map<string, unknown>();
    // Window 1 is the agent's own (agent-window.ts): the field in focus is looked for in its tab in front, tab 7.
    const session = new Map<string, unknown>([["agentWindows", { [SANDBOX]: 1, [OTHER]: 1 }]]);
    Object.assign(globalThis, {
        chrome: {
            storage: {
                local: area(storage),
                session: area(session),
            },
            tabs: {
                query: async () => [{ id: 7, windowId: 1, active: true, url: PAGE }],
                get: async (id: number) => ({ id, windowId: 1, active: true, url: urlLater }),
            },
            windows: {
                get: async (id: number) => ({ id, focused: true, state: "normal", tabs: [{ id: 7, windowId: 1, active: true, url: PAGE }] }),
                update: async (id: number) => ({ id, focused: true }),
            },
            action: {
                setBadgeText: async () => undefined,
                setBadgeBackgroundColor: async () => undefined,
                setTitle: async () => undefined,
                openPopup: async () => undefined,
            },
            permissions: { contains: async () => true },
            scripting: {
                executeScript: async (injection: { func: unknown; args?: unknown[] }) => {
                    const name = nameOf(injection.func);
                    injected.push({ name, args: injection.args ?? [] });
                    return [{ frameId: 0, result: answerFor(name) }];
                },
            },
            runtime: { getManifest: () => ({ version: "0.1.0", name: "Intentic" }) },
        },
    });
    globalThis.fetch = Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
            posted.push({
                url: String(url),
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
                body: JSON.parse(String(init?.body)),
            });
            return new Response(JSON.stringify(door.body), { status: door.status, headers: { "content-type": "application/json" } });
        },
        { preconnect: realFetch.preconnect },
    );
    await store.addSandbox({ url: SANDBOX, token: "iwx_token" });
    await store.setScopes(SANDBOX, { read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "sensitive" });
    await store.setMode("https://app.example/*", "act");
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

const typeTicket = async (args: Record<string, unknown> = { ticket: "tkt_one" }, from = SANDBOX) => {
    const answer = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "type_ticket", arguments: args } },
        from,
    );
    // SAFETY: a tools/call is always answered with a result envelope (peer-mcp-server.ts), a failure as isError.
    const result = (answer as { result: { content: { text: string }[]; isError: boolean; structuredContent?: unknown } }).result;
    return { answer, text: result.content[0]?.text ?? "", isError: result.isError, structured: result.structuredContent };
};

const ran = (name: string): Injected[] => injected.filter((call) => call.name === name);

test("the ticket is presented with the page, and the value goes into the field held, never into the answer", async () => {
    const typed = await typeTicket();
    expect(typed.isError).toBe(false);
    expect(typed.structured).toEqual({ host: "app.example", field: "password" });
    expect(typed.text).toBe("Typed the secret into the focused password field on app.example.");

    // The door, on this browser's own token, told the ticket and where the value would go, and nothing else.
    expect(posted).toEqual([
        {
            url: `${SANDBOX}/system/webext/secret`,
            headers: { authorization: "Bearer iwx_token", "content-type": "application/json" },
            body: { ticket: "tkt_one", url: PAGE, field: "password" },
        },
    ]);
    // Into the field that was held, on the site it was held on.
    const [pin] = ran("focus")[0]?.args ?? [];
    expect(ran("type").map((call) => call.args)).toEqual([[pin, VALUE, "https://app.example"]]);

    // The value is in no answer and no record the agent or the person reads.
    expect(JSON.stringify(typed.answer)).not.toContain(VALUE);
    const log = await store.log();
    expect(log[0]?.detail).toBe("Typed a stored secret into the field in focus");
    expect(log[0]?.ok).toBe(true);
    expect(JSON.stringify(log)).not.toContain(VALUE);
});

// With two sandboxes paired, a ticket is presented only to the one whose socket the call came over, on that one's own
// token: another sandbox never learns of it, and could not redeem it anyway.
test("a ticket is collected from the sandbox that sent it, on its own token, never from another paired one", async () => {
    await store.addSandbox({ url: OTHER, token: "iwx_other" });
    await store.setScopes(OTHER, { read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "sensitive" });
    expect((await typeTicket({ ticket: "tkt_two" }, OTHER)).isError).toBe(false);
    expect(posted.map(({ url, headers }) => [url, headers["authorization"]])).toEqual([[`${OTHER}/system/webext/secret`, "Bearer iwx_other"]]);
    expect((await store.log())[0]?.sandbox).toBe(OTHER);
});

// A sandbox no longer paired holds no token here, so its socket's late call collects nothing.
test("a call from a sandbox that is not paired types nothing and asks nobody", async () => {
    await store.setScopes(OTHER, { read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "sensitive" });
    const typed = await typeTicket({ ticket: "tkt_two" }, OTHER);
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain("not paired with a sandbox");
    expect(posted).toEqual([]);
});

test("nothing in focus is refused before the sandbox is asked for anything", async () => {
    focused = { ok: false, field: "text", message: "No text field is focused on this page: click the field first, then type the secret again." };
    const typed = await typeTicket();
    expect(typed.isError).toBe(true);
    expect(typed.text).toBe("No text field is focused on this page: click the field first, then type the secret again.");
    expect(posted).toEqual([]);
    expect(ran("type")).toEqual([]);
});

test("a site allowed for reading only is refused like any other action, before the sandbox is asked", async () => {
    await store.setMode("https://app.example/*", "read");
    const typed = await typeTicket();
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain("app.example is allowed for reading only");
    expect(injected).toEqual([]);
    expect(posted).toEqual([]);
});

test("the sandbox's refusal is the tool's, word for word, and nothing is typed", async () => {
    door = { status: 403, body: { ok: false, message: "GRAFANA_ADMIN_PASSWORD may only be typed on grafana.example.com." } };
    const typed = await typeTicket();
    expect(typed.isError).toBe(true);
    expect(typed.text).toBe("GRAFANA_ADMIN_PASSWORD may only be typed on grafana.example.com.");
    expect(ran("type")).toEqual([]);
    expect((await store.log())[0]?.note).toBe("refused: GRAFANA_ADMIN_PASSWORD may only be typed on grafana.example.com.");
});

test("an answer from the sandbox this browser cannot read types nothing", async () => {
    door = { status: 502, body: "<html>bad gateway</html>" };
    const typed = await typeTicket();
    expect(typed.text).toBe("The sandbox did not hand the secret over (502), so nothing was typed.");
    expect(ran("type")).toEqual([]);
});

test("a person whose switches ask before every action is asked first, and a no reaches nobody", async () => {
    await store.setScopes(SANDBOX, { read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "always" });
    const typed = await typeTicket();
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain("said no (or did not answer) to typing a secret into this password field");
    expect(ran("ask").map((call) => call.args.slice(0, 2))).toEqual([["Your agent wants to type a stored secret into this password field. Allow it?", 45_000]]);
    // The question carries its id, which the popup answers it by (asking.ts).
    expect(String(ran("ask")[0]?.args[2]).length).toBeGreaterThan(8);
    expect(posted).toEqual([]);

    // Their yes lets it through.
    confirmAnswer = true;
    expect((await typeTicket()).isError).toBe(false);
    expect(posted).toHaveLength(1);
});

test("a tab that moved to another site while the secret was released gets nothing", async () => {
    urlLater = "https://elsewhere.example/";
    await store.setMode("https://elsewhere.example/*", "act");
    const typed = await typeTicket();
    expect(typed.isError).toBe(true);
    expect(typed.text).toBe("The page moved to another site while the secret was being released, so nothing was typed.");
    expect(ran("type")).toEqual([]);
});

test("the call takes a ticket and nothing else", async () => {
    const typed = await typeTicket({});
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain("ticket");
    expect(posted).toEqual([]);
});
