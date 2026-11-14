import type { PageCall, PageStep } from "@intentic/site-kits";
import {
    CHATGPT_PAGE,
    CHATGPT_SITE,
    type ChatgptHost,
    type ChatgptVoice,
    type ChatTiming,
    chatgptImage as image,
    chatgptRead as read,
    chatgptSend as send,
    type ImageRequest,
    KitRefusal,
    type ReadRequest,
    type SendRequest,
} from "@intentic/site-kits/chatgpt";
import { putFile, receiveFileSlice } from "../../../page/media-driver.js";
import { agentWindow } from "../../agent-window.js";
import { askPerson } from "../../asking.js";
import { assertRunning, assertScope, needsConfirm, RefusedError } from "../../policy.js";
import { type SandboxKey, sandboxName, store } from "../../store.js";
import { megabytes, saveBytes, saveMediaFromTab, toBase64 } from "../../tools/media.js";
import { type Collected, collectFile } from "../../tools/media-tools.js";
import { announce } from "../../tools/page.js";
import { targetTab } from "../../tools/tab-access.js";
import { untilTabLoaded } from "../../tools/tab-loaded.js";
import { assertSiteAllowed, frontKitTab, injectTolerant, type KitPlace, kitStorage, leaveKitTab, openKitTab, releaseKitTab } from "../kit.js";
import { pinFileInputStep } from "./file-steps.js";

// THE CHATGPT KIT'S CHROME HOST (2026-11-14): the person's own signed-in Chrome, driven from this worker, for the kit's
// engine in @intentic/site-kits, which decides every step and every word the agent reads. What is the extension's own
// is here: the gates, the tabs (beside the agent's own, fronted for a call and given back after), steps injected into
// the isolated world, files on the daemon's tickets with the person asked, saving through media.ts, and chrome.storage.
// What each member means is said once, for both hosts, at the top of the kit's host.ts.

// How this browser is named to the agent, in answers and in the tools' descriptions.
export const CHROME_VOICE: ChatgptVoice = {
    page: (page) => `tab ${page}`,
    browser: "this browser",
    snapshotTool: "snapshot",
    saveTool: "save_media",
    signedIn: "the person's own signed-in browser",
    window: "your own window",
    sendAccess:
        "Needs chatgpt.com allowed in read and act; call ask_access if it says so. Files must be on your sandbox's artifacts shelf, and the person is asked on the page before they go.",
    imageAccess: "Needs chatgpt.com allowed in read and act: if it is not, it says so; call ask_access then.",
    // The tab is in the person's own browser, in front of them.
    asking: "",
};

// How long the person has to answer, when the card says every action is asked first, or a file is about to go.
const CONFIRM_TIMEOUT_MS = 120_000;
// One slice of a file into the page per call, as media-tools.ts sends them.
const SLICE_BYTES = 4 * 1024 * 1024;
const WINDOW_NOTE = `(This opened a window of your own, behind the person's, so what they are doing is not interrupted.)`;

// Tabs a call is working in right now: a second prompt into the same chat mid-answer would be judged against the
// first one's baseline.
const busy = new Set<number>();

// Chats in the session area, since tab ids mean nothing after a restart; the project in the local one, for good.
const MEMORY = { chats: kitStorage("session", "chatgpt-chats"), project: kitStorage("local", "chatgpt-project") };

// One function into the tab, with the arguments pageCall bound to it there.
const inject = async <Result>(page: number, call: PageCall<Result>): Promise<Awaited<Result> | undefined> =>
    // SAFETY: a PageCall's func and args were checked against each other where they were bound (pageCall).
    await injectTolerant(page, call.func as (...args: readonly unknown[]) => Result, [...call.args]);

// Asked only when the card says every action is asked first: sending a prompt is not sensitive the way a payment is.
const confirmSend = async (from: SandboxKey, page: number, url: string): Promise<void> => {
    if (!needsConfirm(await store.scopes(from), false)) {
        return;
    }
    if (!(await askPerson(from, { id: page, url }, `Your agent wants to send a prompt to ChatGPT and bring back its answer. Allow it?`, CONFIRM_TIMEOUT_MS))) {
        throw new RefusedError(`The person said no (or did not answer) to sending a prompt to ChatGPT. Do not try another way round it; ask them what they would prefer.`);
    }
};

// Asked every time, whatever their switches say, as upload_file asks: a sandbox file reaching a website is theirs to
// allow.
const allowFiles = async (from: SandboxKey, page: number, url: string, files: readonly Collected[]): Promise<void> => {
    const list = files.map((file) => `“${file.name}” (${megabytes(file.data.byteLength)})`).join(", ");
    const what = `give chatgpt.com ${files.length === 1 ? "the file" : `${files.length} files:`} ${list} from its sandbox`;
    if (!(await askPerson(from, { id: page, url }, `Your agent wants to ${what}. Allow it?`, CONFIRM_TIMEOUT_MS))) {
        throw new RefusedError(`The person said no (or did not answer) to: ${what}. Nothing was sent. Do not try another way round it; ask them what they would prefer.`);
    }
};

// Puts each file into ChatGPT's own file input: the input pinned, the bytes sent in slices, then put into it.
const attachFiles = async (page: number, files: readonly Collected[]): Promise<void> => {
    for (const file of files) {
        const pin = crypto.randomUUID();
        const pinned = await injectTolerant(page, pinFileInputStep, [CHATGPT_PAGE.fileInput, pin, file.name, file.mimeType]);
        if (pinned?.ok !== true) {
            throw new RefusedError(`Nothing was sent: ${pinned?.message ?? "ChatGPT's page did not answer while a file was attached."} If it says the same again, tell the owner the ChatGPT kit needs fixing.`);
        }
        for (let offset = 0; offset < file.data.byteLength; offset += SLICE_BYTES) {
            await injectTolerant(page, receiveFileSlice, [pin, toBase64(file.data.subarray(offset, offset + SLICE_BYTES))]);
        }
        const put = await injectTolerant(page, putFile, [pin, file.name, file.mimeType]);
        if (put?.ok !== true) {
            throw new RefusedError(`Nothing was sent: ${put?.message ?? `“${file.name}” did not reach ChatGPT's file input.`}`);
        }
    }
};

// A chat the kit no longer remembers: its tab is closed while it sits in the agent's own window still on that chat,
// else (the person's tab, or one moved on) made discardable again and left.
const forget = async (from: SandboxKey, page: number, showsChat: boolean): Promise<void> => {
    // allow(silent-catch): a tab closed since needs nothing
    const tab = await chrome.tabs.get(page).catch(() => undefined);
    if (tab === undefined) {
        return;
    }
    const window = await agentWindow(from);
    await releaseKitTab(page, window?.id !== undefined && tab.windowId === window.id && showsChat);
};

const gate = async (from: SandboxKey, need: "read" | "act"): Promise<void> => {
    const [scopes, paused] = await Promise.all([store.scopes(from), store.paused()]);
    assertRunning(paused);
    assertScope(scopes, need);
    // Before anything opens: a site the person never allowed is never loaded.
    await assertSiteAllowed(from, CHATGPT_SITE.home, need);
};

// The kit's host for one call from sandbox `from`. Each tab it opens or fronts is busy until `done`.
const chromeHost = (from: SandboxKey): ChatgptHost<Collected> => {
    const places = new Map<number, KitPlace>();
    const place = (taken: KitPlace): number => {
        places.set(taken.tabId, taken);
        busy.add(taken.tabId);
        return taken.tabId;
    };
    return {
        voice: CHROME_VOICE,
        gate: async (need) => await gate(from, need),
        permit: async (page, need) => {
            try {
                await targetTab(from, need, page);
            } catch (error) {
                throw error instanceof RefusedError ? new KitRefusal(error.message) : error;
            }
        },
        open: async (url) => {
            const opened = await openKitTab(from, url);
            return { page: place(opened), afterword: opened.createdWindow ? WINDOW_NOTE : "" };
        },
        take: async (page) => {
            place(await frontKitTab(from, page));
        },
        busy: (page) => busy.has(page),
        done: async (page, keep) => {
            busy.delete(page);
            const taken = places.get(page);
            places.delete(page);
            if (taken === undefined) {
                return;
            }
            await leaveKitTab(taken);
            if (taken.createdTab && !keep) {
                await releaseKitTab(page, true);
            }
        },
        forget: async (page, showsChat) => await forget(from, page, showsChat),
        // A tab whose site Chrome hides from this extension has no url: "" says so.
        // allow(silent-catch): a tab closed meanwhile is a page gone, which undefined says
        address: async (page) => await chrome.tabs.get(page).then((tab) => tab.url ?? "", () => undefined),
        navigate: async (page, url) => {
            await chrome.tabs.update(page, { url });
            await untilTabLoaded(page);
        },
        // The helpers stay in the isolated world, where the page's own scripts never see them, so `cleanup` is not run.
        run: async <Result>(page: number, { helpers, step }: PageStep<Result>): Promise<Result | undefined> => {
            for (const helper of helpers) {
                await inject(page, helper);
            }
            // SAFETY: a step answers its Result or null, and injectTolerant turns null into undefined.
            return (await inject(page, step)) as Result | undefined;
        },
        announce: (page, message) => announce(page, message),
        confirmSend: async (page, url) => await confirmSend(from, page, url),
        collectFiles: async (tickets) => {
            const files: Collected[] = [];
            for (const ticket of tickets) {
                files.push(await collectFile(from, ticket));
            }
            return files;
        },
        allowFiles: async (page, url, files) => await allowFiles(from, page, url, files),
        attachFiles: async (page, files) => await attachFiles(page, files),
        saveImage: async (page, src, stem) => await saveMediaFromTab(from, page, src, stem),
        saveText: async (text, stem) => await saveBytes(from, new TextEncoder().encode(text), "text/markdown", stem, CHATGPT_SITE.host),
        sandboxName: async () => {
            const sandbox = await store.sandbox(from);
            return sandbox === undefined ? new URL(from).host : sandboxName(sandbox);
        },
        recall: async (name) => await MEMORY[name].read(from),
        keep: async (name, value) => await MEMORY[name].write(from, value),
    };
};

// What the three tools run: the kit's engine on this browser, its refusals turned into this extension's (policy.ts), so
// the agent reads the same words.
const refusing = async (work: () => Promise<string>): Promise<string> => {
    try {
        return await work();
    } catch (error) {
        throw error instanceof KitRefusal ? new RefusedError(error.message) : error;
    }
};

// chatgpt_send's files arrive as the tickets the daemon added on the way, one per file.
export const chatgptSend = async (from: SandboxKey, request: Omit<SendRequest, "files"> & { readonly tickets: readonly string[] }, timing?: ChatTiming): Promise<string> =>
    await refusing(async () => await send(chromeHost(from), { ...request, files: request.tickets }, timing));

export const chatgptRead = async (from: SandboxKey, request: ReadRequest, timing?: ChatTiming): Promise<string> =>
    await refusing(async () => await read(chromeHost(from), request, timing));

export const chatgptImage = async (from: SandboxKey, request: ImageRequest, timing?: ChatTiming): Promise<string> =>
    await refusing(async () => await image(chromeHost(from), request, timing));
