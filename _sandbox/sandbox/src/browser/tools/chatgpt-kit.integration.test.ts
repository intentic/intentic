import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runInThisContext } from "node:vm";
import { z } from "zod";
import { errorMessage } from "@intentic/base/errors";
import type { JsonValue } from "@intentic/base/json";
import { parsedJsonLines } from "@intentic/base/json-lines";
import { dom } from "@intentic/testing/dom";
import type { ChatTiming } from "@intentic/site-kits/chatgpt";
import { CHAT_ID, type FakeAccount, type FakeChatgpt, type FakeOptions, fakePageAt, giveEveryElementABox, mountFakeChatgpt } from "@intentic/site-kits/chatgpt/testing";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import { type BrowserRouter, type ClientLimit, createBrowserRouter, type Prepared, type RouterManifest } from "./browser-router.js";
import { CHATGPT_SAVED_REL } from "./chatgpt-host.js";

// The ChatGPT kit on the signed-in browser router, end to end through the router: tools/list, the gate, a backend
// brought up, and every call the kit sends it. The backend is a stand-in for @playwright/mcp behind a relay process the
// router spawns as it would the real one; it answers browser_navigate, browser_evaluate and browser_run_code_unsafe by
// running the source text it is sent against jsdom holding the shared fake ChatGPT page, so a step that reached for
// anything outside itself, or left its helpers on the page's window, is caught here.

const FAST: ChatTiming = { capMs: 4000, roundMs: 400, settleMs: 30, readyMs: 300, stepMs: 300, silentMs: 1000, retryMs: 5, uploadMs: 300 };
const PROJECT_CHAT = `https://chatgpt.com/g/g-p-6a1b2c0-intentic-studio/c/${CHAT_ID}`;
// A one-pixel PNG, as ChatGPT's picture would come back from its address.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// The process the router spawns: the backend's stdio, carried to this suite's socket and back.
const RELAY = `
const net = require("net");
const socket = net.connect(Number(process.argv[2]), "127.0.0.1");
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(1));
process.on("SIGTERM", () => process.exit(0));
`;

// The one tab the backend drives, and what it was asked.
interface Tab {
    url: string;
    options: FakeOptions;
    account: FakeAccount;
    fake: FakeChatgpt | undefined;
    // Each backend tool called, in order.
    calls: string[];
    evaluates: number;
    // Evaluates after which, or while their step still waited, the kit's helpers were on the page's window.
    lingered: number;
}
let tab: Tab;

const at = (url: string): void => {
    tab.url = url;
    dom.reconfigure({ url });
};

const load = (url: string): void => {
    at(url);
    const kind = fakePageAt(url, tab.account);
    if (kind !== undefined) {
        tab.fake = mountFakeChatgpt({
            ...tab.options,
            ...kind,
            account: tab.account,
            onRoute: (path) => at(`https://chatgpt.com${path}`),
            onNavigate: (path) => load(`https://chatgpt.com${path}`),
        });
    }
};

// Playwright's Page as browser_run_code_unsafe hands it over, for what the kit asks of it.
const page = {
    url: (): string => tab.url,
    locator: (selector: string) => ({
        evaluateAll: async <Arg, Result>(func: (elements: Element[], arg: Arg) => Result, arg: Arg): Promise<Result> => func(Array.from(document.querySelectorAll(selector)), arg),
        nth: (index: number) => ({
            // As Playwright fills an input: the file read from disk, `files` set, then `change`.
            setInputFiles: async (path: string): Promise<void> => {
                const input = document.querySelectorAll(selector)[index];
                if (input === undefined) {
                    throw new Error(`no ${selector} at ${index}`);
                }
                Reflect.set(input, "files", [new File([await readFile(path, "utf8")], basename(path))]);
                input.dispatchEvent(new Event("change", { bubbles: true }));
            },
        }),
    }),
};

const text = (body: string, isError = false) => (isError ? { content: [{ type: "text", text: body }], isError: true } : { content: [{ type: "text", text: body }] });

// What a page function hands back through Playwright: JSON.
type PageFunction = (driven?: typeof page) => JsonValue | Promise<JsonValue>;

// A function's source text run as Playwright's evaluate runs it, in the page's own world, its helpers looked for on the
// window right after it started and again once it answered. Answers its value as JSON text.
const evaluate = async (source: string): Promise<string> => {
    // SAFETY: the source text of a function evaluates to that function, as browser_evaluate takes it.
    const running = Promise.resolve((runInThisContext(`(${source})`) as PageFunction)());
    await new Promise((resolve) => setTimeout(resolve, 0));
    tab.lingered += window.intenticChatgpt === undefined ? 0 : 1;
    const value = await running;
    tab.lingered += window.intenticChatgpt === undefined ? 0 : 1;
    tab.evaluates += 1;
    return JSON.stringify(value, null, 2);
};

const CallSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.string()).default({}) });

const answerCall = async (params: unknown): Promise<ReturnType<typeof text>> => {
    const { name, arguments: args } = CallSchema.parse(params);
    tab.calls.push(name);
    try {
        if (name === "browser_navigate") {
            load(args["url"] ?? "");
            return text(`### Page\n- Page URL: ${tab.url}`);
        }
        if (name === "browser_evaluate") {
            return text(`### Result\n${await evaluate(args["function"] ?? "")}\n### Ran Playwright code\nawait page.evaluate('…');`);
        }
        if (name === "browser_run_code_unsafe") {
            // SAFETY: as above, for browser_run_code_unsafe's `async (page) => …`.
            const value = await (runInThisContext(`(${args["code"] ?? ""})`) as PageFunction)(page);
            return text(`### Result\n${JSON.stringify(value)}`);
        }
        return text(`### Error\nTool "${name}" not found`, true);
    } catch (error) {
        return text(`### Error\n${errorMessage(error)}`, true);
    }
};

const MessageSchema = z.looseObject({ id: z.union([z.string(), z.number()]).exactOptional(), method: z.string().exactOptional(), params: z.unknown().exactOptional() });

// A request answered; a notification, which expects nothing, not.
const answerMessage = async (raw: unknown): Promise<RpcMessage | undefined> => {
    const message = MessageSchema.parse(raw);
    if (message.id === undefined) {
        return undefined;
    }
    if (message.method === "initialize") {
        return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } };
    }
    return { jsonrpc: "2.0", id: message.id, result: message.method === "tools/call" ? await answerCall(message.params) : {} };
};

const serve = (socket: Socket): void => {
    void (async () => {
        for await (const value of parsedJsonLines(socket)) {
            const reply = await answerMessage(value);
            if (reply !== undefined) {
                socket.write(`${JSON.stringify(reply)}\n`);
            }
        }
        // allow(silent-catch): the relay closing ends the conversation; nothing is owed after it.
    })().catch(() => undefined);
};

interface Harness {
    readonly dir: string;
    readonly router: BrowserRouter;
    // Owners the router brought up, in order.
    readonly prepares: string[];
}

const cleanups: (() => Promise<void>)[] = [];

const listening = async (server: Server): Promise<number> =>
    await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(z.object({ port: z.number() }).parse(server.address()).port));
    });

// Two accounts of one identity, one of them on chatgpt.com, and a standalone on another site; `sites` replaces the
// accounts' sites, `soleOwner` makes it a router of one browser.
const startRouter = async (more: Partial<Pick<RouterManifest, "accountSites" | "soleOwner">> = {}): Promise<Harness> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-chatgpt-kit-"));
    const relay = join(dir, "relay.cjs");
    await writeFile(relay, RELAY);
    const server = createServer(serve);
    const port = await listening(server);
    const prepares: string[] = [];
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const sole = more.soleOwner;
    const router = createBrowserRouter(
        {
            accounts: sole === undefined ? { "chatgpt-main": "identity-1", "identity-1": "identity-1", standalone: "standalone" } : {},
            owners: sole === undefined ? { "identity-1": { port: 41_100 }, standalone: { port: 41_101 } } : { [sole]: { port: 41_102 } },
            backendEnv: {},
            accountSites: { "chatgpt-main": ["auth.openai.com", "chatgpt.com"], standalone: ["example.com"] },
            ...more,
        },
        {
            toolSchemas: async () => [{ name: "browser_navigate", description: "Navigate to a URL", inputSchema: { type: "object", properties: { url: { type: "string" } } } }],
            prepare: async (owner): Promise<Prepared> => {
                prepares.push(owner);
                return { command: process.execPath, args: [relay, String(port)], env };
            },
            outputDir: join(dir, ".intentic/records/artifacts/browser"),
            kits: { root: dir, sandboxName: async () => "studio", timing: FAST },
        },
    );
    cleanups.push(async () => {
        router.close();
        server.close();
        await rm(dir, { recursive: true, force: true });
    });
    return { dir, router, prepares };
};

const ToolResultSchema = z.object({ content: z.array(z.object({ text: z.string() })), isError: z.boolean().optional() });

let nextId = 1;
const callTool = async (harness: Harness, name: string, args: Record<string, unknown>, client?: ClientLimit): Promise<z.infer<typeof ToolResultSchema>> => {
    const answer = await harness.router.handle({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, undefined, client);
    return ToolResultSchema.parse(answer?.result);
};
const said = (result: z.infer<typeof ToolResultSchema>): string => result.content.map((block) => block.text).join("\n");

const ListedSchema = z.object({
    tools: z.array(z.object({ name: z.string(), inputSchema: z.object({ required: z.array(z.string()).optional() }), annotations: z.unknown().optional() })),
});
const listed = async (harness: Harness) => ListedSchema.parse((await harness.router.handle({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }))?.result).tools;

beforeAll(() => {
    dom.reconfigure({ url: "https://chatgpt.com/" });
});
afterAll(() => {
    dom.reconfigure({ url: "http://localhost:3000" });
});

beforeEach(() => {
    giveEveryElementABox();
    window.intenticChatgpt = undefined;
    document.body.innerHTML = "";
    tab = { url: "about:blank", options: {}, account: { projects: [] }, fake: undefined, calls: [], evaluates: 0, lingered: 0 };
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
        await cleanup();
    }
});

test("the three tools are listed only beside an account signed in on chatgpt.com, each taking `account`, and never on the credential-free browser", async () => {
    const withChatgpt = await startRouter();
    const tools = await listed(withChatgpt);
    expect(tools.map((tool) => tool.name)).toEqual(["browser_navigate", "browser_webmcp_call", "chatgpt_send", "chatgpt_read", "chatgpt_image"]);
    for (const tool of tools) {
        expect(tool.inputSchema.required).toContain("account");
    }
    expect(tools.find((tool) => tool.name === "chatgpt_send")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    const without = await startRouter({ accountSites: { standalone: ["example.com"] } });
    expect((await listed(without)).map((tool) => tool.name)).toEqual(["browser_navigate", "browser_webmcp_call"]);
    const web = await startRouter({ soleOwner: "web" });
    expect((await listed(web)).map((tool) => tool.name)).toEqual(["browser_navigate", "browser_webmcp_call"]);
    expect([withChatgpt.prepares, without.prepares, web.prepares]).toEqual([[], [], []]);
});

test("a first chatgpt_send makes the sandbox's project in the account's browser and answers there, one evaluate per step with no helper left on the page", async () => {
    const harness = await startRouter();
    tab.options = { replies: [{ kind: "text", text: "Option B." }] };
    const answer = said(await callTool(harness, "chatgpt_send", { account: "chatgpt-main", prompt: "Compare A and B." }));
    expect(answer).toContain(
        `ChatGPT answered.\nChat: "${CHAT_ID}" (in this sandbox's ChatGPT project), in the browser's tab (account "chatgpt-main"), ${PROJECT_CHAT}.`,
    );
    expect(answer).toContain(`Made the ChatGPT project "Intentic · studio" for this sandbox's chats, with project-only memory.`);
    expect(answer).toContain("ChatGPT wrote:\nOption B.");
    expect(tab.fake?.sent).toEqual(["Compare A and B."]);
    expect(harness.prepares).toEqual(["identity-1"]);
    // Kept beside the browser's profile, for its next call.
    const memory: unknown = JSON.parse(await readFile(join(harness.dir, ".intentic/local/browser/identity-1.chatgpt.json"), "utf8"));
    expect(memory).toEqual({
        project: { url: "https://chatgpt.com/g/g-p-6a1b2c0-intentic-studio/project", name: "Intentic · studio", memory: true, instructions: true },
        chats: [{ chat: CHAT_ID, tabId: 1, url: PROJECT_CHAT, home: "project" }],
    });
    expect(tab.evaluates).toBeGreaterThan(10);
    expect(tab.lingered).toBe(0);
    expect(window.intenticChatgpt).toBeUndefined();
    expect(new Set(tab.calls)).toEqual(new Set(["browser_navigate", "browser_evaluate"]));
});

test("an account whose browser holds no ChatGPT account is refused with the one that does, before any browser starts", async () => {
    const harness = await startRouter();
    const refused = await callTool(harness, "chatgpt_send", { account: "standalone", prompt: "Hello." });
    expect(refused.isError).toBe(true);
    expect(said(refused)).toBe(
        `Account "standalone"'s browser is not signed in to ChatGPT: no account on chatgpt.com this turn holds lives in it. Nothing was sent. Pass \`account\` "chatgpt-main": the account on chatgpt.com this turn holds.`,
    );
    const none = await startRouter({ accountSites: { standalone: ["example.com"] } });
    const nothing = said(await callTool(none, "chatgpt_read", { account: "chatgpt-main", chat: CHAT_ID }));
    expect(nothing).toContain("No account this turn holds is signed in on chatgpt.com");
    expect(nothing).toContain("`connect_site` on chatgpt.com");
    expect([harness.prepares, none.prepares, tab.calls]).toEqual([[], [], []]);
});

test("files are vetted on the artifacts shelf and put into ChatGPT's file input by Playwright; one off the shelf is refused with nothing sent", async () => {
    const harness = await startRouter();
    const shelf = join(harness.dir, ".intentic/records/artifacts");
    await mkdir(shelf, { recursive: true });
    await writeFile(join(shelf, "brief.md"), "# Brief\n");
    await writeFile(join(harness.dir, "notes.md"), "private\n");
    const off = await callTool(harness, "chatgpt_send", { account: "chatgpt-main", prompt: "Summarize.", files: [join(harness.dir, "notes.md")] });
    expect(off.isError).toBe(true);
    expect(said(off)).toContain(`${join(harness.dir, "notes.md")} is not on the artifacts shelf.`);
    expect(said(off)).toContain("Nothing was sent.");
    expect([harness.prepares, tab.calls]).toEqual([[], []]);
    tab.options = { replies: [{ kind: "text", text: "Read." }] };
    const answer = said(await callTool(harness, "chatgpt_send", { account: "identity-1", prompt: "Summarize.", files: [join(shelf, "brief.md")] }));
    expect(answer).toContain("ChatGPT wrote:\nRead.");
    expect(tab.fake?.attached).toEqual(["brief.md"]);
    expect(tab.fake?.sent).toEqual(["Summarize."]);
    expect(tab.calls).toContain("browser_run_code_unsafe");
});

test("ChatGPT waiting on its own button is reported with the way to show the owner, pressed by nobody, and read again in the same chat", async () => {
    const harness = await startRouter();
    tab.options = { replies: [{ kind: "confirm", text: "About to search your Drive.", button: "Confirm" }] };
    const answer = said(await callTool(harness, "chatgpt_send", { account: "chatgpt-main", prompt: "Find the deck." }));
    expect(answer).toContain(`ChatGPT is waiting for the person to press "Confirm" in the browser's tab (account "chatgpt-main"). This kit never presses ChatGPT's own confirmations`);
    expect(answer).toContain(
        `Do not send the prompt again. The owner can look at that tab themselves: call \`request_help\` on the \`accounts\` server (\`mcp__accounts__request_help\`) with account "chatgpt-main"`,
    );
    const again = said(await callTool(harness, "chatgpt_read", { account: "identity-1", chat: CHAT_ID, wait: 1 }));
    expect(again).toContain(`ChatGPT is waiting for the person to press "Confirm" in the browser's tab (account "identity-1").`);
    expect(tab.fake?.confirmed).toBe(false);
    expect(tab.fake?.sent).toEqual(["Find the deck."]);
    expect(tab.lingered).toBe(0);
});

test("a picture ChatGPT made is fetched in the page and saved on the shelf under the kit's own directory", async () => {
    const harness = await startRouter();
    tab.options = { replies: [{ kind: "image", src: `data:image/png;base64,${PIXEL}`, text: "Here it is." }] };
    const answer = said(await callTool(harness, "chatgpt_image", { account: "chatgpt-main", prompt: "Watercolor fox.", name: "fox" }));
    const saved = join(harness.dir, CHATGPT_SAVED_REL, "fox.png");
    expect(answer).toContain(`Made 1 image with ChatGPT and saved it:\n- ${saved} (${Buffer.from(PIXEL, "base64").byteLength} bytes, image/png, 1672×941)`);
    expect((await readFile(saved)).toString("base64")).toBe(PIXEL);
});

test("a client that stops waiting at a minute has chatgpt_image refused before any browser starts, and chatgpt_send cut to fit", async () => {
    const harness = await startRouter();
    const image = await callTool(harness, "chatgpt_image", { account: "chatgpt-main", prompt: "A fox." }, { clientCeilingMs: 60_000 });
    expect(image.isError).toBe(true);
    expect(said(image)).toContain("Here, use chatgpt_send with mode \"image\" and wait at most 50");
    expect(harness.prepares).toEqual([]);
    tab.options = { replies: [{ kind: "text", text: "Done." }] };
    const sent = said(await callTool(harness, "chatgpt_send", { account: "chatgpt-main", prompt: "Quick one." }, { clientCeilingMs: 60_000 }));
    expect(sent).toContain("ChatGPT wrote:\nDone.");
    expect(sent).toContain("so this chatgpt_send waited at most 50 s instead of 540 s.");
});
