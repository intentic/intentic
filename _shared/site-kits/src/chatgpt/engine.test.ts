import { runInThisContext } from "node:vm";
import type { JsonValue } from "@intentic/base/json";
import { dom } from "@intentic/testing/dom";
import { KitRefusal, type PageCall, type SavedFile } from "../host.js";
import { chatgptRead, chatgptSend } from "./answers.js";
import type { ChatTiming } from "./engine.js";
import { CHAT_ID, type FakeAccount, type FakeChatgpt, type FakeOptions, fakePageAt, giveEveryElementABox, mountFakeChatgpt } from "./fake-chatgpt.testing.js";
import type { ChatgptHost, ChatgptVoice } from "./host.js";
import { chatgptImage } from "./image.js";

// The engine on a host with no Chrome in it, shaped the way the sandbox's own browser will run it: one tab, no window
// or tab bookkeeping, every step handed over as a function's source text and JSON arguments and evaluated in the page's
// own world with its helpers taken away again, files as paths, memory as JSON. The extension's host is proven end to end
// in its own suites (_devices/webext, chat.test.ts and image.test.ts); this proves the engine asks nothing more of one.

const FAST: ChatTiming = { capMs: 4000, roundMs: 400, settleMs: 30, readyMs: 300, stepMs: 300, silentMs: 1000, retryMs: 5, uploadMs: 300 };
const PROJECT_CHAT = `https://chatgpt.com/g/g-p-6a1b2c0-intentic-studio/c/${CHAT_ID}`;

const VOICE: ChatgptVoice = {
    page: () => "the sandbox's ChatGPT tab",
    browser: "the sandbox's browser",
    snapshotTool: "browser_snapshot",
    saveTool: "browser_take_screenshot",
    signedIn: "the sandbox's own browser",
    window: "its ChatGPT tab",
    sendAccess: "",
    imageAccess: "",
    asking: "The owner can open that tab from the Browsers view.",
};

interface OneTab {
    url: string;
    options: FakeOptions;
    account: FakeAccount;
    fake: FakeChatgpt | undefined;
    memory: Map<string, JsonValue>;
    // What the host was asked to do, in order: each step's function name, and its own calls.
    log: string[];
}
let tab: OneTab;

const load = (url: string): void => {
    tab.url = url;
    const kind = fakePageAt(url, tab.account);
    if (kind !== undefined) {
        tab.fake = mountFakeChatgpt({
            ...tab.options,
            ...kind,
            account: tab.account,
            onRoute: (path) => {
                tab.url = `https://chatgpt.com${path}`;
            },
            onNavigate: (path) => load(`https://chatgpt.com${path}`),
        });
    }
};

// A function as Playwright's evaluate gets it: its source text alone, with its arguments through JSON. A step that
// reached for anything outside itself would throw here, and so would an argument JSON does not carry.
const evaluate = async <Result>(call: PageCall<Result>): Promise<Awaited<Result>> => {
    // SAFETY: a page function's source text evaluates to that same function, and pageCall checked its arguments.
    const func = runInThisContext(`(${call.func.toString()})`) as (...args: readonly JsonValue[]) => Result;
    // SAFETY: the arguments are the JSON values a host sends; JSON.parse of their text gives them back.
    return await func(...(JSON.parse(JSON.stringify(call.args)) as JsonValue[]));
};

const host: ChatgptHost<string> = {
    voice: VOICE,
    gate: async () => undefined,
    permit: async () => undefined,
    open: async (url) => {
        load(url);
        return { page: 1, afterword: "" };
    },
    take: async () => undefined,
    busy: () => false,
    done: async () => undefined,
    forget: async () => undefined,
    address: async () => tab.url,
    navigate: async (_page, url) => load(url),
    run: async (_page, { helpers, step, cleanup }) => {
        tab.log.push(step.func.name);
        try {
            for (const helper of helpers) {
                await evaluate(helper);
            }
            return (await evaluate(step)) ?? undefined;
        } finally {
            await evaluate(cleanup);
        }
    },
    announce: () => undefined,
    confirmSend: async () => undefined,
    collectFiles: async (given) => given,
    allowFiles: async (_page, _url, files) => {
        tab.log.push(`allow ${files.join(", ")}`);
    },
    attachFiles: async (_page, files) => {
        tab.log.push(`attach ${files.join(", ")}`);
    },
    saveImage: async (_page, _src, stem): Promise<SavedFile> => ({ path: `shelf/${stem}.png`, bytes: 2_934_112, mimeType: "image/png" }),
    saveText: async (text, stem): Promise<SavedFile> => ({ path: `shelf/${stem}.md`, bytes: text.length, mimeType: "text/markdown" }),
    sandboxName: async () => "studio",
    recall: async (name) => tab.memory.get(name),
    keep: async (name, value) => {
        tab.memory.set(name, value);
    },
};

beforeAll(() => {
    dom.reconfigure({ url: "https://chatgpt.com/" });
});
afterAll(() => {
    dom.reconfigure({ url: "http://localhost:3000" });
});

beforeEach(() => {
    giveEveryElementABox();
    window.intenticChatgpt = undefined;
    tab = { url: "about:blank", options: {}, account: { projects: [] }, fake: undefined, memory: new Map(), log: [] };
});

const ask = async (prompt: string, more: Partial<Parameters<typeof chatgptSend>[1]> = {}): Promise<string> =>
    await chatgptSend(host, { prompt, mode: "chat", files: [], personalized: false, temporary: false, ...more }, FAST);

test("a first prompt makes the sandbox's project and answers in a chat there, named the host's way, and the helpers never stay", async () => {
    tab.options = { replies: [{ kind: "text", text: "Option B." }] };
    const answer = await ask("Compare A and B.");
    expect(answer).toContain(`ChatGPT answered.\nChat: "${CHAT_ID}" (in this sandbox's ChatGPT project), in the sandbox's ChatGPT tab, ${PROJECT_CHAT}.`);
    expect(answer).toContain(`Made the ChatGPT project "Intentic · studio" for this sandbox's chats, with project-only memory.`);
    expect(answer).toContain("ChatGPT wrote:\nOption B.");
    expect(tab.memory.get("project")).toEqual({ url: "https://chatgpt.com/g/g-p-6a1b2c0-intentic-studio/project", name: "Intentic · studio", memory: true, instructions: true });
    expect(tab.memory.get("chats")).toEqual([{ chat: CHAT_ID, tabId: 1, url: PROJECT_CHAT, home: "project" }]);
    expect(window.intenticChatgpt).toBeUndefined();
});

test("files are the host's own: allowed and attached through it after the mode is chosen, before the prompt is typed", async () => {
    tab.options = { replies: [{ kind: "text", text: "Read." }] };
    await ask("Summarize these.", { files: ["shelf/brief.pdf", "shelf/notes.md"], mode: "deep_research" });
    const files = "shelf/brief.pdf, shelf/notes.md";
    const around = tab.log.filter((entry) => !entry.endsWith("Step") || entry === "modeStep" || entry === "composeStep");
    expect(around).toEqual(["modeStep", `allow ${files}`, `attach ${files}`, "composeStep"]);
});

test("an answer waiting on ChatGPT's own button is reported as asking, pressed by nobody, and read again in the same chat", async () => {
    tab.options = { replies: [{ kind: "confirm", text: "About to search your Drive.", button: "Confirm" }] };
    const answer = await ask("Find the deck.");
    expect(answer).toContain(`ChatGPT is waiting for the person to press "Confirm" in the sandbox's ChatGPT tab. This kit never presses ChatGPT's own confirmations`);
    expect(answer).toContain(`Do not send the prompt again. The owner can open that tab from the Browsers view.`);
    expect(tab.fake?.confirmed).toBe(false);
    expect(await chatgptRead(host, { chat: CHAT_ID, waitSeconds: 1 }, FAST)).toContain(`ChatGPT is waiting for the person to press "Confirm"`);
    expect(tab.fake?.sent).toEqual(["Find the deck."]);
});

test("a refusal is a KitRefusal in the host's words, and nothing is typed on a signed-out page", async () => {
    tab.options = { signedOut: true };
    const call = chatgptImage(host, { prompt: "A cat.", personalized: false, temporary: true }, FAST);
    await expect(call).rejects.toBeInstanceOf(KitRefusal);
    await expect(call).rejects.toThrow(`ChatGPT is not signed in in the sandbox's browser: it shows "Log in".`);
    expect(tab.log).not.toContain("composeStep");
});
