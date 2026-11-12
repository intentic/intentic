import { within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
// Named imports, as in mcp.ts: the `z` namespace would keep zod's locales in the bundle.
import { array, literal, looseObject, record, string, unknown } from "zod";
import { ownWindow } from "../agent-window.js";
import type { handleMcpMessage } from "../mcp.js";
import { type SandboxKey, store } from "../store.js";
import { megabytes, saveMediaFromTab } from "./media.js";

// A file the agent's own click downloads (a site's Download button), copied into the sandbox instead of being left in
// the person's Downloads folder, where the agent cannot reach it. Behind the optional `downloads` permission, turned on
// from the popup: a new required permission would have Chrome disable the store-installed extension until the person
// re-approved it.
//
// Chrome's download records do not say which tab started one, so "the agent's" is decided here as: created while one of
// that sandbox's tool calls was running (or within a few seconds of it ending), and coming from the same site as a tab
// in that agent's own window. In "My tab" mode there is no window of the agent's own to tell its downloads from the
// person's, so nothing is captured then. A download that is not the agent's is never read past its address.
//
// The copy is fetched again from the download's own address, in the agent's tab (media.ts), as soon as the download
// starts, while a page's blob: address is most likely still alive. Once it is in the sandbox the browser's copy is
// cancelled or deleted and dropped from the download list, since the person did not ask for it; one that could not be
// copied stays where it is, and the agent is told so. The agent hears where the file went in the answer to the call that
// started it when the copy lands in time, otherwise in its next answer.

// A download created this long after one of the sandbox's calls ended still counts as that call's.
const GRACE_MS = 5_000;
// How long a call's answer waits for a copy it started, so the click that downloaded can say where the file went.
const ANSWER_WAIT_MS = 20_000;
// Where notes wait for the agent's next answer, by sandbox: storage.session, so a worker restart does not lose one.
const NOTES_KEY = "mediaNotes";

interface Activity {
    calls: number;
    lastEnded: number;
}

const activity = new Map<SandboxKey, Activity>();
const copying = new Map<number, { readonly from: SandboxKey; readonly done: Promise<void> }>();
// Downloads still being looked at (whose are they?), so a call's answer waits for that before it waits for its copies.
const looking = new Set<Promise<void>>();
let watching = false;

const downloadsOn = async (): Promise<boolean> =>
    chrome.downloads !== undefined && (await chrome.permissions.contains({ permissions: ["downloads"] }));

// The site a download came from: a page's own blob carries its origin in its address; otherwise the page that started
// it, else the file's own address.
const sourceOrigin = (item: Pick<chrome.DownloadItem, "url" | "referrer">): string | undefined => {
    try {
        if (item.url.startsWith("blob:")) {
            return new URL(item.url.slice(5)).origin;
        }
        return new URL(item.referrer !== undefined && item.referrer !== "" ? item.referrer : item.url).origin;
        // allow(silent-catch): an address that does not parse is no site, so the download is nobody's capture
    } catch {
        return undefined;
    }
};

// Notes not yet told, by sandbox; anything else under the key (a build's older shape) reads as none.
const NotesSchema = record(string(), array(string())).catch({});

const keptNotes = async (): Promise<Record<string, string[]>> => NotesSchema.parse((await chrome.storage.session.get([NOTES_KEY]))[NOTES_KEY]);

const addNote = async (from: SandboxKey, note: string): Promise<void> => {
    const notes = await keptNotes();
    await chrome.storage.session.set({ [NOTES_KEY]: { ...notes, [from]: [...(notes[from] ?? []), note].slice(-10) } });
};

const takeNotes = async (from: SandboxKey): Promise<string[]> => {
    const { [from]: mine, ...rest } = await keptNotes();
    if (mine === undefined) {
        return [];
    }
    await chrome.storage.session.set({ [NOTES_KEY]: rest });
    return mine;
};

// The tab in this sandbox's own agent window on the site a download came from.
const agentTabOn = async (from: SandboxKey, origin: string): Promise<number | undefined> => {
    const windowId = (await store.agentWindows())[from];
    if (windowId === undefined || !(await ownWindow())) {
        return undefined;
    }
    const tabs = await chrome.tabs.query({ windowId });
    const sameSite = (url: string | undefined): boolean => {
        try {
            return url !== undefined && new URL(url).origin === origin;
            // allow(silent-catch): a tab whose address does not parse is on no site
        } catch {
            return false;
        }
    };
    return tabs.find((tab) => sameSite(tab.url))?.id;
};

// The file a download names, as a name stem: no folders, no extension.
const stemOf = (item: Pick<chrome.DownloadItem, "filename" | "url">): string => {
    const base = (item.filename.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
    return base === "" ? "download" : base;
};

// Out of the person's Downloads: cancelled if still arriving (which deletes the part), deleted if done, and dropped from
// the browser's download list either way.
const takeOut = async (api: chrome.DownloadsApi, id: number): Promise<void> => {
    const [item] = await api.search({ id });
    if (item?.state === "in_progress") {
        await api.cancel(id);
    } else if (item?.state === "complete") {
        await api.removeFile(id);
    }
    await api.erase({ id });
};

const copy = async (api: chrome.DownloadsApi, from: SandboxKey, tabId: number, item: chrome.DownloadItem): Promise<void> => {
    try {
        const saved = await saveMediaFromTab(from, tabId, item.finalUrl ?? item.url, stemOf(item), { pointedAt: true });
        // allow(silent-catch): the copy is safe in the sandbox; a browser copy left behind is said in the note below
        const removed = await takeOut(api, item.id).then(() => true, () => false);
        await addNote(
            from,
            `A download your action started was saved to ${saved.path} (${megabytes(saved.bytes)}, ${saved.mimeType}). ${
                removed ? "It was taken out of the person's Downloads folder, since they did not ask for it." : "Its copy in the person's Downloads folder could not be removed."
            }`,
        );
    } catch (error) {
        await addNote(
            from,
            `A download your action started could not be copied into the sandbox: ${errorMessage(error)} It stays in the person's Downloads folder, out of your reach. To get the file, use save_media on the picture or link itself.`,
        );
    }
};

const created = async (api: chrome.DownloadsApi, item: chrome.DownloadItem): Promise<void> => {
    const origin = sourceOrigin(item);
    if (origin === undefined) {
        return;
    }
    const now = Date.now();
    for (const [from, state] of activity) {
        if (state.calls === 0 && now - state.lastEnded > GRACE_MS) {
            continue;
        }
        const tabId = await agentTabOn(from, origin);
        if (tabId !== undefined) {
            const done = copy(api, from, tabId, item).finally(() => copying.delete(item.id));
            copying.set(item.id, { from, done });
            return;
        }
    }
};

// Listens once per worker, from the first call that finds the API present (the person may turn it on at any time).
const watch = (api: chrome.DownloadsApi): void => {
    if (watching) {
        return;
    }
    watching = true;
    api.onCreated.addListener((item) => {
        const look = created(api, item)
            .catch((error: Error) => console.warn(`intentic: a download could not be looked at:`, errorMessage(error)))
            .finally(() => looking.delete(look));
        looking.add(look);
    });
};

// What this reads of the messages and answers passing through: whether a message is a tool call, and an answer's
// content blocks, which the notes join.
const ToolCallSchema = looseObject({ method: literal("tools/call") });
const ToolAnswerSchema = looseObject({ result: looseObject({ content: array(unknown()) }) });

// A message and its answer as the MCP server (mcp.ts) takes and gives them.
type Message = Parameters<typeof handleMcpMessage>[0];
type Answer = Awaited<ReturnType<typeof handleMcpMessage>>;

// The notes as one more text block of a tools/call answer; any other answer is left as it is.
const withNotes = (answer: Answer, notes: readonly string[]): Answer => {
    const parsed = ToolAnswerSchema.safeParse(answer);
    return parsed.success
        ? { ...parsed.data, result: { ...parsed.data.result, content: [...parsed.data.result.content, { type: "text", text: notes.join("\n") }] } }
        : answer;
};

// A tool call's answer with what became of the downloads it started (and any earlier ones not yet told) as a last text
// block. Every message from sandbox `from` passes here (router.ts), so a download is counted as its agent's only while
// one of its calls runs.
export const withCapturedDownloads = async (from: SandboxKey, message: Message, run: () => Promise<Answer>): Promise<Answer> => {
    const api = chrome.downloads;
    if (api === undefined || !ToolCallSchema.safeParse(message).success) {
        return await run();
    }
    watch(api);
    const state = activity.get(from) ?? { calls: 0, lastEnded: 0 };
    activity.set(from, state);
    state.calls += 1;
    let answer: Answer;
    try {
        answer = await run();
    } finally {
        state.calls -= 1;
        state.lastEnded = Date.now();
    }
    const settled = async (): Promise<void> => {
        await Promise.all(looking);
        await Promise.all([...copying.values()].filter((each) => each.from === from).map((each) => each.done));
    };
    await within(settled(), ANSWER_WAIT_MS, undefined);
    const notes = await takeNotes(from);
    return notes.length === 0 ? answer : withNotes(answer, notes);
};

// What `describe` says about downloads, so the agent knows before it clicks a Download button where the file will go.
export const downloadsLine = async (): Promise<string> =>
    (await downloadsOn())
        ? `Downloads: on. A file your click downloads in your own window is copied into the sandbox (the answer says where) and taken out of the person's Downloads folder.`
        : `Downloads: off. A Download button you click saves into the person's own Downloads folder, out of your reach: use save_media on the picture or link instead. The person can turn on "Save my agent's downloads to the sandbox" in the extension's popup.`;
