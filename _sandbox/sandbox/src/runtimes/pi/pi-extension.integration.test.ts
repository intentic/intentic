import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHookSocket, type HookEndpoint, type HookSocket } from "../daemon-tools/hook-socket.js";
import { PI_ASK_TOOL, PI_EXTENSION_SOURCE, PI_TURN_ENV } from "./pi-extension.js";

// The extension as Pi would load it: its text written to a file and imported, its factory handed a stand-in for Pi's
// extension API.

interface Registered {
    readonly name: string;
    readonly execute: (...args: unknown[]) => Promise<{ readonly content: readonly { readonly text: string }[] }>;
}

// Pi's bash input, which a rewrite replaces in place.
interface BashInput {
    command: string;
    timeout?: number;
}

// A handler as Pi calls it: the event, then the context.
type Handler = (event: object, ctx: object) => Promise<object | undefined> | object | undefined;

// The parts of Pi's extension API the extension calls.
interface FakePi {
    readonly registerTool: (tool: Registered) => void;
    readonly on: (event: string, handler: Handler) => void;
    registerMcpServer?: (name: string, config: object) => void;
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-extension-"));
    Reflect.deleteProperty(globalThis, "__intenticPiTurn");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    Reflect.deleteProperty(globalThis, "__intenticPiTurn");
    Reflect.deleteProperty(process.env, PI_TURN_ENV);
});

// Loads a fresh copy of the extension against a fake Pi; `mcp` is false for a Pi with no registerMcpServer.
const load = async (mcp: boolean) => {
    const file = join(dir, `extension-${String(Math.random()).slice(2)}.mjs`);
    writeFileSync(file, PI_EXTENSION_SOURCE);
    // SAFETY: the module's default export is the extension factory the source text declares.
    const factory = ((await import(pathToFileURL(file).href)) as { default: (pi: object) => void }).default;
    const tools: Registered[] = [];
    const servers: [string, object][] = [];
    const handlers = new Map<string, Handler>();
    const pi: FakePi = {
        registerTool: (tool) => {
            tools.push(tool);
        },
        on: (event, handler) => {
            handlers.set(event, handler);
        },
    };
    if (mcp) {
        pi.registerMcpServer = (name, config) => {
            servers.push([name, config]);
        };
    }
    factory(pi);
    return { tools, servers, handlers };
};

// A turn file naming a live hook socket with these endpoints, as pi-rpc.ts writes it.
const withSocket = async (endpoints: Record<string, HookEndpoint>): Promise<HookSocket> => {
    const socket = createHookSocket(join(dir, "hooks.sock"), endpoints);
    await socket.listen();
    const file = join(dir, "turn.json");
    writeFileSync(file, JSON.stringify({ mcp: [], hooks: join(dir, "hooks.sock") }));
    process.env[PI_TURN_ENV] = file;
    return socket;
};

test("every call is put to the socket first: refused, run with its input changed in place, or run as it is", async () => {
    const asked: unknown[] = [];
    const { promise: ready, resolve: noteReady } = Promise.withResolvers<void>();
    const socket = await withSocket({
        "/ready": {
            answer: () => {
                noteReady();
                return {};
            },
            unreadable: {},
        },
        "/tool-call": {
            answer: (payload) => {
                asked.push(payload);
                // SAFETY: the extension posts a JSON object with the call's tool name.
                const tool = (payload as { tool: string }).tool;
                return tool === "write" ? { block: true, reason: "not here" } : tool === "bash" ? { input: { command: "wrapped ls" }, context: "said once" } : {};
            },
            unreadable: { block: true },
        },
        "/tool-result": { answer: () => ({ content: [{ type: "text", text: "masked" }] }), unreadable: {} },
    });
    try {
        const { handlers } = await load(false);
        await ready;
        const call = handlers.get("tool_call");
        expect(await call?.({ toolName: "write", toolCallId: "1", input: { path: "a" } }, { cwd: "/w" })).toEqual({ block: true, reason: "not here" });
        const input: BashInput = { command: "ls", timeout: 5 };
        expect(await call?.({ toolName: "bash", toolCallId: "2", input }, { cwd: "/w" })).toBeUndefined();
        expect(input).toEqual({ command: "wrapped ls" });
        expect(await call?.({ toolName: "read", toolCallId: "3", input: { path: "b" } }, {})).toBeUndefined();
        expect(asked[0]).toEqual({ tool: "write", id: "1", input: { path: "a" }, cwd: "/w" });
        // The result the daemon answers is the one Pi hands on, with what the rules said of the call beside it.
        expect(await handlers.get("tool_result")?.({ toolName: "bash", toolCallId: "2", input, content: [{ type: "text", text: "raw" }] }, {})).toEqual({
            content: [
                { type: "text", text: "masked" },
                { type: "text", text: "said once" },
            ],
        });
        expect(await handlers.get("project_trust")?.({}, {})).toEqual({ trusted: "no" });
    } finally {
        await socket.close();
    }
});

test("a call that cannot be asked about is refused, and a result that cannot be checked is withheld", async () => {
    const file = join(dir, "turn.json");
    writeFileSync(file, JSON.stringify({ mcp: [], hooks: join(dir, "nobody.sock") }));
    process.env[PI_TURN_ENV] = file;
    const { handlers } = await load(false);
    const refused = await handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "1", input: { command: "ls" } }, {});
    expect(refused).toMatchObject({ block: true, reason: expect.stringContaining("could not check this call") });
    const withheld = await handlers.get("tool_result")?.({ toolName: "read", toolCallId: "2", input: {}, content: [{ type: "text", text: "secret" }] }, {});
    expect(JSON.stringify(withheld)).toContain("intentic withheld this tool's output");
    expect(JSON.stringify(withheld)).not.toContain("secret\"");
});

test("the ask tool puts choices to Pi's select and a bare question to its input, and says what came back", async () => {
    const { tools } = await load(false);
    const ask = tools.find((tool) => tool.name === PI_ASK_TOOL);
    const ui = {
        select: async (question: string, options: string[]) => `${question}:${options.join("|")}`,
        input: async () => undefined,
    };
    // Pi's newer argument order: id, params, signal, onUpdate, ctx.
    const picked = await ask?.execute("t1", { question: "Which?", options: ["a", "b"] }, undefined, undefined, { ui });
    expect(picked?.content[0]?.text).toBe("The person answered: Which?:a|b");
    const dismissed = await ask?.execute("t2", { question: "Name?" }, undefined, undefined, { ui });
    expect(dismissed?.content[0]?.text).toContain("dismissed");
});

test("the turn's servers are mounted from the per-turn file, which is gone once read", async () => {
    const file = join(dir, "turn.json");
    writeFileSync(file, JSON.stringify({ mcp: [{ name: "my server", url: "http://127.0.0.1:1/mcp", token: "lease", timeoutMs: 90_000 }] }));
    process.env[PI_TURN_ENV] = file;
    const { servers } = await load(true);
    expect(servers).toEqual([["my_server", { url: "http://127.0.0.1:1/mcp", exposure: "direct", headers: { Authorization: "Bearer lease" }, timeout: 90 }]]);
    expect(existsSync(file)).toBe(false);
});

test("a Pi with no built-in MCP still gets the ask tool", async () => {
    process.env[PI_TURN_ENV] = join(dir, "missing.json");
    const { tools, servers } = await load(false);
    expect(tools.map((tool) => tool.name)).toEqual([PI_ASK_TOOL]);
    expect(servers).toEqual([]);
});
