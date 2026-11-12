import { dom } from "@intentic/testing/dom";
import { store } from "../../store.js";
import { CHAT_ID, type FakeOptions, giveEveryElementABox, mountFakeChatgpt, type Reply } from "./fake-chatgpt.testing.js";
import type { ImageTiming } from "./image.js";

// chatgpt_image end to end in the worker: the gates, the tab it works in, the steps in order, the route change on send,
// and what the agent is told. Chrome is a hand-written fake whose executeScript runs each injected function against
// jsdom's document, where a stand-in for ChatGPT's page answers (fake-chatgpt.testing.ts). The saving is stream B's
// module, faked here: this suite is about getting the picture's address, not about moving its bytes.

const SANDBOX = "https://sandbox-1.example.dev";
const IMAGE_SRC = "https://chatgpt.com/backend-api/estuary/content?id=file_00000000aa";

interface Saved {
    readonly tabId: number;
    readonly url: string;
    readonly name: string;
}
let saved: Saved[] = [];
jest.mock("../../tools/media.js", () => ({
    saveMediaFromTab: async (_from: string, tabId: number, url: string, name: string) => {
        saved.push({ tabId, url, name });
        return { path: `/work/.intentic/records/artifacts/chrome/${name}.png`, bytes: 2_934_112, mimeType: "image/png" };
    },
}));
const { chatgptImage } = await import("./image.js");
const { handleMcpMessage } = await import("../../mcp.js");

const FAST: ImageTiming = { capMs: 4000, roundMs: 400, settleMs: 30, readyMs: 300, stepMs: 300, silentMs: 1000, retryMs: 5 };

// The kit installs nothing on a page that is not chatgpt.com (page-hands.ts), so jsdom's document is put there.
beforeAll(() => {
    dom.reconfigure({ url: "https://chatgpt.com/" });
});
afterAll(() => {
    dom.reconfigure({ url: "http://localhost:3000" });
});

interface FakeTab {
    id: number;
    windowId: number;
    active: boolean;
    url: string;
}

let tabs: FakeTab[] = [];
let created: string[] = [];
let injected: string[] = [];
// The send step's answer is lost, as when ChatGPT's route change replaced the document under it.
let loseSendAnswer = false;
// How many watch rounds in a row the page fails to answer at once, as a page mid-reload does.
let lostWatches = 0;
let page: FakeOptions = {};
let fake: ReturnType<typeof mountFakeChatgpt> | undefined;
const loaded: ((id: number, change: { status?: string }) => void)[] = [];

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

// A tab pointed at chatgpt.com gets the stand-in page; its address moves when the page says it routed.
const load = (tab: FakeTab): void => {
    if (new URL(tab.url).host === "chatgpt.com" && !tab.url.includes("/c/")) {
        fake = mountFakeChatgpt({
            ...page,
            onRoute: (path) => {
                tab.url = `https://chatgpt.com${path}`;
            },
        });
    }
    setTimeout(() => {
        for (const listener of loaded) {
            listener(tab.id, { status: "complete" });
        }
    }, 0);
};

// What an injected function hands back: a step's answer, an installer's true, or nothing.
type Answer = object | boolean | null;

const install = (): void => {
    const windowOf = (id: number) => ({ id, focused: false, state: "normal", tabs: tabs.filter((tab) => tab.windowId === id).map((tab) => ({ ...tab })) });
    const chrome = {
        storage: { local: area(new Map()), session: area(new Map<string, unknown>([["agentWindows", { [SANDBOX]: 1 }]])) },
        tabs: {
            query: async () => tabs.filter((tab) => tab.active).map((tab) => ({ ...tab })),
            get: async (id: number) => {
                const tab = tabs.find((each) => each.id === id);
                return tab === undefined ? Promise.reject(new Error(`No tab with id: ${id}`)) : { ...tab };
            },
            create: async (properties: { url: string; active?: boolean; windowId?: number }) => {
                created.push(properties.url);
                const windowId = properties.windowId ?? 1;
                if (properties.active === true) {
                    for (const tab of tabs.filter((each) => each.windowId === windowId)) {
                        tab.active = false;
                    }
                }
                const tab = { id: 100 + tabs.length, windowId, active: properties.active === true, url: properties.url };
                tabs.push(tab);
                load(tab);
                return { ...tab };
            },
            update: async (id: number, properties: { url?: string; active?: boolean }) => {
                const tab = tabs.find((each) => each.id === id);
                if (tab === undefined) {
                    throw new Error(`No tab with id: ${id}`);
                }
                if (properties.active === true) {
                    for (const other of tabs.filter((each) => each.windowId === tab.windowId)) {
                        other.active = other === tab;
                    }
                }
                if (properties.url !== undefined) {
                    tab.url = properties.url;
                    load(tab);
                }
                return { ...tab };
            },
            remove: async (id: number) => {
                tabs = tabs.filter((tab) => tab.id !== id);
            },
            onUpdated: {
                addListener: (listener: (id: number, change: { status?: string }) => void) => loaded.push(listener),
                removeListener: (listener: (id: number, change: { status?: string }) => void) => loaded.splice(loaded.indexOf(listener), 1),
            },
        },
        windows: { get: async (id: number) => windowOf(id) },
        permissions: { contains: async (request: { origins?: string[] }) => (request.origins ?? []).every((origin) => origin === "https://chatgpt.com/*") },
        action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined, openPopup: async () => undefined },
        runtime: { getManifest: () => ({ version: "0.0.0" }) },
        scripting: {
            executeScript: async (injection: { target: { tabId: number }; func: (...args: never[]) => Promise<Answer> | Answer; args?: never[] }) => {
                // The banner (page/overlay.ts) is the person's to see, not this page's to answer.
                if (injection.func.name === "flashBanner") {
                    return [{ frameId: 0, result: null }];
                }
                injected.push(injection.func.name);
                const result = await injection.func(...(injection.args ?? []));
                if (injection.func.name === "watchStep" && lostWatches > 0) {
                    lostWatches -= 1;
                    return [{ frameId: 0, result: null }];
                }
                return [{ frameId: 0, result: loseSendAnswer && injection.func.name === "sendStep" ? null : result }];
            },
        },
    };
    Object.assign(globalThis, { chrome });
};

const replying = (...replies: Reply[]): void => {
    page = { replies };
};

beforeEach(async () => {
    giveEveryElementABox();
    window.intenticChatgpt = undefined;
    document.body.innerHTML = "";
    tabs = [{ id: 7, windowId: 1, active: true, url: "https://docs.example/notes" }];
    created = [];
    injected = [];
    saved = [];
    loseSendAnswer = false;
    lostWatches = 0;
    page = {};
    fake = undefined;
    install();
    await store.setScopes(SANDBOX, { read: "on", act: "on", screenshot: "off", cookies: "off", scripts: "off", confirm: "sensitive" });
    await store.setMode("https://chatgpt.com/*", "act");
});

test("one call opens a temporary chat, unpersonalizes it, sends the prompt once, and saves the picture it makes", async () => {
    replying({ kind: "image", src: IMAGE_SRC, text: "Here is the frame." });
    const answer = await chatgptImage(SANDBOX, { prompt: "Watercolor storyboard frame: a fox on a snowy bridge.", name: "keyframe-01", personalized: false }, FAST);

    expect(created).toEqual(["https://chatgpt.com/?temporary-chat=true"]);
    expect(fake?.personalization).toBe("unpersonalized");
    expect(fake?.sent).toEqual(["Watercolor storyboard frame: a fox on a snowy bridge."]);
    expect(saved).toEqual([{ tabId: 101, url: IMAGE_SRC, name: "keyframe-01" }]);
    expect(answer).toContain("/work/.intentic/records/artifacts/chrome/keyframe-01.png (2.9 MB, image/png, 1672×941)");
    expect(answer).toContain(`Chat: "${CHAT_ID}" (a temporary chat, unpersonalized), in tab 101`);
    expect(answer).toContain("Here is the frame.");
    // The agent's own tab has the front of its window back, so its next `open` does not land on the chat.
    expect(tabs.find((tab) => tab.id === 7)?.active).toBe(true);
    // The chat's tab stays open: a temporary chat lives only there.
    expect(tabs.some((tab) => tab.id === 101)).toBe(true);
    // The order the page was driven in: personalization before a word is typed.
    expect(injected.filter((name) => name.endsWith("Step"))).toEqual(
        expect.arrayContaining(["readyStep", "personalizationStep", "inspectStep", "composeStep", "sendStep", "watchStep"]),
    );
    expect(injected.indexOf("personalizationStep")).toBeLessThan(injected.indexOf("composeStep"));
});

test("a send whose answer is lost to ChatGPT's route change is not a failure, and is not sent again", async () => {
    replying({ kind: "image", src: IMAGE_SRC });
    loseSendAnswer = true;
    const answer = await chatgptImage(SANDBOX, { prompt: "Ink sketch: a lighthouse in fog.", personalized: false }, FAST);
    expect(fake?.sent).toEqual(["Ink sketch: a lighthouse in fog."]);
    expect(tabs.find((tab) => tab.id === 101)?.url).toBe(`https://chatgpt.com/c/${CHAT_ID}`);
    expect(answer).toContain("Made 1 image with ChatGPT");
});

test("the next image continues in the same chat's tab, without a new tab and without touching personalization", async () => {
    replying({ kind: "image", src: IMAGE_SRC }, { kind: "image", src: `${IMAGE_SRC}2` });
    await chatgptImage(SANDBOX, { prompt: "Watercolor: a fox.", personalized: false }, FAST);
    const presses = injected.filter((name) => name === "personalizationStep").length;
    const second = await chatgptImage(SANDBOX, { prompt: "Same style: the fox asleep.", chat: CHAT_ID, personalized: false }, FAST);
    expect(created).toHaveLength(1);
    expect(injected.filter((name) => name === "personalizationStep")).toHaveLength(presses);
    expect(fake?.sent).toEqual(["Watercolor: a fox.", "Same style: the fox asleep."]);
    expect(saved.at(-1)).toMatchObject({ url: `${IMAGE_SRC}2` });
    expect(second).toContain(`Chat: "${CHAT_ID}"`);
});

test("a temporary chat whose tab has moved on is refused as gone, with what to do instead, and nothing is sent", async () => {
    replying({ kind: "image", src: IMAGE_SRC });
    await chatgptImage(SANDBOX, { prompt: "Watercolor: a fox.", personalized: false }, FAST);
    const chatTab = tabs.find((tab) => tab.id === 101);
    if (chatTab !== undefined) {
        chatTab.url = "https://chatgpt.com/";
    }
    await expect(chatgptImage(SANDBOX, { prompt: "Again.", chat: CHAT_ID, personalized: false }, FAST)).rejects.toThrow(/is gone.*call chatgpt_image without `chat`/s);
    expect(fake?.sent).toHaveLength(1);
});

test("a refusal answers with ChatGPT's words and the chat, and saves nothing", async () => {
    replying({ kind: "text", text: "I can't create that image because it violates our content policy." });
    const call = chatgptImage(SANDBOX, { prompt: "Something it refuses.", personalized: false }, FAST);
    await expect(call).rejects.toThrow("violates our content policy");
    await expect(call).rejects.toThrow(`chat "${CHAT_ID}"`);
    expect(saved).toEqual([]);
});

test("a picture still not done at the cap ends the call with the chat kept and a warning not to send again", async () => {
    replying({ kind: "never" });
    const call = chatgptImage(SANDBOX, { prompt: "A slow one.", personalized: false }, { ...FAST, capMs: 600, roundMs: 200 });
    await expect(call).rejects.toThrow("The prompt was sent: do not send it again");
    expect(fake?.sent).toEqual(["A slow one."]);
});

// Resolves once the stand-in page has taken the prompt, so a test can change the browser while ChatGPT works.
const untilSent = async (): Promise<void> => {
    while ((fake?.sent.length ?? 0) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

test("a grant withdrawn while ChatGPT works ends the wait, and the agent is told the prompt went, so it does not send it again", async () => {
    replying({ kind: "never" });
    const call = chatgptImage(SANDBOX, { prompt: "A slow one.", personalized: false }, { ...FAST, capMs: 3000, roundMs: 200 });
    await untilSent();
    await store.forgetMode("https://chatgpt.com/*");
    await expect(call).rejects.toThrow(/Not allowed on chatgpt\.com.*may already have gone to ChatGPT in tab 101: do not send it again/s);
    expect(fake?.sent).toEqual(["A slow one."]);
});

test("a tab moved on to another chat mid-answer ends the wait, rather than saving that chat's pictures as this answer", async () => {
    replying({ kind: "never" });
    const call = chatgptImage(SANDBOX, { prompt: "A slow one.", personalized: false }, { ...FAST, capMs: 3000, roundMs: 200 });
    await untilSent();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const chatTab = tabs.find((tab) => tab.id === 101);
    if (chatTab !== undefined) {
        chatTab.url = "https://chatgpt.com/c/someone-elses-chat";
    }
    await expect(call).rejects.toThrow(/moved on from its chat.*do not send it again/s);
    expect(saved).toEqual([]);
});

test("nothing opens on a site the person has not allowed: the agent is told to ask for it", async () => {
    await store.forgetMode("https://chatgpt.com/*");
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false }, FAST)).rejects.toThrow("Nothing was opened. Not allowed on chatgpt.com. Call ask_access");
    expect(created).toEqual([]);
});

test("a site allowed for reading only refuses before opening, since the kit types and sends", async () => {
    await store.setMode("https://chatgpt.com/*", "read");
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false }, FAST)).rejects.toThrow("allowed for reading only");
    expect(created).toEqual([]);
});

test("a signed-out ChatGPT is said as such, and nothing is typed", async () => {
    page = { signedOut: true };
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false }, FAST)).rejects.toThrow("not signed in");
    expect(injected).not.toContain("composeStep");
});

test("if the chat cannot be made unpersonalized, nothing is sent", async () => {
    page = { noPersonalization: true };
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false }, FAST)).rejects.toThrow("Nothing was sent: this temporary chat could not be made Unpersonalized");
    expect(fake?.sent).toEqual([]);
    // The tab it opened held nothing worth keeping, so it is closed, and the agent's own tab is in front again.
    expect(tabs.map((tab) => tab.id)).toEqual([7]);
    expect(tabs[0]?.active).toBe(true);
});

test("one of the account's own chats is refused unless personalized, since its memory and history apply there", async () => {
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", chat: "68f0a1b2-0000-8000-9000-aaaaaaaaaaaa", personalized: false }, FAST)).rejects.toThrow(
        /one of the ChatGPT account's own chats.*Nothing was opened or sent/s,
    );
    expect(created).toEqual([]);
});

test("rounds the page fails to answer at once are counted by time, so a page reloading for a moment does not end the call", async () => {
    replying({ kind: "image", src: IMAGE_SRC });
    // More lost rounds than the six a count of rounds allowed, each failing at once.
    lostWatches = 8;
    expect(await chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false }, { ...FAST, capMs: 10_000, silentMs: 8000 })).toContain("Made 1 image with ChatGPT");
});

test("a page that stays silent past the allowance ends the call, telling the agent the prompt may have gone", async () => {
    replying({ kind: "never" });
    lostWatches = 1_000_000;
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false }, { ...FAST, silentMs: 200 })).rejects.toThrow("do not send it again");
});

test("the tool is on the extension's surface, so the sandbox relays it to agents with the rest", async () => {
    // SAFETY: a tools/list is always answered with a result holding the tool list (peer-mcp-server.ts).
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, SANDBOX)) as { result: { tools: { name: string }[] } };
    expect(answer.result.tools.map((tool) => tool.name)).toContain("chatgpt_image");
});
