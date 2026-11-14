import { sleep, within } from "@intentic/base/async";
import { enum as zEnum, number, object, string } from "zod";
import { receiveFileSlice, putFile } from "../../../page/media-driver.js";
import { agentWindow } from "../../agent-window.js";
import { askPerson } from "../../asking.js";
import { assertRunning, assertScope, needsConfirm, RefusedError } from "../../policy.js";
import { type SandboxKey, store } from "../../store.js";
import { megabytes, toBase64 } from "../../tools/media.js";
import { type Collected, collectFile } from "../../tools/media-tools.js";
import { announce } from "../../tools/page.js";
import { type TargetTab, targetTab } from "../../tools/tab-access.js";
import { assertSiteAllowed, frontKitTab, injectTolerant, type KitPlace, kitMemory, leaveKitTab, openKitTab, releaseKitTab } from "../kit.js";
import { go, step } from "./drive.js";
import type { Baseline } from "./page-hands.js";
import { ensureProject, type ProjectTiming, rememberedProject } from "./project.js";
import { CHATGPT_PAGE, CHATGPT_SITE } from "./site.js";
import {
    composeStep,
    inspectStep,
    type Judged,
    lastAnswerStep,
    modeStep,
    personalizationStep,
    pinFileInputStep,
    readyStep,
    sendStep,
    type Watched,
    watchStep,
} from "./steps.js";

// THE CHAT ENGINE behind every ChatGPT tool (2026-11-14): open or reopen a chat, attach files, choose a tool, send one
// prompt, watch ChatGPT until it is done or the call's time is up, and remember the chat. What the agent is told is the
// callers' (answers.ts for words, image.ts for pictures). It began as chatgpt_image alone, which replaced some twenty
// page-tool calls an agent made by hand and failed live in each of the ways the comments below name.

export type Mode = "chat" | "image" | "deep_research" | "agent";

export interface ChatRequest {
    readonly prompt: string;
    readonly chat?: string | undefined;
    readonly mode: Mode;
    // The daemon's tickets for the files to attach (file-tickets.ts), one per file, in order.
    readonly tickets: readonly string[];
    // The most this call waits for ChatGPT, under the timing's own cap.
    readonly waitMs?: number | undefined;
    readonly personalized: boolean;
    readonly temporary: boolean;
}

export interface ChatTiming extends ProjectTiming {
    // The whole call, under the sandbox's ten-minute ceiling on one call to this browser (webext-peer.ts).
    readonly capMs: number;
    // One injected watch. Chrome ends a service worker whose single call runs past five minutes, and the page may be
    // replaced mid-wait, so the wait is watched in short rounds from the worker rather than in one long one: a lost
    // round costs one round, and each re-checks the gates (a pause, a withdrawn site) between rounds.
    readonly roundMs: number;
    // How long ChatGPT must have stopped (no Stop button) before its words count as its whole answer.
    readonly settleMs: number;
    // How long the page may go without one good answer to a round (reloading, a frame gone) before it counts as lost.
    // Time rather than a count of rounds: a round that fails at once would otherwise spend the allowance in seconds.
    readonly silentMs: number;
    // The pause after a round the page did not answer, before the next.
    readonly retryMs: number;
    // How long Send may stay disabled while attached files upload.
    readonly uploadMs: number;
}

export const CHAT_TIMING: ChatTiming = {
    capMs: 540_000,
    roundMs: 30_000,
    settleMs: 4000,
    readyMs: 20_000,
    stepMs: 6000,
    silentMs: 60_000,
    retryMs: 1000,
    uploadMs: 120_000,
};

// How long the person has to answer, when the card says every action is asked first, or a file is about to go.
const CONFIRM_TIMEOUT_MS = 120_000;
// Past a round's own cap, how long the worker waits for the page to hand its answer over.
const ROUND_GRACE_MS = 15_000;
// One slice of a file into the page per call, as media-tools.ts sends them.
const SLICE_BYTES = 4 * 1024 * 1024;

// A chat this kit made or read, and the tab it lives in. `home` says what it is: a temporary chat, which ChatGPT cannot
// load again by its address once its tab has left it; one in the sandbox's project; or one of the account's own.
const ChatEntry = object({ chat: string(), tabId: number(), url: string(), home: zEnum(["temporary", "project", "account"]) });
export type Chat = ReturnType<typeof ChatEntry.parse>;
const chats = kitMemory("chatgpt-chats", ChatEntry, 20);

// Tabs a call is working in right now: a second prompt into the same chat mid-answer would be judged against the
// first one's baseline.
const busy = new Set<number>();

// The chat id an agent passed: one an earlier answer gave, or a chat's whole address.
const chatIdOf = (given: string, tool: string): string => {
    const trimmed = given.trim();
    // The path is cut off the address by hand: `new URL` throws on a malformed one, which would not say what to pass.
    const fromUrl = /^https?:\/\//.test(trimmed) ? CHATGPT_SITE.chatPath.exec(trimmed.replace(/^https?:\/\/[^/?#]*/, ""))?.[1] : undefined;
    const id = fromUrl ?? trimmed;
    if (!/^(t-)?[A-Za-z0-9-]{6,80}$/.test(id)) {
        throw new RefusedError(`"${given}" is not a ChatGPT chat. Pass the \`chat\` an earlier ${tool} answer gave, or its chatgpt.com address.`);
    }
    return id;
};

const gone = (id: string): RefusedError =>
    new RefusedError(
        `Chat "${id}" is gone: it was a temporary chat, and its tab was closed or has moved on to another page since, and ChatGPT cannot open a temporary chat again. Nothing was sent. Start a new chat (leave out \`chat\`), and say again in the prompt what it needs to know.`,
    );

// One of the account's own chats carries its memory, custom instructions and history, and ChatGPT has no switch to keep
// them out of one chat, so sending there is only for a caller who asked for that.
const personal = (id: string): RefusedError =>
    new RefusedError(
        `Chat "${id}" is one of the ChatGPT account's own chats, not one in this sandbox's project: ChatGPT applies the owner's memory, custom instructions and chat history there. Nothing was sent. Leave out \`chat\` to start a new chat in the sandbox's project, or pass personalized: true if the owner agrees to their history shaping the answer.`,
    );

// Whether a tab still shows a remembered chat: its address names the chat, or, for a temporary chat ChatGPT gave no
// address of its own, is the one it had.
const stillOn = (url: string | undefined, chat: Chat): boolean => {
    if (url === undefined) {
        return false;
    }
    const id = CHATGPT_SITE.chatPath.exec(new URL(url).pathname)?.[1];
    return chat.chat.startsWith("t-") ? url === chat.url : id === chat.chat;
};

const projectOf = (url: string): string | undefined => CHATGPT_SITE.projectPath.exec(new URL(url).pathname)?.[1];

interface Opened {
    readonly place: KitPlace;
    readonly known: Chat | undefined;
    // What the chat is or, for a new one, will be once its first prompt goes.
    readonly home: Chat["home"];
    // The chat was loaded by its address, so it must show turns of its own once loaded.
    readonly byAddress: boolean;
    // For the agent: the project made just now, or why the chat is temporary after all.
    readonly notes: string[];
}

// A chat by id: its remembered tab, else its address, which works for every chat but a temporary one. Opening an
// account chat to send into it is refused unless `personalized`; reading one is not (`forSending` false).
const reopen = async (from: SandboxKey, id: string, personalized: boolean, forSending: boolean): Promise<Opened> => {
    const remembered = (await chats.list(from)).find((chat) => chat.chat === id);
    if (remembered !== undefined) {
        // allow(silent-catch): a tab closed since is a chat gone or to be loaded again, which the lines below say
        const tab = await chrome.tabs.get(remembered.tabId).catch(() => undefined);
        if (tab?.id !== undefined && stillOn(tab.url, remembered)) {
            if (busy.has(tab.id)) {
                throw new RefusedError(`Another ChatGPT call is still working in chat "${id}". Wait for its answer, then continue the chat.`);
            }
            if (forSending && remembered.home === "account" && !personalized) {
                throw personal(id);
            }
            return { place: await frontKitTab(from, tab.id), known: remembered, home: remembered.home, byAddress: false, notes: [] };
        }
        if (remembered.home === "temporary") {
            throw gone(id);
        }
    }
    if (id.startsWith("t-")) {
        throw gone(id);
    }
    const place = await openKitTab(from, CHATGPT_SITE.chat(id));
    // allow(silent-catch): a tab gone this instant reads as one not in the project, and is closed below
    const url = (await chrome.tabs.get(place.tabId).catch(() => undefined))?.url ?? "";
    const sandboxProject = await rememberedProject(from);
    const project = sandboxProject === undefined ? undefined : projectOf(sandboxProject.url);
    const home = project !== undefined && url !== "" && projectOf(url) === project ? "project" : "account";
    if (forSending && home === "account" && !personalized) {
        await releaseKitTab(place.tabId, true);
        await leaveKitTab(place);
        throw personal(id);
    }
    return { place, known: undefined, home, byAddress: true, notes: [] };
};

// A new chat: in the sandbox's project unless the caller asked for a temporary or a personalized one, and temporary
// after all when no project can be had, which the agent is told.
const openNew = async (from: SandboxKey, request: ChatRequest, timing: ChatTiming): Promise<Opened> => {
    if (request.temporary) {
        return { place: await openKitTab(from, CHATGPT_SITE.newTemporaryChat), known: undefined, home: "temporary", byAddress: false, notes: [] };
    }
    if (request.personalized) {
        return { place: await openKitTab(from, CHATGPT_SITE.home), known: undefined, home: "account", byAddress: false, notes: [] };
    }
    const place = await openKitTab(from, CHATGPT_SITE.home);
    const ready = await step(place.tabId, readyStep, [timing.readyMs]);
    if (ready?.signedOut === true) {
        // prepare() says so with the words the person needs.
        return { place, known: undefined, home: "project", byAddress: false, notes: [] };
    }
    const found = await ensureProject(from, place.tabId, timing);
    if (found.project !== undefined) {
        return { place, known: undefined, home: "project", byAddress: false, notes: found.note === "" ? [] : [found.note] };
    }
    await go(place.tabId, CHATGPT_SITE.newTemporaryChat);
    const fallback = `${found.note} So this is a temporary, unpersonalized chat instead: apps and connectors are off in it, and it lives only in its tab. If this keeps happening, tell the owner the ChatGPT kit's project step needs fixing.`;
    return { place, known: undefined, home: "temporary", byAddress: false, notes: [fallback] };
};

// What a refusal says once the prompt may have gone: told only "paused" or "not allowed", an agent calls again once
// that is resolved, and sends the prompt a second time on the owner's quota.
const mayHaveGone = (tabId: number, reason: string): RefusedError =>
    new RefusedError(
        `${reason} The prompt may already have gone to ChatGPT in tab ${tabId}: do not send it again. Once this is resolved, read the chat with chatgpt_read, or look at that tab with snapshot.`,
    );

// The kit's tab, permitted, and still on ChatGPT. A tab sent elsewhere is most likely at a sign-in page. `sent` is
// whether the prompt may have gone by now, which changes what a refusal must tell the agent.
const kitTab = async (from: SandboxKey, tabId: number, need: "read" | "act", sent: boolean): Promise<TargetTab> => {
    // allow(silent-catch): a closed tab is said as such just below
    const current = await chrome.tabs.get(tabId).catch(() => undefined);
    if (current === undefined) {
        throw new RefusedError(`ChatGPT's tab was closed during the call. Nothing more was done.`);
    }
    const host = current.url === undefined ? undefined : new URL(current.url).host;
    if (host !== CHATGPT_SITE.host) {
        const went = `ChatGPT's tab went to ${host ?? "a site this browser may not read"} instead: most likely its sign-in.`;
        if (sent) {
            throw mayHaveGone(tabId, `${went} Ask the person to sign in to ChatGPT in this browser.`);
        }
        throw new RefusedError(`${went} Ask the person to sign in to ChatGPT in this browser, then call again. Nothing was sent.`);
    }
    try {
        return await targetTab(from, need, tabId);
    } catch (error) {
        throw sent && error instanceof RefusedError ? mayHaveGone(tabId, error.message) : error;
    }
};

// Checks the page is ChatGPT signed in, with a message box, holding the chat asked for.
const ready = async (tab: TargetTab, opened: Opened, timing: ChatTiming): Promise<void> => {
    const seen = await step(tab.id, readyStep, [timing.readyMs]);
    // Signed out, ChatGPT still shows a message box, but nothing it makes is the owner's.
    if (seen === undefined || seen.signedOut || !seen.composer) {
        throw new RefusedError(
            seen?.signedOut === true
                ? `ChatGPT is not signed in in this browser: it shows "Log in". Ask the person to sign in to chatgpt.com, then call again. Nothing was sent.`
                : `ChatGPT's page has no message box to type into (it may still be loading, or ChatGPT changed its page). Nothing was sent. Try once more; if it says the same, tell the owner the ChatGPT kit needs fixing.`,
        );
    }
    if (opened.byAddress && seen.counts.user === 0) {
        throw new RefusedError(
            `ChatGPT did not load that chat from its address: it may have been a temporary chat, which cannot be opened again, or one this ChatGPT account does not have. Nothing was sent. Start a new chat: leave out \`chat\`.`,
        );
    }
};

// Asked only when the card says every action is asked first: sending a prompt is not sensitive the way a payment is.
const confirm = async (from: SandboxKey, tab: TargetTab): Promise<void> => {
    if (!needsConfirm(await store.scopes(from), false)) {
        return;
    }
    if (!(await askPerson(from, tab, `Your agent wants to send a prompt to ChatGPT and bring back its answer. Allow it?`, CONFIRM_TIMEOUT_MS))) {
        throw new RefusedError(`The person said no (or did not answer) to sending a prompt to ChatGPT. Do not try another way round it; ask them what they would prefer.`);
    }
};

// A new temporary chat starts personalized; unless asked otherwise it is made Unpersonalized before a word is typed.
const personalize = async (tab: TargetTab, request: ChatRequest, timing: ChatTiming): Promise<void> => {
    const want = request.personalized ? "personalized" : "unpersonalized";
    const set = await step(tab.id, personalizationStep, [want, timing.stepMs]);
    // Failing to turn it on again costs nothing; failing to turn it off would let the owner's memory into the answer
    // (a Naruto pastiche from a chat history, 2026-11-11).
    if (set?.ok !== true && want === "unpersonalized") {
        throw new RefusedError(
            `Nothing was sent: this temporary chat could not be made Unpersonalized (${set?.message ?? "the page did not answer"}), and a personalized chat lets the owner's memory and custom instructions into the answer. Try once more; if it says the same, ChatGPT changed its page: tell the owner the ChatGPT kit needs fixing, or pass personalized: true if they agree to a personalized chat.`,
        );
    }
};

// Puts each file into ChatGPT's own file input, once the person has said yes to all of them (asked every time,
// whatever their switches say, as upload_file asks: a sandbox file reaching a website is theirs to allow).
const attach = async (from: SandboxKey, tab: TargetTab, files: readonly Collected[]): Promise<void> => {
    if (files.length === 0) {
        return;
    }
    const list = files.map((file) => `“${file.name}” (${megabytes(file.data.byteLength)})`).join(", ");
    const what = `give chatgpt.com ${files.length === 1 ? "the file" : `${files.length} files:`} ${list} from its sandbox`;
    if (!(await askPerson(from, tab, `Your agent wants to ${what}. Allow it?`, CONFIRM_TIMEOUT_MS))) {
        throw new RefusedError(`The person said no (or did not answer) to: ${what}. Nothing was sent. Do not try another way round it; ask them what they would prefer.`);
    }
    await kitTab(from, tab.id, "act", false);
    for (const file of files) {
        const pin = crypto.randomUUID();
        const pinned = await injectTolerant(tab.id, pinFileInputStep, [CHATGPT_PAGE.fileInput, pin, file.name, file.mimeType]);
        if (pinned?.ok !== true) {
            throw new RefusedError(`Nothing was sent: ${pinned?.message ?? "ChatGPT's page did not answer while a file was attached."} If it says the same again, tell the owner the ChatGPT kit needs fixing.`);
        }
        for (let offset = 0; offset < file.data.byteLength; offset += SLICE_BYTES) {
            await injectTolerant(tab.id, receiveFileSlice, [pin, toBase64(file.data.subarray(offset, offset + SLICE_BYTES))]);
        }
        const put = await injectTolerant(tab.id, putFile, [pin, file.name, file.mimeType]);
        if (put?.ok !== true) {
            throw new RefusedError(`Nothing was sent: ${put?.message ?? `“${file.name}” did not reach ChatGPT's file input.`}`);
        }
    }
};

// Turns on Deep research or agent mode, or refuses before anything is sent.
const chooseMode = async (tab: TargetTab, mode: Mode, timing: ChatTiming): Promise<void> => {
    if (mode !== "deep_research" && mode !== "agent") {
        return;
    }
    const chosen = await step(tab.id, modeStep, [mode, timing.stepMs]);
    if (chosen?.ok !== true) {
        const label = mode === "agent" ? "agent mode" : "Deep research";
        throw new RefusedError(
            `Nothing was sent: ${label} could not be turned on (${chosen?.message ?? "the page did not answer"}). The owner's plan may not include it, or ChatGPT changed its page. Send without \`mode\` for a plain answer, or tell the owner.`,
        );
    }
};

// Opens the page, checks it, and readies the composer: personalization, the tool, the files. Answers the counts to
// judge the answer against.
const prepare = async (from: SandboxKey, tab: TargetTab, opened: Opened, request: ChatRequest, files: readonly Collected[], timing: ChatTiming): Promise<Baseline> => {
    await ready(tab, opened, timing);
    await confirm(from, tab);
    // The page and the person may have taken minutes to answer: the gates (a pause, a withdrawn grant) are asked again
    // before anything on the page is pressed.
    await kitTab(from, tab.id, "act", false);
    announce(tab.id, request.mode === "image" ? `The agent is making an image with ChatGPT` : `The agent is asking ChatGPT`);
    if (opened.known === undefined && !opened.byAddress && opened.home === "temporary") {
        await personalize(tab, request, timing);
    }
    await chooseMode(tab, request.mode, timing);
    await attach(from, tab, files);
    const before = await step(tab.id, inspectStep, []);
    if (before === undefined) {
        throw new RefusedError(`ChatGPT's page stopped answering before the prompt was typed. Nothing was sent; call again.`);
    }
    return before.counts;
};

// How far a call got: once Send has been pressed, its tab holds the chat the agent is told about, and is kept.
interface Progress {
    sent: boolean;
}

// Types the prompt and sends it. Sending moves ChatGPT from / to /c/<id>, which may cost the send step its answer:
// that is not a failure, and nothing here sends twice on its account. The watch that follows says whether it went.
const send = async (from: SandboxKey, tab: TargetTab, prompt: string, uploading: boolean, timing: ChatTiming, progress: Progress): Promise<void> => {
    await kitTab(from, tab.id, "act", false);
    const composed = await step(tab.id, composeStep, [prompt]);
    if (composed?.ok !== true) {
        throw new RefusedError(
            `Nothing was sent: ${composed?.message ?? "ChatGPT's page did not answer while the prompt was typed."} Try once more; if it says the same, tell the owner the ChatGPT kit needs fixing.`,
        );
    }
    progress.sent = true;
    // Send stays disabled while attached files upload.
    await step(tab.id, sendStep, ["button", uploading ? timing.uploadMs : timing.stepMs]);
};

interface WatchPlan {
    readonly baseline: Baseline;
    // What was sent, to tell a prompt still in the box; "" when reading a chat, which never resends.
    readonly prompt: string;
    readonly judged: Judged;
    readonly capMs: number;
}

// Watches round by round until ChatGPT is done or the cap. A prompt that plainly did not go (still in the box, nothing
// new on the page) is sent once more with Enter: with the box still full nothing can have gone yet, so that cannot be a
// second send.
const watch = async (from: SandboxKey, tab: TargetTab, plan: WatchPlan, timing: ChatTiming, startedAt: number): Promise<Watched> => {
    let resent = plan.prompt === "";
    let answeredAt = Date.now();
    let last: Watched | undefined;
    // The chat the prompt went to, once the tab's address names it: a tab moved on to another chat (the person's click,
    // in their own tabs) would have that chat's answer judged against this one's baseline, and saved as this answer.
    let chatId = CHATGPT_SITE.chatPath.exec(new URL(tab.url).pathname)?.[1];
    for (;;) {
        const left = plan.capMs - (Date.now() - startedAt);
        if (left <= 0) {
            return { kind: "watch", outcome: "working", images: [], text: last?.text ?? "", failure: "", hint: last?.hint ?? "", asks: "" };
        }
        const at = await kitTab(from, tab.id, "read", plan.prompt !== "");
        const now = CHATGPT_SITE.chatPath.exec(new URL(at.url).pathname)?.[1];
        chatId ??= now;
        if (chatId !== undefined && now !== chatId) {
            throw mayHaveGone(tab.id, `ChatGPT's tab moved on from its chat to ${at.url} while ChatGPT worked, so its answer was not read.`);
        }
        const round = Math.min(timing.roundMs, left);
        const seen = await within(step(tab.id, watchStep, [plan.baseline, plan.prompt, round, timing.settleMs, plan.judged]), round + ROUND_GRACE_MS, undefined);
        if (seen === undefined) {
            if (Date.now() - answeredAt >= timing.silentMs) {
                throw mayHaveGone(tab.id, `ChatGPT's page stopped answering mid-answer, for ${Math.round(timing.silentMs / 1000)} s.`);
            }
            await sleep(timing.retryMs);
            continue;
        }
        answeredAt = Date.now();
        last = seen;
        if (seen.outcome === "unsent" && !resent) {
            resent = true;
            // Pressing Enter is acting, so it needs what acting needs, not the read the round was allowed on.
            await kitTab(from, tab.id, "act", true);
            await step(tab.id, sendStep, ["enter", timing.stepMs]);
            continue;
        }
        if (seen.outcome !== "working") {
            return seen;
        }
    }
};

// Where the chat now is, remembered for a later call to continue in.
const settle = async (from: SandboxKey, tab: TargetTab, opened: Opened): Promise<Chat> => {
    // allow(silent-catch): a tab gone this instant keeps the address it had a moment ago
    const url = (await chrome.tabs.get(tab.id).catch(() => undefined))?.url ?? tab.url;
    const id = CHATGPT_SITE.chatPath.exec(new URL(url).pathname)?.[1] ?? opened.known?.chat ?? `t-${crypto.randomUUID().slice(0, 8)}`;
    const chat: Chat = { chat: id, tabId: tab.id, url, home: opened.known?.home ?? opened.home };
    const evicted = await chats.put(from, chat, (kept) => kept.chat === chat.chat || kept.tabId === chat.tabId);
    await Promise.all(evicted.filter((old) => old.tabId !== chat.tabId).map(async (old) => await letGo(from, old)));
    return chat;
};

// A chat the kit no longer remembers is not kept open for it: its tab is closed while it sits in the agent's own window
// still on that chat, else (the person's tab, or one moved on) made discardable again and left.
const letGo = async (from: SandboxKey, chat: Chat): Promise<void> => {
    // allow(silent-catch): a tab closed since needs nothing
    const tab = await chrome.tabs.get(chat.tabId).catch(() => undefined);
    if (tab === undefined) {
        return;
    }
    const window = await agentWindow(from);
    await releaseKitTab(chat.tabId, window?.id !== undefined && tab.windowId === window.id && stillOn(tab.url, chat));
};

// What a finished call hands its caller to word: the tab is still in front, so pictures can be saved from it.
export interface Ran {
    readonly tab: TargetTab;
    readonly watched: Watched;
    readonly chat: Chat;
    readonly notes: readonly string[];
    readonly createdWindow: boolean;
}

const gates = async (from: SandboxKey, need: "read" | "act"): Promise<void> => {
    const [scopes, paused] = await Promise.all([store.scopes(from), store.paused()]);
    assertRunning(paused);
    assertScope(scopes, need);
    // Before anything opens: a site the person never allowed is never loaded.
    await assertSiteAllowed(from, CHATGPT_SITE.home, need);
};

// Runs `work` in `opened`'s tab, then gives the agent's own tab the front back; a tab this call opened that holds
// nothing to keep (`keep` false) is closed.
const inTab = async <T>(opened: Opened, keep: () => boolean, work: () => Promise<T>): Promise<T> => {
    busy.add(opened.place.tabId);
    try {
        return await work();
    } finally {
        busy.delete(opened.place.tabId);
        await leaveKitTab(opened.place);
        if (opened.place.createdTab && !keep()) {
            await releaseKitTab(opened.place.tabId, true);
        }
    }
};

// One prompt in, ChatGPT's answer out, worded by `finish` while the chat's tab is still in front.
export const runChat = async (from: SandboxKey, request: ChatRequest, finish: (ran: Ran) => Promise<string>, timing: ChatTiming = CHAT_TIMING, tool = "chatgpt_send"): Promise<string> => {
    const startedAt = Date.now();
    await gates(from, "act");
    // A ticket lasts a minute, so the files are collected before anything slow (a page, a project, the person).
    const files: Collected[] = [];
    for (const ticket of request.tickets) {
        files.push(await collectFile(from, ticket));
    }
    const opened =
        request.chat === undefined ? await openNew(from, request, timing) : await reopen(from, chatIdOf(request.chat, tool), request.personalized, true);
    const progress: Progress = { sent: false };
    const capMs = Math.min(request.waitMs ?? timing.capMs, timing.capMs);
    return await inTab(
        opened,
        () => progress.sent,
        async () => {
            const tab = await kitTab(from, opened.place.tabId, "act", false);
            const baseline = await prepare(from, tab, opened, request, files, timing);
            await send(from, tab, request.prompt, files.length > 0, timing, progress);
            const judged: Judged = request.mode === "image" ? "image" : "text";
            const watched = await watch(from, tab, { baseline, prompt: request.prompt, judged, capMs }, timing, startedAt);
            const chat = await settle(from, tab, opened);
            return await finish({ tab, watched, chat, notes: opened.notes, createdWindow: opened.place.createdWindow });
        },
    );
};

// A chat's latest answer, waited for up to `waitMs`: for an answer that outlived the call that sent its prompt.
export const readChat = async (from: SandboxKey, given: string, waitMs: number | undefined, finish: (ran: Ran) => Promise<string>, timing: ChatTiming = CHAT_TIMING): Promise<string> => {
    const startedAt = Date.now();
    await gates(from, "read");
    const opened = await reopen(from, chatIdOf(given, "chatgpt_send"), true, false);
    return await inTab(
        opened,
        () => true,
        async () => {
            const tab = await kitTab(from, opened.place.tabId, "read", false);
            await ready(tab, { ...opened, byAddress: opened.byAddress }, timing);
            const baseline = await step(tab.id, lastAnswerStep, []);
            if (baseline === undefined) {
                throw new RefusedError(`ChatGPT's page did not answer while the chat was read. Try again.`);
            }
            const capMs = Math.min(waitMs ?? 0, timing.capMs);
            const watched = await watch(from, tab, { baseline, prompt: "", judged: "text", capMs }, timing, startedAt);
            const chat = await settle(from, tab, opened);
            return await finish({ tab, watched, chat, notes: [], createdWindow: opened.place.createdWindow });
        },
    );
};
