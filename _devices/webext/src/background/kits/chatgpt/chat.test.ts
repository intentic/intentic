import type { ChatTiming } from "@intentic/site-kits/chatgpt";
import { CHAT_ID, type Reply } from "@intentic/site-kits/chatgpt/testing";
import { dom } from "@intentic/testing/dom";
import { kitBrowser, resetKitBrowser, SANDBOX, untilSent } from "./kit-chrome.testing.js";

// chatgpt_send and chatgpt_read end to end in the worker, on kit-chrome.testing.ts's browser: the sandbox's project
// made, found and reused, the fallback to a temporary chat, a tool chosen, files attached, an answer collected later,
// and what the agent is told. Saving is media.ts's, faked here: this suite is about what reaches the sandbox, not how.

interface Kept {
    readonly name: string;
    readonly type: string;
    readonly text: string;
}
let kept: Kept[] = [];
jest.mock("../../tools/media.js", () => ({
    saveMediaFromTab: async (_from: string, _tabId: number, _url: string, name: string) => ({ path: `/work/.intentic/records/artifacts/chrome/${name}.png`, bytes: 2_934_112, mimeType: "image/png" }),
    saveBytes: async (_from: string, data: Uint8Array, type: string, name: string) => {
        kept.push({ name, type, text: new TextDecoder().decode(data) });
        return { path: `/work/.intentic/records/artifacts/chrome/${name}.md`, bytes: data.byteLength, mimeType: type };
    },
    megabytes: (bytes: number) => `${bytes} bytes`,
    toBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
}));
const { chatgptRead, chatgptSend } = await import("./chrome-host.js");

const FAST: ChatTiming = { capMs: 4000, roundMs: 400, settleMs: 30, readyMs: 300, stepMs: 300, silentMs: 1000, retryMs: 5, uploadMs: 300 };
const PROJECT = "Intentic · studio";
const PROJECT_CHAT = `https://chatgpt.com/g/g-p-6a1b2c0-intentic-studio/c/${CHAT_ID}`;

// jsdom has no DataTransfer; putFile (page/media-driver.ts) needs one to hand a file to an input.
class FakeTransfer {
    readonly files: File[] = [];
    readonly items = { add: (file: File) => this.files.push(file) };
}

beforeAll(() => {
    dom.reconfigure({ url: "https://chatgpt.com/" });
    Object.assign(globalThis, { DataTransfer: globalThis.DataTransfer ?? FakeTransfer });
});
afterAll(() => {
    dom.reconfigure({ url: "http://localhost:3000" });
});

beforeEach(async () => {
    kept = [];
    await resetKitBrowser();
});

const replying = (...replies: Reply[]): void => {
    kitBrowser.page = { replies };
};

const ask = (prompt: string, more: Partial<Parameters<typeof chatgptSend>[1]> = {}, timing = FAST) =>
    chatgptSend(SANDBOX, { prompt, mode: "chat", tickets: [], personalized: false, temporary: false, ...more }, timing);

test("the first send makes the sandbox's project with project-only memory and instructions, and answers in a chat there", async () => {
    replying({ kind: "text", text: "Option B, for three reasons." });
    const answer = await ask("Compare A and B.");

    expect(kitBrowser.account.projects).toEqual([{ id: "6a1b2c0", name: PROJECT, memory: "project", instructions: expect.stringContaining("AI agent working for the account's owner") }]);
    expect(kitBrowser.fake?.sent).toEqual(["Compare A and B."]);
    expect(answer).toContain(`ChatGPT answered.\nChat: "${CHAT_ID}" (in this sandbox's ChatGPT project), in tab 101, ${PROJECT_CHAT}.`);
    expect(answer).toContain(`Made the ChatGPT project "${PROJECT}" for this sandbox's chats, with project-only memory.`);
    expect(answer).toContain("ChatGPT wrote:\nOption B, for three reasons.");
    // A chat in a project has no Personalized menu to touch.
    expect(kitBrowser.injected).not.toContain("personalizationStep");
    expect(kitBrowser.tabs.find((tab) => tab.id === 7)?.active).toBe(true);
});

test("the next new chat goes straight to the remembered project, which is not made again", async () => {
    replying({ kind: "text", text: "First." });
    await ask("One.");
    await ask("Two.");
    expect(kitBrowser.account.projects).toHaveLength(1);
    expect(kitBrowser.injected.filter((name) => name === "createProjectStep")).toHaveLength(1);
    expect(kitBrowser.tabs.find((tab) => tab.id === 102)?.url).toBe(PROJECT_CHAT);
});

test("a project of that name already in the sidebar is used rather than made, and its unchecked memory is said", async () => {
    kitBrowser.account.projects.push({ id: "77aa01", name: PROJECT, memory: "default", instructions: "" });
    replying({ kind: "text", text: "Done." });
    const answer = await ask("Hello.");
    expect(kitBrowser.account.projects).toHaveLength(1);
    expect(kitBrowser.injected).not.toContain("createProjectStep");
    expect(answer).toContain(`Using the ChatGPT project "${PROJECT}". Its memory setting was not checked`);
    expect(answer).toContain(`https://chatgpt.com/g/g-p-77aa01-intentic-studio/c/${CHAT_ID}`);
});

test("with no way to make a project, the chat is temporary and unpersonalized after all, and the agent is told why", async () => {
    kitBrowser.page = { replies: [{ kind: "text", text: "Hi." }], noNewProject: true };
    const answer = await ask("Hello.");
    expect(kitBrowser.fake?.personalization).toBe("unpersonalized");
    expect(answer).toContain(`The ChatGPT project "${PROJECT}" could not be made: ChatGPT's "New project" button is not on the page.`);
    expect(answer).toContain("So this is a temporary, unpersonalized chat instead: apps and connectors are off in it");
    expect(answer).toContain(`(a temporary chat, unpersonalized)`);
});

test("Deep research is chosen before the prompt is typed; a report still coming is collected later with chatgpt_read", async () => {
    kitBrowser.page = { replies: [{ kind: "text", text: "Report: the market grew 12%." }], replyAfterMs: 1500 };
    const started = await ask("Research the market.", { mode: "deep_research", waitSeconds: 0.5 });
    expect(kitBrowser.fake?.mode).toBe("Deep research");
    expect(kitBrowser.injected.indexOf("modeStep")).toBeLessThan(kitBrowser.injected.indexOf("composeStep"));
    expect(started).toContain(
        `ChatGPT is still working after 1 s (it shows "Thinking"). The prompt was sent: do not send it again. Collect the answer with chatgpt_read (chat "${CHAT_ID}", wait up to 540 s a call)`,
    );
    expect(started).toContain("So far it shows:\nThinking");

    const report = await chatgptRead(SANDBOX, { chat: CHAT_ID, waitSeconds: 3 }, FAST);
    expect(report).toContain("ChatGPT answered.");
    expect(report).toContain("ChatGPT wrote:\nReport: the market grew 12%.");
    // Reading sends nothing.
    expect(kitBrowser.fake?.sent).toEqual(["Research the market."]);
});

test("an answer past what a tool answer should carry is saved whole as Markdown, and only its start handed back", async () => {
    const long = `${"Finding. ".repeat(800)}The end.`;
    replying({ kind: "text", text: long });
    const answer = await ask("Write it all.", { name: "report" });
    expect(kept).toEqual([{ name: "report", type: "text/markdown", text: long }]);
    expect(answer).toContain(`ChatGPT's answer is ${long.length} characters, saved whole at /work/.intentic/records/artifacts/chrome/report.md. It begins:`);
    expect(answer).not.toContain("The end.");
});

test("an answer waiting on one of ChatGPT's own buttons is reported, and the kit never presses it", async () => {
    replying({ kind: "confirm", text: "I'm about to search your Google Drive.", button: "Confirm" });
    const answer = await ask("Find the Q3 deck in my Drive.");
    expect(answer).toContain(`ChatGPT is waiting for the person to press "Confirm" in tab 101. This kit never presses ChatGPT's own confirmations`);
    expect(answer).toContain("I'm about to search your Google Drive.");
    expect(kitBrowser.fake?.confirmed).toBe(false);
});

test("files are collected by their tickets, put to the person by name and size, then attached before the prompt goes", async () => {
    kitBrowser.shelf.set("tkt-1", { name: "brief.txt", type: "text/plain", text: "the brief" });
    kitBrowser.shelf.set("tkt-2", { name: "notes.txt", type: "text/plain", text: "notes!" });
    replying({ kind: "text", text: "Read both." });
    await ask("Summarize these.", { tickets: ["tkt-1", "tkt-2"] });
    expect(kitBrowser.asked).toEqual(["Your agent wants to give chatgpt.com 2 files: “brief.txt” (9 bytes), “notes.txt” (6 bytes) from its sandbox. Allow it?"]);
    expect(kitBrowser.fake?.attached).toEqual(["brief.txt", "notes.txt"]);
    expect(kitBrowser.fake?.sent).toEqual(["Summarize these."]);
});

test("a person who says no to the files stops the call before anything is sent, and the tab it opened is closed", async () => {
    kitBrowser.shelf.set("tkt-1", { name: "brief.txt", type: "text/plain", text: "the brief" });
    kitBrowser.allow = false;
    await expect(ask("Summarize this.", { tickets: ["tkt-1"] })).rejects.toThrow(/said no.*“brief\.txt”.*Nothing was sent/s);
    expect(kitBrowser.fake?.attached).toEqual([]);
    expect(kitBrowser.fake?.sent).toEqual([]);
    expect(kitBrowser.tabs.map((tab) => tab.id)).toEqual([7]);
});

test("agent mode the account does not have is refused before anything is sent", async () => {
    kitBrowser.page = { noTools: true };
    await expect(ask("Book a table.", { mode: "agent" })).rejects.toThrow("Nothing was sent: agent mode could not be turned on");
    expect(kitBrowser.fake?.sent).toEqual([]);
});

test("a second prompt into the same chat goes to its tab, and is judged against that chat's own earlier turns", async () => {
    replying({ kind: "text", text: "First answer." }, { kind: "text", text: "Second answer." });
    await ask("One.");
    const second = await ask("Two.", { chat: CHAT_ID });
    expect(kitBrowser.created).toHaveLength(1);
    expect(kitBrowser.fake?.sent).toEqual(["One.", "Two."]);
    expect(second).toContain("ChatGPT wrote:\nSecond answer.");
    expect(second).not.toContain("First answer.");
});

test("reading with no wait still looks: a finished answer is read as it stands", async () => {
    kitBrowser.page = { replies: [{ kind: "text", text: "Done long ago." }], replyAfterMs: 400 };
    await ask("Slow.", { waitSeconds: 0.2 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const read = await chatgptRead(SANDBOX, { chat: CHAT_ID }, FAST);
    expect(read).toContain("ChatGPT answered.");
    expect(read).toContain("ChatGPT wrote:\nDone long ago.");
});

test("reading waits for nothing by default, and says when ChatGPT is still at it", async () => {
    replying({ kind: "never" });
    await ask("Slow.", { waitSeconds: 0.3 });
    await untilSent();
    expect(await chatgptRead(SANDBOX, { chat: CHAT_ID }, FAST)).toContain("ChatGPT is still working");
});
