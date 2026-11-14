import { sleep, within } from "@intentic/base/async";
import { enum as zEnum, number, object, string } from "zod";
import { KitRefusal, type Need } from "../host.js";
import { keptList } from "../memory.js";
import { readable, step } from "./drive.js";
import type { ChatgptHost, OpenedPage } from "./host.js";
import type { Baseline } from "./page-hands.js";
import { ensureProject, type ProjectTiming, rememberedProject } from "./project.js";
import { CHATGPT_SITE } from "./site.js";
import { composeStep, inspectStep, type Judged, lastAnswerStep, modeStep, personalizationStep, readyStep, sendStep, type Watched, watchStep } from "./steps.js";

// THE CHAT ENGINE behind every ChatGPT tool (2026-11-14): open or reopen a chat, attach files, choose a tool, send one
// prompt, watch ChatGPT until it is done or the call's time is up, and remember the chat. What the agent is told is the
// callers' (answers.ts for words, image.ts for pictures); what a browser does its own way is its host's (host.ts). It
// began as chatgpt_image alone, which replaced some twenty page-tool calls an agent made by hand and failed live in
// each of the ways the comments below name.

export type Mode = "chat" | "image" | "deep_research" | "agent";

export interface ChatRequest {
    readonly prompt: string;
    readonly chat?: string | undefined;
    readonly mode: Mode;
    // The host's references to the files to attach, one per file, in order (host.ts, collectFiles).
    readonly files: readonly string[];
    // The most this call waits for ChatGPT, under the timing's own cap.
    readonly waitMs?: number | undefined;
    readonly personalized: boolean;
    readonly temporary: boolean;
}

export interface ChatTiming extends ProjectTiming {
    // The whole call, under the sandbox's ten-minute ceiling on one call to the extension (webext-peer.ts).
    readonly capMs: number;
    // One watch in the page. Chrome ends a service worker whose single call runs past five minutes, and the page may be
    // replaced mid-wait, so the wait is watched in short rounds rather than in one long one: a lost round costs one
    // round, and each re-checks the gates (a pause, a withdrawn site) between rounds.
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

// Past a round's own cap, how long the engine waits for the page to hand its answer over.
const ROUND_GRACE_MS = 15_000;

// A chat this kit made or read, and the page it lives in (the host's: the extension's tab id). `home` says what it is:
// a temporary chat, which ChatGPT cannot load again by its address once its page has left it; one in the sandbox's
// project; or one of the account's own.
const ChatEntry = object({ chat: string(), tabId: number(), url: string(), home: zEnum(["temporary", "project", "account"]) });
export type Chat = ReturnType<typeof ChatEntry.parse>;
const chatsOf = (host: ChatgptHost) =>
    keptList(
        async () => await host.recall("chats"),
        async (value) => await host.keep("chats", value),
        ChatEntry,
        20,
    );

// The chat id an agent passed: one an earlier answer gave, or a chat's whole address.
const chatIdOf = (given: string, tool: string): string => {
    const trimmed = given.trim();
    // The path is cut off the address by hand: `new URL` throws on a malformed one, which would not say what to pass.
    const fromUrl = /^https?:\/\//.test(trimmed) ? CHATGPT_SITE.chatPath.exec(trimmed.replace(/^https?:\/\/[^/?#]*/, ""))?.[1] : undefined;
    const id = fromUrl ?? trimmed;
    if (!/^(t-)?[A-Za-z0-9-]{6,80}$/.test(id)) {
        throw new KitRefusal(`"${given}" is not a ChatGPT chat. Pass the \`chat\` an earlier ${tool} answer gave, or its chatgpt.com address.`);
    }
    return id;
};

const gone = (id: string): KitRefusal =>
    new KitRefusal(
        `Chat "${id}" is gone: it was a temporary chat, and its tab was closed or has moved on to another page since, and ChatGPT cannot open a temporary chat again. Nothing was sent. Start a new chat (leave out \`chat\`), and say again in the prompt what it needs to know.`,
    );

// One of the account's own chats carries its memory, custom instructions and history, and ChatGPT has no switch to keep
// them out of one chat, so sending there is only for a caller who asked for that.
const personal = (id: string): KitRefusal =>
    new KitRefusal(
        `Chat "${id}" is one of the ChatGPT account's own chats, not one in this sandbox's project: ChatGPT applies the owner's memory, custom instructions and chat history there. Nothing was sent. Leave out \`chat\` to start a new chat in the sandbox's project, or pass personalized: true if the owner agrees to their history shaping the answer.`,
    );

// Whether a page still shows a remembered chat: its address names the chat, or, for a temporary chat ChatGPT gave no
// address of its own, is the one it had.
const stillOn = (url: string | undefined, chat: Chat): boolean => {
    if (!readable(url)) {
        return false;
    }
    const id = CHATGPT_SITE.chatPath.exec(new URL(url).pathname)?.[1];
    return chat.chat.startsWith("t-") ? url === chat.url : id === chat.chat;
};

const projectOf = (url: string): string | undefined => CHATGPT_SITE.projectPath.exec(new URL(url).pathname)?.[1];

interface Opened {
    readonly page: number;
    readonly known: Chat | undefined;
    // What the chat is or, for a new one, will be once its first prompt goes.
    readonly home: Chat["home"];
    // The chat was loaded by its address, so it must show turns of its own once loaded.
    readonly byAddress: boolean;
    // For the agent: the project made just now, or why the chat is temporary after all.
    readonly notes: string[];
    // What the host adds at the end of a finished answer (host.ts, open), or "".
    readonly afterword: string;
}

// A chat by id: its remembered page, else its address, which works for every chat but a temporary one. Opening an
// account chat to send into it is refused unless `personalized`; reading one is not (`forSending` false).
const reopen = async (host: ChatgptHost, id: string, personalized: boolean, forSending: boolean): Promise<Opened> => {
    const remembered = (await chatsOf(host).list()).find((chat) => chat.chat === id);
    if (remembered !== undefined) {
        if (stillOn(await host.address(remembered.tabId), remembered)) {
            if (host.busy(remembered.tabId)) {
                throw new KitRefusal(`Another ChatGPT call is still working in chat "${id}". Wait for its answer, then continue the chat.`);
            }
            if (forSending && remembered.home === "account" && !personalized) {
                throw personal(id);
            }
            await host.take(remembered.tabId);
            return { page: remembered.tabId, known: remembered, home: remembered.home, byAddress: false, notes: [], afterword: "" };
        }
        if (remembered.home === "temporary") {
            throw gone(id);
        }
    }
    if (id.startsWith("t-")) {
        throw gone(id);
    }
    const opened = await host.open(CHATGPT_SITE.chat(id));
    const url = (await host.address(opened.page)) ?? "";
    const sandboxProject = await rememberedProject(host);
    const project = sandboxProject === undefined ? undefined : projectOf(sandboxProject.url);
    const home = project !== undefined && url !== "" && projectOf(url) === project ? "project" : "account";
    if (forSending && home === "account" && !personalized) {
        await host.done(opened.page, false);
        throw personal(id);
    }
    return { page: opened.page, known: undefined, home, byAddress: true, notes: [], afterword: opened.afterword };
};

const fresh = (opened: OpenedPage, home: Chat["home"], notes: string[] = []): Opened => ({
    page: opened.page,
    known: undefined,
    home,
    byAddress: false,
    notes,
    afterword: opened.afterword,
});

// A new chat: in the sandbox's project unless the caller asked for a temporary or a personalized one, and temporary
// after all when no project can be had, which the agent is told.
const openNew = async (host: ChatgptHost, request: ChatRequest, timing: ChatTiming): Promise<Opened> => {
    if (request.temporary) {
        return fresh(await host.open(CHATGPT_SITE.newTemporaryChat), "temporary");
    }
    if (request.personalized) {
        return fresh(await host.open(CHATGPT_SITE.home), "account");
    }
    const opened = await host.open(CHATGPT_SITE.home);
    const ready = await step(host, opened.page, readyStep, [timing.readyMs]);
    if (ready?.signedOut === true) {
        // prepare() says so with the words the person needs.
        return fresh(opened, "project");
    }
    const found = await ensureProject(host, opened.page, timing);
    if (found.project !== undefined) {
        return fresh(opened, "project", found.note === "" ? [] : [found.note]);
    }
    await host.navigate(opened.page, CHATGPT_SITE.newTemporaryChat);
    const fallback = `${found.note} So this is a temporary, unpersonalized chat instead: apps and connectors are off in it, and it lives only in its tab. If this keeps happening, tell the owner the ChatGPT kit's project step needs fixing.`;
    return fresh(opened, "temporary", [fallback]);
};

// What a refusal says once the prompt may have gone: told only "paused" or "not allowed", an agent calls again once
// that is resolved, and sends the prompt a second time on the owner's quota.
const mayHaveGone = (host: ChatgptHost, page: number, reason: string): KitRefusal =>
    new KitRefusal(
        `${reason} The prompt may already have gone to ChatGPT in ${host.voice.page(page)}: do not send it again. Once this is resolved, read the chat with chatgpt_read, or look at that tab with ${host.voice.snapshotTool}.`,
    );

// The kit's page, permitted, and still on ChatGPT: its address. A page sent elsewhere is most likely at a sign-in page.
// `sent` is whether the prompt may have gone by now, which changes what a refusal must tell the agent.
const check = async (host: ChatgptHost, page: number, need: Need, sent: boolean): Promise<string> => {
    const url = await host.address(page);
    if (url === undefined) {
        throw new KitRefusal(`ChatGPT's tab was closed during the call. Nothing more was done.`);
    }
    const at = url === "" ? undefined : new URL(url).host;
    if (at !== CHATGPT_SITE.host) {
        const went = `ChatGPT's tab went to ${at ?? `a site ${host.voice.browser} may not read`} instead: most likely its sign-in.`;
        if (sent) {
            throw mayHaveGone(host, page, `${went} Ask the person to sign in to ChatGPT in ${host.voice.browser}.`);
        }
        throw new KitRefusal(`${went} Ask the person to sign in to ChatGPT in ${host.voice.browser}, then call again. Nothing was sent.`);
    }
    try {
        await host.permit(page, need);
    } catch (error) {
        throw sent && error instanceof KitRefusal ? mayHaveGone(host, page, error.message) : error;
    }
    return url;
};

// Checks the page is ChatGPT signed in, with a message box, holding the chat asked for.
const ready = async (host: ChatgptHost, opened: Opened, timing: ChatTiming): Promise<void> => {
    const seen = await step(host, opened.page, readyStep, [timing.readyMs]);
    // Signed out, ChatGPT still shows a message box, but nothing it makes is the owner's.
    if (seen === undefined || seen.signedOut || !seen.composer) {
        throw new KitRefusal(
            seen?.signedOut === true
                ? `ChatGPT is not signed in in ${host.voice.browser}: it shows "Log in". Ask the person to sign in to chatgpt.com, then call again. Nothing was sent.`
                : `ChatGPT's page has no message box to type into (it may still be loading, or ChatGPT changed its page). Nothing was sent. Try once more; if it says the same, tell the owner the ChatGPT kit needs fixing.`,
        );
    }
    if (opened.byAddress && seen.counts.user === 0) {
        throw new KitRefusal(
            `ChatGPT did not load that chat from its address: it may have been a temporary chat, which cannot be opened again, or one this ChatGPT account does not have. Nothing was sent. Start a new chat: leave out \`chat\`.`,
        );
    }
};

// A new temporary chat starts personalized; unless asked otherwise it is made Unpersonalized before a word is typed.
const personalize = async (host: ChatgptHost, page: number, request: ChatRequest, timing: ChatTiming): Promise<void> => {
    const want = request.personalized ? "personalized" : "unpersonalized";
    const set = await step(host, page, personalizationStep, [want, timing.stepMs]);
    // Failing to turn it on again costs nothing; failing to turn it off would let the owner's memory into the answer
    // (a Naruto pastiche from a chat history, 2026-11-11).
    if (set?.ok !== true && want === "unpersonalized") {
        throw new KitRefusal(
            `Nothing was sent: this temporary chat could not be made Unpersonalized (${set?.message ?? "the page did not answer"}), and a personalized chat lets the owner's memory and custom instructions into the answer. Try once more; if it says the same, ChatGPT changed its page: tell the owner the ChatGPT kit needs fixing, or pass personalized: true if they agree to a personalized chat.`,
        );
    }
};

// Puts each file into ChatGPT's own file input, once the host has allowed all of them (the extension asks the person
// every time, as upload_file asks: a sandbox file reaching a website is theirs to allow).
const attach = async <File>(host: ChatgptHost<File>, page: number, url: string, files: readonly File[]): Promise<void> => {
    if (files.length === 0) {
        return;
    }
    await host.allowFiles(page, url, files);
    await check(host, page, "act", false);
    await host.attachFiles(page, files);
};

// Turns on Deep research or agent mode, or refuses before anything is sent.
const chooseMode = async (host: ChatgptHost, page: number, mode: Mode, timing: ChatTiming): Promise<void> => {
    if (mode !== "deep_research" && mode !== "agent") {
        return;
    }
    const chosen = await step(host, page, modeStep, [mode, timing.stepMs]);
    if (chosen?.ok !== true) {
        const label = mode === "agent" ? "agent mode" : "Deep research";
        throw new KitRefusal(
            `Nothing was sent: ${label} could not be turned on (${chosen?.message ?? "the page did not answer"}). The owner's plan may not include it, or ChatGPT changed its page. Send without \`mode\` for a plain answer, or tell the owner.`,
        );
    }
};

// Checks the page, and readies the composer: personalization, the tool, the files. Answers the counts to judge the
// answer against.
const prepare = async <File>(
    host: ChatgptHost<File>,
    opened: Opened,
    url: string,
    request: ChatRequest,
    files: readonly File[],
    timing: ChatTiming,
): Promise<Baseline> => {
    const { page } = opened;
    await ready(host, opened, timing);
    await host.confirmSend(page, url);
    // The page and the person may have taken minutes to answer: the gates (a pause, a withdrawn grant) are asked again
    // before anything on the page is pressed.
    await check(host, page, "act", false);
    host.announce(page, request.mode === "image" ? `The agent is making an image with ChatGPT` : `The agent is asking ChatGPT`);
    if (opened.known === undefined && !opened.byAddress && opened.home === "temporary") {
        await personalize(host, page, request, timing);
    }
    await chooseMode(host, page, request.mode, timing);
    await attach(host, page, url, files);
    const before = await step(host, page, inspectStep, []);
    if (before === undefined) {
        throw new KitRefusal(`ChatGPT's page stopped answering before the prompt was typed. Nothing was sent; call again.`);
    }
    return before.counts;
};

// How far a call got: once Send has been pressed, its page holds the chat the agent is told about, and is kept.
interface Progress {
    sent: boolean;
}

// Types the prompt and sends it. Sending moves ChatGPT from / to /c/<id>, which may cost the send step its answer:
// that is not a failure, and nothing here sends twice on its account. The watch that follows says whether it went.
const send = async (host: ChatgptHost, page: number, prompt: string, uploading: boolean, timing: ChatTiming, progress: Progress): Promise<void> => {
    await check(host, page, "act", false);
    const composed = await step(host, page, composeStep, [prompt]);
    if (composed?.ok !== true) {
        throw new KitRefusal(
            `Nothing was sent: ${composed?.message ?? "ChatGPT's page did not answer while the prompt was typed."} Try once more; if it says the same, tell the owner the ChatGPT kit needs fixing.`,
        );
    }
    progress.sent = true;
    // Send stays disabled while attached files upload.
    await step(host, page, sendStep, ["button", uploading ? timing.uploadMs : timing.stepMs]);
};

interface WatchPlan {
    readonly baseline: Baseline;
    // What was sent, to tell a prompt still in the box; "" when reading a chat, which never resends.
    readonly prompt: string;
    readonly judged: Judged;
    readonly capMs: number;
}

const chatIn = (url: string): string | undefined => CHATGPT_SITE.chatPath.exec(new URL(url).pathname)?.[1];

// Watches round by round until ChatGPT is done or the cap. A prompt that plainly did not go (still in the box, nothing
// new on the page) is sent once more with Enter: with the box still full nothing can have gone yet, so that cannot be a
// second send.
// How long the next watch round runs with `left` of the call's time, or undefined once it is spent. The first round runs
// at least long enough to judge a still page done, however little time is left.
const nextRound = (timing: ChatTiming, left: number, looked: boolean): number | undefined => {
    if (!looked) {
        return Math.min(timing.roundMs, Math.max(left, timing.settleMs + 500));
    }
    return left <= 0 ? undefined : Math.min(timing.roundMs, left);
};

const watch = async (host: ChatgptHost, page: number, url: string, plan: WatchPlan, timing: ChatTiming, startedAt: number): Promise<Watched> => {
    let resent = plan.prompt === "";
    let answeredAt = Date.now();
    let last: Watched | undefined;
    // The chat the prompt went to, once the page's address names it: a page moved on to another chat (the person's
    // click, in their own tabs) would have that chat's answer judged against this one's baseline, and saved as this one.
    let chatId = chatIn(url);
    // The page is looked at at least once, for as long as it takes to judge a still page done: a read with no wait
    // (chatgpt_read's default) answers with the page as it stands, not with "still working" unread.
    let looked = false;
    for (;;) {
        const round = nextRound(timing, plan.capMs - (Date.now() - startedAt), looked);
        if (round === undefined) {
            return { kind: "watch", outcome: "working", images: [], text: last?.text ?? "", failure: "", hint: last?.hint ?? "", asks: "" };
        }
        const at = await check(host, page, "read", plan.prompt !== "");
        const now = chatIn(at);
        chatId ??= now;
        if (chatId !== undefined && now !== chatId) {
            throw mayHaveGone(host, page, `ChatGPT's tab moved on from its chat to ${at} while ChatGPT worked, so its answer was not read.`);
        }
        looked = true;
        const seen = await within(step(host, page, watchStep, [plan.baseline, plan.prompt, round, timing.settleMs, plan.judged]), round + ROUND_GRACE_MS, undefined);
        if (seen === undefined) {
            if (Date.now() - answeredAt >= timing.silentMs) {
                throw mayHaveGone(host, page, `ChatGPT's page stopped answering mid-answer, for ${Math.round(timing.silentMs / 1000)} s.`);
            }
            await sleep(timing.retryMs);
            continue;
        }
        answeredAt = Date.now();
        last = seen;
        if (seen.outcome === "unsent" && !resent) {
            resent = true;
            // Pressing Enter is acting, so it needs what acting needs, not the read the round was allowed on.
            await check(host, page, "act", true);
            await step(host, page, sendStep, ["enter", timing.stepMs]);
            continue;
        }
        if (seen.outcome !== "working") {
            return seen;
        }
    }
};

// A chat the kit no longer remembers is not kept open for it: the host lets its page go (host.ts, forget).
const letGo = async (host: ChatgptHost, chat: Chat): Promise<void> => {
    const url = await host.address(chat.tabId);
    if (url !== undefined) {
        await host.forget(chat.tabId, stillOn(url, chat));
    }
};

// Where the chat now is, remembered for a later call to continue in. `url` is the page's address a moment ago, kept
// when the page is gone this instant.
const settle = async (host: ChatgptHost, page: number, url: string, opened: Opened): Promise<Chat> => {
    const now = await host.address(page);
    const at = readable(now) ? now : url;
    const id = chatIn(at) ?? opened.known?.chat ?? `t-${crypto.randomUUID().slice(0, 8)}`;
    const chat: Chat = { chat: id, tabId: page, url: at, home: opened.known?.home ?? opened.home };
    const evicted = await chatsOf(host).put(chat, (kept) => kept.chat === chat.chat || kept.tabId === chat.tabId);
    await Promise.all(evicted.filter((old) => old.tabId !== chat.tabId).map(async (old) => await letGo(host, old)));
    return chat;
};

// What a finished call hands its caller to word: the page is still the call's, so pictures can be saved from it.
export interface Ran {
    readonly page: number;
    readonly watched: Watched;
    readonly chat: Chat;
    readonly notes: readonly string[];
    readonly afterword: string;
}

// Runs `work` in `opened`'s page, then hands the page back to its host, which keeps it unless this call opened it and
// it holds nothing worth keeping (`keep` false).
const inPage = async <T>(host: ChatgptHost, opened: Opened, keep: () => boolean, work: () => Promise<T>): Promise<T> => {
    try {
        return await work();
    } finally {
        await host.done(opened.page, keep());
    }
};

// One prompt in, ChatGPT's answer out, worded by `finish` while the chat's page is still the call's.
export const runChat = async <File>(
    host: ChatgptHost<File>,
    request: ChatRequest,
    finish: (ran: Ran) => Promise<string>,
    timing: ChatTiming = CHAT_TIMING,
    tool = "chatgpt_send",
): Promise<string> => {
    const startedAt = Date.now();
    await host.gate("act");
    // The extension's file tickets last a minute, so the files are collected before anything slow (a page, a project,
    // the person).
    const files = await host.collectFiles(request.files);
    const opened =
        request.chat === undefined ? await openNew(host, request, timing) : await reopen(host, chatIdOf(request.chat, tool), request.personalized, true);
    const progress: Progress = { sent: false };
    const capMs = Math.min(request.waitMs ?? timing.capMs, timing.capMs);
    return await inPage(
        host,
        opened,
        () => progress.sent,
        async () => {
            const url = await check(host, opened.page, "act", false);
            const baseline = await prepare(host, opened, url, request, files, timing);
            await send(host, opened.page, request.prompt, files.length > 0, timing, progress);
            const judged: Judged = request.mode === "image" ? "image" : "text";
            const watched = await watch(host, opened.page, url, { baseline, prompt: request.prompt, judged, capMs }, timing, startedAt);
            const chat = await settle(host, opened.page, url, opened);
            return await finish({ page: opened.page, watched, chat, notes: opened.notes, afterword: opened.afterword });
        },
    );
};

// A chat's latest answer, waited for up to `waitMs`: for an answer that outlived the call that sent its prompt.
export const readChat = async (
    host: ChatgptHost,
    given: string,
    waitMs: number | undefined,
    finish: (ran: Ran) => Promise<string>,
    timing: ChatTiming = CHAT_TIMING,
): Promise<string> => {
    const startedAt = Date.now();
    await host.gate("read");
    const opened = await reopen(host, chatIdOf(given, "chatgpt_send"), true, false);
    return await inPage(
        host,
        opened,
        () => true,
        async () => {
            const url = await check(host, opened.page, "read", false);
            await ready(host, opened, timing);
            const baseline = await step(host, opened.page, lastAnswerStep, []);
            if (baseline === undefined) {
                throw new KitRefusal(`ChatGPT's page did not answer while the chat was read. Try again.`);
            }
            const capMs = Math.min(waitMs ?? 0, timing.capMs);
            const watched = await watch(host, opened.page, url, { baseline, prompt: "", judged: "text", capMs }, timing, startedAt);
            const chat = await settle(host, opened.page, url, opened);
            return await finish({ page: opened.page, watched, chat, notes: [], afterword: opened.afterword });
        },
    );
};
