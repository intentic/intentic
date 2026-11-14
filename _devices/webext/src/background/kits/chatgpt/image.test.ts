import { dom } from "@intentic/testing/dom";
import { store } from "../../store.js";
import { CHAT_ID, type Reply } from "./fake-chatgpt.testing.js";
import type { ImageTiming } from "./image.js";
import { kitBrowser, resetKitBrowser, SANDBOX, untilSent } from "./kit-chrome.testing.js";

// chatgpt_image end to end in the worker: the gates, the tab it works in, the steps in order, the route change on send,
// and what the agent is told. The browser is kit-chrome.testing.ts's. The saving is stream B's module, faked here: this
// suite is about getting the picture's address, not about moving its bytes.
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

const FAST: ImageTiming = { capMs: 4000, roundMs: 400, settleMs: 30, readyMs: 300, stepMs: 300, silentMs: 1000, retryMs: 5, uploadMs: 300 };

// The kit installs nothing on a page that is not chatgpt.com (page-hands.ts), so jsdom's document is put there.
beforeAll(() => {
    dom.reconfigure({ url: "https://chatgpt.com/" });
});
afterAll(() => {
    dom.reconfigure({ url: "http://localhost:3000" });
});

const replying = (...replies: Reply[]): void => {
    kitBrowser.page = { replies };
};

beforeEach(async () => {
    saved = [];
    await resetKitBrowser();
});

test("one call opens a temporary chat, unpersonalizes it, sends the prompt once, and saves the picture it makes", async () => {
    replying({ kind: "image", src: IMAGE_SRC, text: "Here is the frame." });
    const answer = await chatgptImage(SANDBOX, { prompt: "Watercolor storyboard frame: a fox on a snowy bridge.", name: "keyframe-01", personalized: false, temporary: true }, FAST);

    expect(kitBrowser.created).toEqual(["https://chatgpt.com/?temporary-chat=true"]);
    expect(kitBrowser.fake?.personalization).toBe("unpersonalized");
    expect(kitBrowser.fake?.sent).toEqual(["Watercolor storyboard frame: a fox on a snowy bridge."]);
    expect(saved).toEqual([{ tabId: 101, url: IMAGE_SRC, name: "keyframe-01" }]);
    expect(answer).toContain("/work/.intentic/records/artifacts/chrome/keyframe-01.png (2.9 MB, image/png, 1672×941)");
    expect(answer).toContain(`Chat: "${CHAT_ID}" (a temporary chat, unpersonalized), in tab 101`);
    expect(answer).toContain("Here is the frame.");
    // The agent's own tab has the front of its window back, so its next `open` does not land on the chat.
    expect(kitBrowser.tabs.find((tab) => tab.id === 7)?.active).toBe(true);
    // The chat's tab stays open: a temporary chat lives only there.
    expect(kitBrowser.tabs.some((tab) => tab.id === 101)).toBe(true);
    // The order the page was driven in: personalization before a word is typed.
    expect(kitBrowser.injected.filter((name) => name.endsWith("Step"))).toEqual(
        expect.arrayContaining(["readyStep", "personalizationStep", "inspectStep", "composeStep", "sendStep", "watchStep"]),
    );
    expect(kitBrowser.injected.indexOf("personalizationStep")).toBeLessThan(kitBrowser.injected.indexOf("composeStep"));
});

test("a send whose answer is lost to ChatGPT's route change is not a failure, and is not sent again", async () => {
    replying({ kind: "image", src: IMAGE_SRC });
    kitBrowser.loseSendAnswer = true;
    const answer = await chatgptImage(SANDBOX, { prompt: "Ink sketch: a lighthouse in fog.", personalized: false, temporary: true }, FAST);
    expect(kitBrowser.fake?.sent).toEqual(["Ink sketch: a lighthouse in fog."]);
    expect(kitBrowser.tabs.find((tab) => tab.id === 101)?.url).toBe(`https://chatgpt.com/c/${CHAT_ID}`);
    expect(answer).toContain("Made 1 image with ChatGPT");
});

test("the next image continues in the same chat's tab, without a new tab and without touching personalization", async () => {
    replying({ kind: "image", src: IMAGE_SRC }, { kind: "image", src: `${IMAGE_SRC}2` });
    await chatgptImage(SANDBOX, { prompt: "Watercolor: a fox.", personalized: false, temporary: true }, FAST);
    const presses = kitBrowser.injected.filter((name) => name === "personalizationStep").length;
    const second = await chatgptImage(SANDBOX, { prompt: "Same style: the fox asleep.", chat: CHAT_ID, personalized: false, temporary: true }, FAST);
    expect(kitBrowser.created).toHaveLength(1);
    expect(kitBrowser.injected.filter((name) => name === "personalizationStep")).toHaveLength(presses);
    expect(kitBrowser.fake?.sent).toEqual(["Watercolor: a fox.", "Same style: the fox asleep."]);
    expect(saved.at(-1)).toMatchObject({ url: `${IMAGE_SRC}2` });
    expect(second).toContain(`Chat: "${CHAT_ID}"`);
});

test("a temporary chat whose tab has moved on is refused as gone, with what to do instead, and nothing is sent", async () => {
    replying({ kind: "image", src: IMAGE_SRC });
    await chatgptImage(SANDBOX, { prompt: "Watercolor: a fox.", personalized: false, temporary: true }, FAST);
    const chatTab = kitBrowser.tabs.find((tab) => tab.id === 101);
    if (chatTab !== undefined) {
        chatTab.url = "https://chatgpt.com/";
    }
    await expect(chatgptImage(SANDBOX, { prompt: "Again.", chat: CHAT_ID, personalized: false, temporary: true }, FAST)).rejects.toThrow(/is gone.*Start a new chat \(leave out `chat`\)/s);
    expect(kitBrowser.fake?.sent).toHaveLength(1);
});

test("a refusal answers with ChatGPT's words and the chat, and saves nothing", async () => {
    replying({ kind: "text", text: "I can't create that image because it violates our content policy." });
    const call = chatgptImage(SANDBOX, { prompt: "Something it refuses.", personalized: false, temporary: true }, FAST);
    await expect(call).rejects.toThrow("violates our content policy");
    await expect(call).rejects.toThrow(`chat "${CHAT_ID}"`);
    expect(saved).toEqual([]);
});

test("a picture still not done at the cap ends the call with the chat kept and a warning not to send again", async () => {
    replying({ kind: "never" });
    const call = chatgptImage(SANDBOX, { prompt: "A slow one.", personalized: false, temporary: true }, { ...FAST, capMs: 600, roundMs: 200 });
    await expect(call).rejects.toThrow("The prompt was sent: do not send it again");
    expect(kitBrowser.fake?.sent).toEqual(["A slow one."]);
});

test("a grant withdrawn while ChatGPT works ends the wait, and the agent is told the prompt went, so it does not send it again", async () => {
    replying({ kind: "never" });
    const call = chatgptImage(SANDBOX, { prompt: "A slow one.", personalized: false, temporary: true }, { ...FAST, capMs: 3000, roundMs: 200 });
    await untilSent();
    await store.forgetMode("https://chatgpt.com/*");
    await expect(call).rejects.toThrow(/Not allowed on chatgpt\.com.*may already have gone to ChatGPT in tab 101: do not send it again/s);
    expect(kitBrowser.fake?.sent).toEqual(["A slow one."]);
});

test("a tab moved on to another chat mid-answer ends the wait, rather than saving that chat's pictures as this answer", async () => {
    replying({ kind: "never" });
    const call = chatgptImage(SANDBOX, { prompt: "A slow one.", personalized: false, temporary: true }, { ...FAST, capMs: 3000, roundMs: 200 });
    await untilSent();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const chatTab = kitBrowser.tabs.find((tab) => tab.id === 101);
    if (chatTab !== undefined) {
        chatTab.url = "https://chatgpt.com/c/someone-elses-chat";
    }
    await expect(call).rejects.toThrow(/moved on from its chat.*do not send it again/s);
    expect(saved).toEqual([]);
});

test("nothing opens on a site the person has not allowed: the agent is told to ask for it", async () => {
    await store.forgetMode("https://chatgpt.com/*");
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false }, FAST)).rejects.toThrow("Nothing was opened. Not allowed on chatgpt.com. Call ask_access");
    expect(kitBrowser.created).toEqual([]);
});

test("a site allowed for reading only refuses before opening, since the kit types and sends", async () => {
    await store.setMode("https://chatgpt.com/*", "read");
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false }, FAST)).rejects.toThrow("allowed for reading only");
    expect(kitBrowser.created).toEqual([]);
});

test("a signed-out ChatGPT is said as such, and nothing is typed", async () => {
    kitBrowser.page = { signedOut: true };
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false }, FAST)).rejects.toThrow("not signed in");
    expect(kitBrowser.injected).not.toContain("composeStep");
});

test("if the chat cannot be made unpersonalized, nothing is sent", async () => {
    kitBrowser.page = { noPersonalization: true };
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false, temporary: true }, FAST)).rejects.toThrow("Nothing was sent: this temporary chat could not be made Unpersonalized");
    expect(kitBrowser.fake?.sent).toEqual([]);
    // The tab it opened held nothing worth keeping, so it is closed, and the agent's own tab is in front again.
    expect(kitBrowser.tabs.map((tab) => tab.id)).toEqual([7]);
    expect(kitBrowser.tabs[0]?.active).toBe(true);
});

test("one of the account's own chats is refused unless personalized: its address is opened to tell, then closed, and nothing is sent", async () => {
    const own = "68f0a1b2-0000-8000-9000-aaaaaaaaaaaa";
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", chat: own, personalized: false }, FAST)).rejects.toThrow(/one of the ChatGPT account's own chats.*Nothing was sent/s);
    expect(kitBrowser.created).toEqual([`https://chatgpt.com/c/${own}`]);
    expect(kitBrowser.tabs.map((tab) => tab.id)).toEqual([7]);
    expect(kitBrowser.tabs[0]?.active).toBe(true);
});

test("rounds the page fails to answer at once are counted by time, so a page reloading for a moment does not end the call", async () => {
    replying({ kind: "image", src: IMAGE_SRC });
    // More lost rounds than the six a count of rounds allowed, each failing at once.
    kitBrowser.lostWatches = 8;
    expect(await chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false, temporary: true }, { ...FAST, capMs: 10_000, silentMs: 8000 })).toContain("Made 1 image with ChatGPT");
});

test("a page that stays silent past the allowance ends the call, telling the agent the prompt may have gone", async () => {
    replying({ kind: "never" });
    kitBrowser.lostWatches = 1_000_000;
    await expect(chatgptImage(SANDBOX, { prompt: "A cat.", personalized: false, temporary: true }, { ...FAST, silentMs: 200 })).rejects.toThrow("do not send it again");
});

test("the kit's tools are on the extension's surface, so the sandbox relays them to agents with the rest", async () => {
    // SAFETY: a tools/list is always answered with a result holding the tool list (peer-mcp-server.ts).
    const answer = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, SANDBOX)) as { result: { tools: { name: string }[] } };
    expect(answer.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["chatgpt_image", "chatgpt_send", "chatgpt_read"]));
});
