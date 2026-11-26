import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { runInThisContext } from "node:vm";
import { z } from "zod";
import { errorMessage } from "@intentic/base/errors";
import type { JsonValue } from "@intentic/base/json";
import type { ToolCallGrants, ToolResult } from "@intentic/extension-api";
import { type FakeBrowserCall, type FakeExtension, fakeExtensionApi, type FakeOwnerBrowserCall } from "@intentic/extension-api/testing";
import { dom } from "@intentic/testing/dom";
import type { ChatTiming } from "./kit/chatgpt/index.js";
import { CHAT_ID, type FakeAccount, type FakeChatgpt, type FakeOptions, fakePageAt, giveEveryElementABox, mountFakeChatgpt } from "./kit/chatgpt/fake-chatgpt.testing.js";
import { CHATGPT_SAVED_REL, SHELF_REL } from "./sandbox/shelf.js";
import { chatgptBackend } from "./server.js";

// The ChatGPT kit as this extension's tools, end to end on the extension API's own fake daemon: the grants a call is
// handed, `api.browser.call` into a sandbox account's browser, `api.ownerBrowser.call` into the person's own, and
// `api.jobs.start` for an image there. The account's browser is a stand-in for the turn's browser router: it answers
// browser_navigate, browser_evaluate, browser_click, browser_press_key and browser_file_upload by running against jsdom
// holding the kit's fake ChatGPT page, so a step that reached for anything outside itself, or left its helpers on the
// page's window, is caught here, and a file goes in only through the page's file chooser, as Playwright's does.

// SAFETY: the extension's own manifest, read for who it is and what it may reach.
const manifest = JSON.parse(await readFile(new URL("../intentic-extension.json", import.meta.url), "utf8")) as {
    publisher: string;
    name: string;
    permissions: { daemon: string[]; turn: ("browser" | "owner-browser" | "jobs")[] };
};

const FAST: ChatTiming = { capMs: 4000, roundMs: 400, settleMs: 30, readyMs: 300, stepMs: 300, silentMs: 1000, retryMs: 5, uploadMs: 300 };
const PROJECT_CHAT = `https://chatgpt.com/g/g-p-6a1b2c0-intentic-studio/c/${CHAT_ID}`;
// A one-pixel PNG, as ChatGPT's picture would come back from its address.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const CHATGPT_ACCOUNT = { id: "chatgpt-main", kind: "browser", sites: ["chatgpt.com", "openai.com"] } as const;
const MAIL = { id: "identity-1", kind: "identity", sites: ["mail.example.org"] } as const;
const HOLDS_CHATGPT: ToolCallGrants = { accounts: [MAIL, CHATGPT_ACCOUNT], browsers: [], cards: [] };
const HOLDS_NONE: ToolCallGrants = { accounts: [MAIL], browsers: ["chrome"], cards: [] };
const HOLDS_CHROME: ToolCallGrants = { accounts: [CHATGPT_ACCOUNT], browsers: ["chrome"], cards: [] };

// ---- the account's one tab ------------------------------------------------------------------------------------------

interface Tab {
    url: string;
    options: FakeOptions;
    account: FakeAccount;
    fake: FakeChatgpt | undefined;
    // Each browser tool called, in order.
    calls: string[];
    evaluates: number;
    // Evaluates after which, or while their step still waited, the kit's helpers were on the page's window.
    lingered: number;
    // A file chooser the page opened and nothing answered yet: Playwright refuses every other tool meanwhile.
    chooser: boolean;
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

const text = (body: string, isError = false): ToolResult => (isError ? { content: [{ type: "text", text: body }], isError: true } : { content: [{ type: "text", text: body }] });

// What a page function hands back through Playwright: JSON.
type PageFunction = () => JsonValue | Promise<JsonValue>;

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

// A pointer's click, as Playwright's delivers it: Radix's menus open on pointerdown.
const press = (el: Element): void => {
    const init = { bubbles: true, cancelable: true, button: 0 };
    const Pointer = window.PointerEvent ?? window.MouseEvent;
    el.dispatchEvent(new Pointer("pointerdown", init));
    el.dispatchEvent(new MouseEvent("mousedown", init));
    el.dispatchEvent(new Pointer("pointerup", init));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.dispatchEvent(new MouseEvent("click", init));
};

const CHOOSER = "### Modal state\n- [File chooser]: can be handled by browser_file_upload";

// The click: on the element its target names; the menu's upload item opens the page's file chooser, as ChatGPT's does.
const click = (target: string): ToolResult => {
    const el = document.querySelector(target);
    if (el === null) {
        return text(`### Error\nError: no element matches ${target}`, true);
    }
    press(el);
    tab.chooser = el.getAttribute("role") === "menuitem" && /Add photos/u.test(el.textContent ?? "");
    if (tab.chooser) {
        el.closest('[role="menu"]')?.remove();
    }
    return text(`### Ran Playwright code\nawait page.locator('${target}').click();${tab.chooser ? `\n${CHOOSER}` : ""}`);
};

// The chooser answered with the files, as Playwright sets them: read from disk, `files` set, then `change`.
const upload = async (paths: readonly string[]): Promise<ToolResult> => {
    if (!tab.chooser) {
        return text('### Error\nError: The tool "browser_file_upload" can only be used when there is related modal state present.', true);
    }
    const input = document.querySelector('form input[type="file"]');
    if (input === null) {
        return text("### Error\nError: No file chooser visible", true);
    }
    const files = await Promise.all(paths.map(async (path) => new File([await readFile(path, "utf8")], basename(path))));
    tab.chooser = false;
    Reflect.set(input, "files", files);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return text(`### Ran Playwright code\nawait fileChooser.setFiles(${JSON.stringify(paths)})`);
};

const ArgsSchema = z.looseObject({ url: z.string().optional(), function: z.string().optional(), target: z.string().optional(), key: z.string().optional(), paths: z.array(z.string()).optional() });

// The turn's browser router for the account, as `api.browser.call` reaches it.
const browser = async (call: FakeBrowserCall): Promise<ToolResult> => {
    const args = ArgsSchema.parse(call.args);
    tab.calls.push(call.tool);
    if (tab.chooser && call.tool !== "browser_file_upload") {
        return text(`### Error\nError: Tool "${call.tool}" does not handle the modal state.\n${CHOOSER}`, true);
    }
    try {
        switch (call.tool) {
            case "browser_navigate":
                load(args.url ?? "");
                return text(`### Page\n- Page URL: ${tab.url}`);
            case "browser_evaluate":
                return text(`### Result\n${await evaluate(args.function ?? "")}\n### Ran Playwright code\nawait page.evaluate('…');`);
            case "browser_click":
                return click(args.target ?? "");
            case "browser_press_key":
                document.dispatchEvent(new KeyboardEvent("keydown", { key: args.key ?? "", bubbles: true }));
                return text("### Ran Playwright code\nawait page.keyboard.press('Escape');");
            case "browser_file_upload":
                return await upload(args.paths ?? []);
            default:
                return text(`### Error\nTool "${call.tool}" not found`, true);
        }
    } catch (error) {
        return text(`### Error\n${errorMessage(error)}`, true);
    }
};

// ---- the harness --------------------------------------------------------------------------------------------------

interface Harness {
    readonly extension: FakeExtension;
    readonly root: string;
}

const extensions: FakeExtension[] = [];

const start = async (options: { readonly grants?: ToolCallGrants; readonly ownerBrowser?: (call: FakeOwnerBrowserCall) => ToolResult | Promise<ToolResult> } = {}): Promise<Harness> => {
    const extension = await fakeExtensionApi({ manifest, grants: options.grants ?? HOLDS_CHATGPT, browser, ownerBrowser: options.ownerBrowser ?? (() => text("", true)) });
    extensions.push(extension);
    await extension.activate({ activateServer: (api) => chatgptBackend(api, { sandboxName: async () => "studio", timing: FAST, quickMs: 50 }) });
    return { extension, root: extension.api.workspaceRoot };
};

const ToolResultSchema = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean().optional() });

const call = async (harness: Harness, name: string, args: Record<string, unknown>, context: { readonly conversationId?: string; readonly grants?: ToolCallGrants } = {}) =>
    ToolResultSchema.parse(await harness.extension.callTool(name, args, undefined, context));
const said = (result: z.infer<typeof ToolResultSchema>): string => result.content.map((block) => block.text).join("\n");

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
    tab = { url: "about:blank", options: {}, account: { projects: [] }, fake: undefined, calls: [], evaluates: 0, lingered: 0, chooser: false };
});

afterEach(async () => {
    for (const extension of extensions.splice(0)) {
        await extension.dispose();
    }
});

// ---- the tests ----------------------------------------------------------------------------------------------------

test("the three tools keep their names and arguments, and say where they run", async () => {
    const harness = await start();
    const tools = await harness.extension.tools();
    expect(tools.map((tool) => tool.name)).toEqual(["chatgpt_send", "chatgpt_read", "chatgpt_image"]);
    expect(tools.map((tool) => tool.effect)).toEqual(["destructive", "read", "write"]);
    const send = z.object({ properties: z.record(z.string(), z.unknown()), required: z.array(z.string()) }).parse(tools[0]?.inputSchema);
    expect(Object.keys(send.properties)).toEqual(["prompt", "chat", "mode", "files", "wait", "name", "personalized", "temporary", "account", "browser"]);
    expect(send.required).toEqual(["prompt"]);
});

test("a turn holding no account on chatgpt.com is refused before any browser is touched, and told of the person's own", async () => {
    const harness = await start({ grants: HOLDS_NONE });
    const refused = await call(harness, "chatgpt_send", { prompt: "Hello." });
    expect(refused.isError).toBe(true);
    expect(said(refused)).toContain("No account this turn holds is signed in on chatgpt.com");
    expect(said(refused)).toContain('To use ChatGPT in the person\'s own browser instead, pass `browser` "chrome"');
    const other = await call(harness, "chatgpt_read", { chat: CHAT_ID, account: "identity-1" });
    expect(said(other)).toContain("No account this turn holds is signed in on chatgpt.com");
    const none = await call(harness, "chatgpt_image", { prompt: "A fox." }, { grants: { accounts: [], browsers: [], cards: [] } });
    expect(said(none)).not.toContain("person's own browser");
    expect([harness.extension.browserCalls, harness.extension.ownerBrowserCalls, tab.calls]).toEqual([[], [], []]);
});

test("an account that is not on chatgpt.com is refused with the one that is", async () => {
    const harness = await start();
    const refused = await call(harness, "chatgpt_send", { prompt: "Hello.", account: "identity-1" });
    expect(said(refused)).toBe('Account "identity-1" does not sign in on chatgpt.com. Nothing was sent. Pass `account` "chatgpt-main": the account on chatgpt.com this turn holds.');
    const both = await call(harness, "chatgpt_send", { prompt: "Hello.", account: "chatgpt-main", browser: "chrome" });
    expect(said(both)).toContain("not both");
    const stranger = await call(harness, "chatgpt_send", { prompt: "Hello.", browser: "edge" });
    expect(said(stranger)).toBe('This turn holds no browser of the person\'s called "edge": it holds none of the person\'s own browsers. Nothing was sent.');
    expect(harness.extension.browserCalls).toEqual([]);
});

test("a first chatgpt_send makes the sandbox's project in the account's browser through api.browser, one evaluate per step with no helper left on the page", async () => {
    const harness = await start();
    tab.options = { replies: [{ kind: "text", text: "Option B." }] };
    const answer = said(await call(harness, "chatgpt_send", { prompt: "Compare A and B." }));
    expect(answer).toContain(`ChatGPT answered.\nChat: "${CHAT_ID}" (in this sandbox's ChatGPT project), in the browser's tab (account "chatgpt-main"), ${PROJECT_CHAT}.`);
    expect(answer).toContain(`Made the ChatGPT project "Intentic · studio" for this sandbox's chats, with project-only memory.`);
    expect(answer).toContain("ChatGPT wrote:\nOption B.");
    expect(tab.fake?.sent).toEqual(["Compare A and B."]);
    // Every call went to the account the grant names, and only through the page's own tools.
    expect(new Set(harness.extension.browserCalls.map((each) => each.account))).toEqual(new Set(["chatgpt-main"]));
    expect(new Set(tab.calls)).toEqual(new Set(["browser_navigate", "browser_evaluate"]));
    // Kept in the extension's own state, for its next call.
    const memory: unknown = JSON.parse(await readFile(join(harness.extension.api.stateDir, "memory", "chatgpt-main.json"), "utf8"));
    expect(memory).toEqual({
        project: { url: "https://chatgpt.com/g/g-p-6a1b2c0-intentic-studio/project", name: "Intentic · studio", memory: true, instructions: true },
        chats: [{ chat: CHAT_ID, tabId: 1, url: PROJECT_CHAT, home: "project" }],
    });
    expect(tab.evaluates).toBeGreaterThan(10);
    expect(tab.lingered).toBe(0);
    expect(window.intenticChatgpt).toBeUndefined();
});

test("ChatGPT waiting on its own button is reported with the way to show the owner, and read again in the same chat through api.browser", async () => {
    const harness = await start();
    tab.options = { replies: [{ kind: "confirm", text: "About to search your Drive.", button: "Confirm" }] };
    const answer = said(await call(harness, "chatgpt_send", { prompt: "Find the deck.", account: "chatgpt-main" }));
    expect(answer).toContain(`ChatGPT is waiting for the person to press "Confirm" in the browser's tab (account "chatgpt-main"). This kit never presses ChatGPT's own confirmations`);
    expect(answer).toContain('call `request_help` on the `accounts` server (`mcp__accounts__request_help`) with account "chatgpt-main"');
    const again = said(await call(harness, "chatgpt_read", { chat: CHAT_ID, wait: 1 }));
    expect(again).toContain(`ChatGPT is waiting for the person to press "Confirm" in the browser's tab (account "chatgpt-main").`);
    expect(tab.fake?.confirmed).toBe(false);
    expect(tab.fake?.sent).toEqual(["Find the deck."]);
    expect(tab.lingered).toBe(0);
});

test("a file goes into ChatGPT through the page's own file chooser: a click on the tools button, one on its upload item, then browser_file_upload", async () => {
    const harness = await start();
    const shelf = join(harness.root, SHELF_REL);
    await mkdir(shelf, { recursive: true });
    await writeFile(join(shelf, "brief.md"), "# Brief\n");
    await writeFile(join(harness.root, "notes.md"), "private\n");
    const off = await call(harness, "chatgpt_send", { prompt: "Summarize.", files: [join(harness.root, "notes.md")] });
    expect(off.isError).toBe(true);
    expect(said(off)).toContain(`${join(harness.root, "notes.md")} is not on the artifacts shelf.`);
    expect(said(off)).toContain("Nothing was sent.");
    expect(tab.calls).toEqual([]);
    tab.options = { replies: [{ kind: "text", text: "Read." }] };
    const answer = said(await call(harness, "chatgpt_send", { prompt: "Summarize.", files: [join(shelf, "brief.md")] }));
    expect(answer).toContain("ChatGPT wrote:\nRead.");
    expect(tab.fake?.attached).toEqual(["brief.md"]);
    expect(tab.fake?.sent).toEqual(["Summarize."]);
    // The chooser's own tool answered it straight after the click that opened it, and nothing was run past the page's
    // own tools.
    const clicked = tab.calls.lastIndexOf("browser_click");
    expect(tab.calls.slice(clicked, clicked + 2)).toEqual(["browser_click", "browser_file_upload"]);
    expect(tab.calls.filter((each) => each === "browser_click")).toHaveLength(2);
    expect(tab.calls).not.toContain("browser_run_code_unsafe");
    const uploaded = harness.extension.browserCalls.find((each) => each.tool === "browser_file_upload");
    expect(uploaded?.args).toEqual({ paths: [join(shelf, "brief.md")] });
    // No mark of the kit's is left on the page.
    expect(document.querySelector("[data-intentic-chatgpt-click]")).toBeNull();
});

test("a page that opens no file chooser refuses the send with nothing sent and its menu closed", async () => {
    const harness = await start();
    const shelf = join(harness.root, SHELF_REL);
    await mkdir(shelf, { recursive: true });
    await writeFile(join(shelf, "brief.md"), "# Brief\n");
    tab.options = { replies: [{ kind: "text", text: "Read." }] };
    load("https://chatgpt.com/");
    // ChatGPT's upload item gone from its menu, as after a redesign.
    const observer = new MutationObserver(() => {
        for (const item of Array.from(document.querySelectorAll('[role="menuitem"]'))) {
            if (/Add photos/u.test(item.textContent ?? "")) {
                item.remove();
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
        const refused = await call(harness, "chatgpt_send", { prompt: "Summarize.", files: [join(shelf, "brief.md")] });
        expect(refused.isError).toBe(true);
        expect(said(refused)).toContain(`Nothing was sent: ChatGPT's tools menu has no "Add photos & files" item.`);
        expect(tab.fake?.sent).toEqual([]);
        expect(tab.calls).toContain("browser_press_key");
        expect(document.querySelector('[role="menu"]')).toBeNull();
    } finally {
        observer.disconnect();
    }
});

test("a picture ChatGPT made in the account's browser is fetched in the page and saved on the shelf under the kit's own directory", async () => {
    const harness = await start();
    tab.options = { replies: [{ kind: "image", src: `data:image/png;base64,${PIXEL}`, text: "Here it is." }] };
    const answer = said(await call(harness, "chatgpt_image", { prompt: "Watercolor fox.", name: "fox" }, { conversationId: "c-1" }));
    const saved = join(harness.root, CHATGPT_SAVED_REL, "fox.png");
    expect(answer).toContain(`Made 1 image with ChatGPT and saved it:\n- ${saved} (${Buffer.from(PIXEL, "base64").byteLength} bytes, image/png, 1672×941)`);
    expect((await readFile(saved)).toString("base64")).toBe(PIXEL);
    // A sandbox browser closes with its turn, so its image is made in the call, not as a job.
    expect(harness.extension.jobs).toEqual([]);
});

test("in the person's own browser, chatgpt_send and chatgpt_read are that browser's own tools through api.ownerBrowser, arguments as the agent sent them", async () => {
    const asked: FakeOwnerBrowserCall[] = [];
    const harness = await start({
        grants: HOLDS_CHROME,
        ownerBrowser: (owner) => {
            asked.push(owner);
            return text(`ChatGPT answered in tab 101.\nChat: "${CHAT_ID}".`);
        },
    });
    const sent = await call(harness, "chatgpt_send", { prompt: "Second opinion?", browser: "chrome", files: [`${SHELF_REL}/a.pdf`] }, { conversationId: "c-1" });
    expect(said(sent)).toBe(`ChatGPT answered in tab 101.\nChat: "${CHAT_ID}".`);
    await call(harness, "chatgpt_read", { chat: CHAT_ID, wait: 30, browser: "chrome" }, { conversationId: "c-1" });
    expect(asked).toEqual([
        { browser: "chrome", tool: "chatgpt_send", args: { prompt: "Second opinion?", files: [`${SHELF_REL}/a.pdf`] }, conversationId: "c-1" },
        { browser: "chrome", tool: "chatgpt_read", args: { chat: CHAT_ID, wait: 30 }, conversationId: "c-1" },
    ]);
    // A refusal the browser gives comes back as the tool's own.
    const refusing = await start({ grants: HOLDS_CHROME, ownerBrowser: () => text("chatgpt.com is not allowed in read and act.", true) });
    const refused = await call(refusing, "chatgpt_read", { chat: CHAT_ID, browser: "chrome" }, { conversationId: "c-1" });
    expect(refused).toEqual({ content: [{ type: "text", text: "chatgpt.com is not allowed in read and act." }], isError: true });
    expect([harness.extension.browserCalls, harness.extension.jobs]).toEqual([[], []]);
});

test("chatgpt_image in the person's browser is a job filed through api.jobs: answered with its id at once, its picture collected with wait", async () => {
    const image = Promise.withResolvers<ToolResult>();
    const harness = await start({ grants: HOLDS_CHROME, ownerBrowser: async () => await image.promise });
    const answer = said(await call(harness, "chatgpt_image", { prompt: "Watercolor fox.", chat: `https://chatgpt.com/c/${CHAT_ID}`, browser: "chrome" }, { conversationId: "c-1" }));
    expect(answer).toContain('Started: job "job-1". ChatGPT is making this image in the person\'s browser, and nothing here waits on it.');
    expect(answer).toContain('target "job-1"');
    const [job] = harness.extension.jobs;
    expect(job).toMatchObject({
        conversationId: "c-1",
        command: 'chatgpt_image "Watercolor fox."',
        description: "ChatGPT image: Watercolor fox.",
        lane: { name: "images:chrome", key: CHAT_ID, most: 2 },
    });
    expect(harness.extension.ownerBrowserCalls).toEqual([{ browser: "chrome", tool: "chatgpt_image", args: { prompt: "Watercolor fox.", chat: `https://chatgpt.com/c/${CHAT_ID}` }, conversationId: "c-1" }]);
    image.resolve(text(`Made 1 image with ChatGPT and saved it:\n- ${SHELF_REL}/chrome/fox.png`));
    expect(await harness.extension.jobEnd("job-1")).toEqual({ ok: true, output: `Made 1 image with ChatGPT and saved it:\n- ${SHELF_REL}/chrome/fox.png` });
    expect(harness.extension.jobs[0]?.lines[0]).toMatch(/^Its turn came at \d\d:\d\d:\d\d UTC: sent to the browser\.$/u);
});

test("an image the person's browser refuses at once is the call's own answer, and one with no conversation to wake is made in the call", async () => {
    const refusing = await start({ grants: HOLDS_CHROME, ownerBrowser: () => text("This browser is paused.", true) });
    const refused = await call(refusing, "chatgpt_image", { prompt: "A fox.", browser: "chrome" }, { conversationId: "c-1" });
    expect(refused).toEqual({ content: [{ type: "text", text: "This browser is paused." }], isError: true });
    expect(await refusing.extension.jobEnd("job-1")).toEqual({ ok: false, output: "This browser is paused." });
    const inCall = await start({ grants: HOLDS_CHROME, ownerBrowser: () => text("Made 1 image with ChatGPT.") });
    expect(said(await call(inCall, "chatgpt_image", { prompt: "A fox.", browser: "chrome" }))).toBe("Made 1 image with ChatGPT.");
    expect(inCall.extension.jobs).toEqual([]);
});
