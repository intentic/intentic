import type { JsonValue } from "@intentic/base/json";
import type { Need, PageStep, SavedFile } from "../host.js";

// A CHATGPT HOST is the browser the ChatGPT kit runs in (2026-11-14). The engine (engine.ts) decides every step in the
// page and every word the agent reads; a host does only what its own browser does differently. Two hosts are meant:
// THE EXTENSION (_devices/webext: the person's own signed-in Chrome, from its service worker) and THE SANDBOX'S BROWSER
// (Playwright, through @playwright/mcp from the sandbox's daemon). A page is a number the host chose: the extension's
// tab id; the sandbox's one tab per account. What each member is for, and what it means for each:
//
// - voice: the few words an answer or a tool description says differently. Extension: "tab 101", `snapshot`,
//   "this browser". Sandbox: the account's browser and tab, `browser_snapshot`, and `request_help` for the owner to look.
// - gate(need): before anything opens. Extension: not paused, the card's switches, chatgpt.com allowed in read and act.
//   Sandbox: whatever stops its browser, or nothing.
// - permit(page, need): between steps, refusing with KitRefusal (the engine adds that the prompt may have gone).
//   Extension: the same gates for that tab. Sandbox: nothing, or its own stop switch.
// - open(url): a new page for this call, loaded. Extension: a tab beside the agent's own (or in front of the person),
//   its afterword saying when it made the agent a window. Sandbox: the account's tab navigated to `url`, refusing or
//   waiting while another call works in it.
// - take(page) / busy(page) / done(page, keep) / forget(page, showsChat): the rest of a page's life. Extension: a
//   remembered tab brought to the front for the call, refused while another call works in it, the front given back
//   after (a tab this call opened closed again unless `keep`), and an evicted chat's tab closed or made discardable.
//   Sandbox: one tab, so nothing to front, give back or close; busy while a call runs.
// - address(page): where the page is now, "" when the browser hides it (Chrome, for a site the extension has no grant
//   on), undefined once the page is gone. Extension: chrome.tabs.get. Sandbox: location.href through evaluate.
// - navigate(page, url): to `url`, loaded. Extension: chrome.tabs.update. Sandbox: browser_navigate.
// - run(page, step): one step, answering undefined when the page did not answer (replaced mid-call, or it threw), never
//   throwing for it. Extension: each helper, then the step, by chrome.scripting.executeScript in the isolated world,
//   where the helpers may stay. Sandbox: one browser_evaluate in the page's own world with the functions' source text
//   and JSON arguments, helpers first and `cleanup` right after, since the page's scripts could see them.
// - announce(page, message): tells the person what the agent does there. Extension: the banner. Sandbox: nothing.
// - confirmSend(page, url): before anything is typed. Extension: asks the person when the card says every action is
//   asked first. Sandbox: nothing.
// - collectFiles(given) / allowFiles(page, url, files) / attachFiles(page, files): the files to attach, collected
//   before anything slow, allowed, then put into ChatGPT's file input (CHATGPT_PAGE.fileInput). Extension: the
//   daemon's one-minute tickets, the person asked on the page, bytes sent into the input in slices. Sandbox: shelf
//   paths, allowed or refused by the host's own rule, and Playwright's setInputFiles.
// - saveImage(page, src, stem) / saveText(text, stem): a picture on the page or a long answer as Markdown, saved for
//   the agent. Extension: fetched in the tab and handed to the sandbox. Sandbox: written to the shelf directly.
// - sandboxName(): what the sandbox's own ChatGPT project is called after ("Intentic · <name>").
// - recall(name) / keep(name, value): JSON the kit keeps for this sandbox between calls: "chats" (the chats it made or
//   read, with their pages) and "project". Extension: chrome.storage, chats in the session area (tab ids mean nothing
//   after a restart), the project in the local one. Sandbox: a JSON file.
//
// Neither host ever presses ChatGPT's own confirmation buttons: the engine reports that ChatGPT is asking, and the
// person decides. `File` is the host's own: the engine only hands back what collectFiles gave it.

// The words that differ by host; everything else an agent reads is the kit's own (answers.ts, tools.ts).
export interface ChatgptVoice {
    // The page a chat lives in, as an answer names it: "tab 101".
    readonly page: (page: number) => string;
    // The browser ChatGPT is signed in to, as a refusal names it: "this browser".
    readonly browser: string;
    // The agent's own tools for looking at that page and saving a picture from it.
    readonly snapshotTool: string;
    readonly saveTool: string;
    // Tool descriptions: whose browser it is ("the person's own signed-in browser"), where a call opens its chat
    // ("your own window"), and what access chatgpt_send and chatgpt_image need, said the host's way.
    readonly signedIn: string;
    readonly window: string;
    readonly sendAccess: string;
    readonly imageAccess: string;
    // A sentence added where ChatGPT waits on the person to press one of its buttons: how they come to see that page, or
    // "" where they already can (the extension's tab is in their own browser; the sandbox's browser is not in front of
    // anyone until the agent asks for help there).
    readonly asking: string;
}

// What the kit keeps between calls.
export type MemoryName = "chats" | "project";

// A page opened for a call, and what the host adds at the end of a finished answer about it, or "".
export interface OpenedPage {
    readonly page: number;
    readonly afterword: string;
}

export interface ChatgptHost<File = unknown> {
    readonly voice: ChatgptVoice;
    gate(need: Need): Promise<void>;
    permit(page: number, need: Need): Promise<void>;
    open(url: string): Promise<OpenedPage>;
    take(page: number): Promise<void>;
    busy(page: number): boolean;
    done(page: number, keep: boolean): Promise<void>;
    forget(page: number, showsChat: boolean): Promise<void>;
    address(page: number): Promise<string | undefined>;
    navigate(page: number, url: string): Promise<void>;
    run<Result>(page: number, step: PageStep<Result>): Promise<Result | undefined>;
    announce(page: number, message: string): void;
    confirmSend(page: number, url: string): Promise<void>;
    collectFiles(given: readonly string[]): Promise<readonly File[]>;
    allowFiles(page: number, url: string, files: readonly File[]): Promise<void>;
    attachFiles(page: number, files: readonly File[]): Promise<void>;
    saveImage(page: number, src: string, stem: string): Promise<SavedFile>;
    saveText(text: string, stem: string): Promise<SavedFile>;
    sandboxName(): Promise<string>;
    recall(name: MemoryName): Promise<JsonValue | undefined>;
    keep(name: MemoryName, value: JsonValue): Promise<void>;
}
