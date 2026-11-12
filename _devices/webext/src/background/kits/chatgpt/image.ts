import { sleep, within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { boolean, number, object, string } from "zod";
import { agentWindow } from "../../agent-window.js";
import { askPerson } from "../../asking.js";
import { assertRunning, assertScope, needsConfirm, RefusedError } from "../../policy.js";
import { type SandboxKey, store } from "../../store.js";
import { saveMediaFromTab, type SavedMedia } from "../../tools/media.js";
import { announce } from "../../tools/page.js";
import { type TargetTab, targetTab } from "../../tools/tab-access.js";
import { assertSiteAllowed, frontKitTab, injectTolerant, type KitPlace, kitMemory, leaveKitTab, openKitTab, releaseKitTab } from "../kit.js";
import { composeStep, inspectStep, personalizationStep, readyStep, sendStep, type Watched, watchStep } from "./steps.js";
import { type Baseline, type FoundImage, installActing, installReading, installWatching } from "./page-hands.js";
import { CHATGPT_PAGE, CHATGPT_SITE } from "./site.js";

// chatgpt_image: one prompt in, one saved picture out, in the person's own signed-in ChatGPT (2026-11-12). It replaces
// some twenty page-tool calls an agent made by hand, which failed live in each of the ways the comments below name.

export interface ImageRequest {
    readonly prompt: string;
    readonly chat?: string | undefined;
    readonly name?: string | undefined;
    readonly personalized: boolean;
}

export interface ImageTiming {
    // The whole call, under the sandbox's ten-minute ceiling on one call to this browser (webext-peer.ts).
    readonly capMs: number;
    // One injected watch. Chrome ends a service worker whose single call runs past five minutes, and the page may be
    // replaced mid-wait, so the nine minutes are watched in short rounds from the worker rather than in one long one:
    // a lost round costs one round, and each re-checks the gates (a pause, a withdrawn site) between rounds.
    readonly roundMs: number;
    // How long ChatGPT must have stopped (no Stop button) before its words count as its whole answer.
    readonly settleMs: number;
    // How long a freshly opened page may take to show its message box.
    readonly readyMs: number;
    // How long one menu or button may take to answer a press.
    readonly stepMs: number;
    // How long the page may go without one good answer to a round (reloading, a frame gone) before it counts as lost.
    // Time rather than a count of rounds: a round that fails at once would otherwise spend the allowance in seconds.
    readonly silentMs: number;
    // The pause after a round the page did not answer, before the next.
    readonly retryMs: number;
}

const IMAGE_TIMING: ImageTiming = { capMs: 540_000, roundMs: 30_000, settleMs: 4000, readyMs: 20_000, stepMs: 6000, silentMs: 60_000, retryMs: 1000 };

// How long the person has to answer, when the card says every action is asked first.
const CONFIRM_TIMEOUT_MS = 120_000;
// Past a round's own cap, how long the worker waits for the page to hand its answer over.
const ROUND_GRACE_MS = 15_000;

// A chat this tool made, and the tab it lives in. Every chat it starts is temporary, and ChatGPT cannot load a
// temporary chat again by its address once its tab has left it, so "continue" means: that tab, still on that chat.
const ChatEntry = object({ chat: string(), tabId: number(), url: string(), temporary: boolean() });
type Chat = ReturnType<typeof ChatEntry.parse>;
const chats = kitMemory("chatgpt-chats", ChatEntry, 20);

// Tabs a call is working in right now: a second prompt into the same chat mid-answer would be judged against the
// first one's baseline.
const busy = new Set<number>();

// One step in the page: the helpers installed first (again, since the document may have been replaced since the last
// step), then the step. Undefined when the page did not answer.
const step = async <Args extends unknown[], Result>(tabId: number, func: (...args: Args) => Promise<Result | null> | Result | null, args: Args): Promise<Result | undefined> => {
    await injectTolerant(tabId, installReading, [CHATGPT_PAGE, CHATGPT_SITE.host]);
    await injectTolerant(tabId, installActing, []);
    await injectTolerant(tabId, installWatching, []);
    // SAFETY: a step answers its Result or null, and injectTolerant turns null into undefined.
    return (await injectTolerant(tabId, func, args)) as Result | undefined;
};

// The chat id an agent passed: one an earlier answer gave, or a chat's whole address.
const chatIdOf = (given: string): string => {
    const trimmed = given.trim();
    // The path is cut off the address by hand: `new URL` throws on a malformed one, which would not say what to pass.
    const fromUrl = /^https?:\/\//.test(trimmed) ? CHATGPT_SITE.chatPath.exec(trimmed.replace(/^https?:\/\/[^/?#]*/, ""))?.[1] : undefined;
    const id = fromUrl ?? trimmed;
    if (!/^(t-)?[A-Za-z0-9-]{6,80}$/.test(id)) {
        throw new RefusedError(`"${given}" is not a ChatGPT chat. Pass the \`chat\` an earlier chatgpt_image answer gave, or leave it out to start a new chat.`);
    }
    return id;
};

const gone = (id: string): RefusedError =>
    new RefusedError(
        `Chat "${id}" is gone: it was a temporary chat, and its tab was closed or has moved on to another page since, and ChatGPT cannot open a temporary chat again. Nothing was sent. Start a new chat: call chatgpt_image without \`chat\`, and describe the look again in the prompt.`,
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

interface Opened {
    readonly place: KitPlace;
    readonly known: Chat | undefined;
    // The chat was loaded by its address: one this tool did not start, which must show turns of its own once loaded.
    readonly byAddress: boolean;
}

// One of the account's own chats carries its memory, custom instructions and history, and ChatGPT has no switch to
// keep them out of one chat, so continuing there is only for a caller who asked for a personalized picture.
const personal = (id: string): RefusedError =>
    new RefusedError(
        `Chat "${id}" is one of the ChatGPT account's own chats, not a temporary chat this tool made: ChatGPT applies the owner's memory, custom instructions and chat history there, and that cannot be turned off for one chat. Nothing was opened or sent. Leave out \`chat\` to start a new, unpersonalized temporary chat, or pass personalized: true if the owner agrees to their history shaping the picture.`,
    );

const reopen = async (from: SandboxKey, id: string, personalized: boolean): Promise<Opened> => {
    const remembered = (await chats.list(from)).find((chat) => chat.chat === id);
    if (remembered !== undefined) {
        // allow(silent-catch): a tab closed since is a chat gone, which the lines below say
        const tab = await chrome.tabs.get(remembered.tabId).catch(() => undefined);
        if (tab?.id !== undefined && stillOn(tab.url, remembered)) {
            if (busy.has(tab.id)) {
                throw new RefusedError(`Another chatgpt_image call is still working in chat "${id}". Wait for its answer, then continue the chat.`);
            }
            if (!remembered.temporary && !personalized) {
                throw personal(id);
            }
            return { place: await frontKitTab(from, tab.id), known: remembered, byAddress: false };
        }
        if (remembered.temporary) {
            throw gone(id);
        }
    }
    if (id.startsWith("t-")) {
        throw gone(id);
    }
    if (!personalized) {
        throw personal(id);
    }
    return { place: await openKitTab(from, CHATGPT_SITE.chat(id)), known: undefined, byAddress: true };
};

// What a refusal says once the prompt may have gone: told only "paused" or "not allowed", an agent calls again once
// that is resolved, and sends the prompt a second time on the owner's quota.
const mayHaveGone = (tabId: number, reason: string): RefusedError =>
    new RefusedError(
        `${reason} The prompt may already have gone to ChatGPT in tab ${tabId}: do not send it again. Once this is resolved, look at that tab with snapshot, and save a finished image with save_media.`,
    );

// The kit's tab, permitted, and still on ChatGPT. A tab sent elsewhere is most likely at a sign-in page. `sent` is
// whether the prompt may have gone by now, which changes what a refusal must tell the agent.
const kitTab = async (from: SandboxKey, tabId: number, need: "read" | "act", sent: boolean): Promise<TargetTab> => {
    // allow(silent-catch): a closed tab is said as such just below
    const current = await chrome.tabs.get(tabId).catch(() => undefined);
    if (current === undefined) {
        throw new RefusedError(`ChatGPT's tab was closed during the call. Nothing more was done; call chatgpt_image again to start a new chat.`);
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

// Opens the page, checks it is ChatGPT signed in, and sets personalization on a new chat. Answers the counts to judge
// the answer against.
const prepare = async (from: SandboxKey, tab: TargetTab, opened: Opened, request: ImageRequest, timing: ImageTiming): Promise<Baseline> => {
    const ready = await step(tab.id, readyStep, [timing.readyMs]);
    // Signed out, ChatGPT still shows a message box, but nothing it makes is the owner's, and a temporary chat needs an account.
    if (ready === undefined || ready.signedOut || !ready.composer) {
        throw new RefusedError(
            ready?.signedOut === true
                ? `ChatGPT is not signed in in this browser: it shows "Log in". Ask the person to sign in to chatgpt.com, then call again. Nothing was sent.`
                : `ChatGPT's page has no message box to type into (it may still be loading, or ChatGPT changed its page). Nothing was sent. Try once more; if it says the same, tell the owner the ChatGPT kit needs fixing.`,
        );
    }
    if (opened.byAddress && ready.counts.user === 0) {
        throw new RefusedError(
            `ChatGPT did not load that chat from its address: it may have been a temporary chat, which cannot be opened again, or one this ChatGPT account does not have. Nothing was sent. Start a new chat: call chatgpt_image without \`chat\`.`,
        );
    }
    await confirm(from, tab);
    // The page and the person may have taken minutes to answer: the gates (a pause, a withdrawn grant) are asked again
    // before anything on the page is pressed.
    await kitTab(from, tab.id, "act", false);
    announce(tab.id, `The agent is making an image with ChatGPT`);
    if (opened.known === undefined && !opened.byAddress) {
        const want = request.personalized ? "personalized" : "unpersonalized";
        const set = await step(tab.id, personalizationStep, [want, timing.stepMs]);
        // A temporary chat starts personalized, so failing to turn it on again costs nothing; failing to turn it off
        // would let the owner's memory into the picture (a Naruto pastiche from a chat history, 2026-11-11).
        if (set?.ok !== true && want === "unpersonalized") {
            throw new RefusedError(
                `Nothing was sent: this temporary chat could not be made Unpersonalized (${set?.message ?? "the page did not answer"}), and a personalized chat lets the owner's memory and custom instructions into the picture. Try once more; if it says the same, ChatGPT changed its page: tell the owner the ChatGPT kit needs fixing, or pass personalized: true if they agree to a personalized chat.`,
            );
        }
    }
    const before = await step(tab.id, inspectStep, []);
    if (before === undefined) {
        throw new RefusedError(`ChatGPT's page stopped answering before the prompt was typed. Nothing was sent; call again.`);
    }
    return before.counts;
};

// Asked only when the card says every action is asked first: sending a prompt is not sensitive the way a payment is.
const confirm = async (from: SandboxKey, tab: TargetTab): Promise<void> => {
    if (!needsConfirm(await store.scopes(from), false)) {
        return;
    }
    if (!(await askPerson(from, tab, `Your agent wants to send a prompt to ChatGPT and save the image it makes. Allow it?`, CONFIRM_TIMEOUT_MS))) {
        throw new RefusedError(`The person said no (or did not answer) to sending a prompt to ChatGPT. Do not try another way round it; ask them what they would prefer.`);
    }
};

// Types the prompt and sends it. Sending moves ChatGPT from / to /c/<id>, which may cost the send step its answer:
// that is not a failure, and nothing here sends twice on its account. The watch that follows says whether it went.
const send = async (from: SandboxKey, tab: TargetTab, prompt: string, timing: ImageTiming, progress: Progress): Promise<void> => {
    await kitTab(from, tab.id, "act", false);
    const composed = await step(tab.id, composeStep, [prompt]);
    if (composed?.ok !== true) {
        throw new RefusedError(
            `Nothing was sent: ${composed?.message ?? "ChatGPT's page did not answer while the prompt was typed."} Try once more; if it says the same, tell the owner the ChatGPT kit needs fixing.`,
        );
    }
    progress.sent = true;
    await step(tab.id, sendStep, ["button", timing.stepMs]);
};

// How far a call got: once Send has been pressed, its tab holds the chat the agent is told about, and is kept.
interface Progress {
    sent: boolean;
}

// Watches round by round until ChatGPT is done or the call's cap. A prompt that plainly did not go (still in the box,
// nothing new on the page) is sent once more with Enter: with the box still full nothing can have gone yet, so that
// cannot be a second send.
const watch = async (from: SandboxKey, tab: TargetTab, baseline: Baseline, prompt: string, timing: ImageTiming, startedAt: number): Promise<Watched> => {
    let resent = false;
    let answeredAt = Date.now();
    let last: Watched | undefined;
    // The chat the prompt went to, once the tab's address names it: a tab moved on to another chat (the person's click,
    // in their own tabs) would have that chat's pictures judged against this one's baseline, and saved as this answer.
    let chatId = CHATGPT_SITE.chatPath.exec(new URL(tab.url).pathname)?.[1];
    for (;;) {
        const left = timing.capMs - (Date.now() - startedAt);
        if (left <= 0) {
            return { kind: "watch", outcome: "working", images: [], text: last?.text ?? "", failure: "", hint: last?.hint ?? "" };
        }
        const at = await kitTab(from, tab.id, "read", true);
        const now = CHATGPT_SITE.chatPath.exec(new URL(at.url).pathname)?.[1];
        chatId ??= now;
        if (chatId !== undefined && now !== chatId) {
            throw mayHaveGone(tab.id, `ChatGPT's tab moved on from its chat to ${at.url} while ChatGPT worked, so its answer was not read.`);
        }
        const round = Math.min(timing.roundMs, left);
        const seen = await within(step(tab.id, watchStep, [baseline, prompt, round, timing.settleMs]), round + ROUND_GRACE_MS, undefined);
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
const settle = async (from: SandboxKey, tab: TargetTab, known: Chat | undefined, byAddress: boolean): Promise<Chat> => {
    // allow(silent-catch): a tab gone this instant keeps the address it had a moment ago
    const url = (await chrome.tabs.get(tab.id).catch(() => undefined))?.url ?? tab.url;
    const id = CHATGPT_SITE.chatPath.exec(new URL(url).pathname)?.[1] ?? known?.chat ?? `t-${crypto.randomUUID().slice(0, 8)}`;
    const chat: Chat = { chat: id, tabId: tab.id, url, temporary: known?.temporary ?? !byAddress };
    const evicted = await chats.put(from, chat, (kept) => kept.chat === chat.chat || kept.tabId === chat.tabId);
    await Promise.all(evicted.filter((old) => old.tabId !== chat.tabId).map(async (old) => await letGo(from, old)));
    return chat;
};

// A chat the kit no longer remembers cannot be continued, so its tab is not kept for it: closed while it sits in the
// agent's own window still on that chat, else (the person's tab, or one moved on) made discardable again and left.
const letGo = async (from: SandboxKey, chat: Chat): Promise<void> => {
    // allow(silent-catch): a tab closed since needs nothing
    const tab = await chrome.tabs.get(chat.tabId).catch(() => undefined);
    if (tab === undefined) {
        return;
    }
    const window = await agentWindow(from);
    await releaseKitTab(chat.tabId, window?.id !== undefined && tab.windowId === window.id && stillOn(tab.url, chat));
};

const size = (bytes: number): string =>
    bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1000 ? `${Math.round(bytes / 1000)} kB` : `${bytes} bytes`;

const where = (chat: Chat, request: ImageRequest): string => {
    const kind = chat.temporary ? `a temporary chat, ${request.personalized ? "personalized" : "unpersonalized"}` : `one of the account's own chats`;
    const lives = chat.temporary
        ? ` A temporary chat lives only in that tab: it is gone once the tab closes or goes to another page.`
        : "";
    return `Chat: "${chat.chat}" (${kind}), in tab ${chat.tabId}, ${chat.url}. To make the next image in this same chat, for a consistent look, call chatgpt_image with chat "${chat.chat}".${lives}`;
};

const wrote = (text: string): string[] => (text === "" ? [] : [``, `ChatGPT wrote:`, text]);

// The answer for an outcome that is not a picture.
const notMade = (watched: Watched, chat: Chat, request: ImageRequest, timing: ImageTiming): RefusedError => {
    if (watched.outcome === "working") {
        const minutes = Math.round(timing.capMs / 60_000);
        return new RefusedError(
            [
                `ChatGPT was still working after ${minutes} minutes${watched.hint === "" ? "" : ` (it shows "${watched.hint}")`}. The prompt was sent: do not send it again. It may still finish: look at tab ${chat.tabId} later with snapshot, and save a finished image with save_media.`,
                where(chat, request),
            ].join("\n"),
        );
    }
    if (watched.outcome === "unsent") {
        return new RefusedError(
            `The prompt was typed into ChatGPT but did not send: it is still in the message box, twice pressed. Nothing was sent, so calling again is safe; if it says the same, ChatGPT changed its page: tell the owner the ChatGPT kit needs fixing.`,
        );
    }
    const limited = new RegExp(CHATGPT_PAGE.limit.source, CHATGPT_PAGE.limit.flags).test(watched.failure);
    const next =
        watched.outcome === "answered"
            ? `ChatGPT answered without making an image. If it asked something, answer it with chatgpt_image in this same chat; otherwise ask plainly for an image, in one sentence that starts with the style.`
            : limited
              ? `ChatGPT refused on a usage limit: "${watched.failure}". Calling again now fails the same way; wait until the limit resets, and tell the owner.`
              : `ChatGPT did not make an image: "${watched.failure.slice(0, 600)}". Change the prompt rather than repeating it, or start a new chat.`;
    return new RefusedError([next, where(chat, request), ...wrote(watched.text)].join("\n"));
};

const saveAll = async (from: SandboxKey, tab: TargetTab, images: FoundImage[], stem: string): Promise<{ saved: { file: SavedMedia; image: FoundImage }[]; failed: string[] }> => {
    const saved: { file: SavedMedia; image: FoundImage }[] = [];
    const failed: string[] = [];
    for (const [index, image] of images.entries()) {
        try {
            saved.push({ file: await saveMediaFromTab(from, tab.id, image.src, images.length === 1 ? stem : `${stem}-${index + 1}`), image });
        } catch (error) {
            failed.push(errorMessage(error));
        }
    }
    return { saved, failed };
};

const made = async (from: SandboxKey, tab: TargetTab, watched: Watched, chat: Chat, request: ImageRequest, createdWindow: boolean): Promise<string> => {
    const { saved, failed } = await saveAll(from, tab, watched.images, request.name ?? `chatgpt-${chat.chat.replace(/^t-/, "").slice(0, 8)}`);
    const count = `${watched.images.length} image${watched.images.length === 1 ? "" : "s"}`;
    const lines = saved.map(({ file, image }) => {
        const dimensions = image.width > 0 && image.height > 0 ? `, ${image.width}×${image.height}` : "";
        return `- ${file.path} (${size(file.bytes)}, ${file.mimeType}${dimensions})`;
    });
    const unsaved = failed.map((reason) => `- not saved: ${reason}`);
    const head =
        saved.length === 0
            ? `ChatGPT made ${count}, but none could be saved into the sandbox. They are on its page in tab ${tab.id}: take a snapshot there and save one with save_media, rather than asking ChatGPT again.`
            : `Made ${count} with ChatGPT and saved ${saved.length === watched.images.length ? (saved.length === 1 ? "it" : "them") : `${saved.length}`}:`;
    const opened = createdWindow ? [``, `(This opened a window of your own, behind the person's, so what they are doing is not interrupted.)`] : [];
    const text = [head, ...lines, ...unsaved, where(chat, request), ...wrote(watched.text), ...opened].join("\n");
    if (saved.length === 0) {
        throw new RefusedError(text);
    }
    return text;
};

const generate = async (from: SandboxKey, request: ImageRequest, opened: Opened, timing: ImageTiming, startedAt: number, progress: Progress): Promise<string> => {
    const tab = await kitTab(from, opened.place.tabId, "act", false);
    const baseline = await prepare(from, tab, opened, request, timing);
    await send(from, tab, request.prompt, timing, progress);
    const watched = await watch(from, tab, baseline, request.prompt, timing, startedAt);
    const chat = await settle(from, tab, opened.known, opened.byAddress);
    if (watched.outcome !== "done") {
        throw notMade(watched, chat, request, timing);
    }
    return await made(from, tab, watched, chat, request, opened.place.createdWindow);
};

export const chatgptImage = async (from: SandboxKey, request: ImageRequest, timing: ImageTiming = IMAGE_TIMING): Promise<string> => {
    const startedAt = Date.now();
    const [scopes, paused] = await Promise.all([store.scopes(from), store.paused()]);
    assertRunning(paused);
    assertScope(scopes, "act");
    // Before anything opens: a site the person never allowed is never loaded.
    await assertSiteAllowed(from, CHATGPT_SITE.home, "act");
    const opened =
        request.chat === undefined
            ? { place: await openKitTab(from, CHATGPT_SITE.newTemporaryChat), known: undefined, byAddress: false }
            : await reopen(from, chatIdOf(request.chat), request.personalized);
    const progress: Progress = { sent: false };
    busy.add(opened.place.tabId);
    try {
        return await generate(from, request, opened, timing, startedAt, progress);
    } finally {
        busy.delete(opened.place.tabId);
        await leaveKitTab(opened.place);
        // A tab this call opened and never sent from holds nothing to continue: closed, not left behind undiscardable.
        // One it did send from is kept, success or not: the chat lives there, and the agent is told to look at it.
        if (opened.place.createdTab && !progress.sent) {
            await releaseKitTab(opened.place.tabId, true);
        }
    }
};
