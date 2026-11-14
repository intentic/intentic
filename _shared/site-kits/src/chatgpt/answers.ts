import { errorMessage } from "@intentic/base/errors";
import { KitRefusal, type SavedFile } from "../host.js";
import { type Chat, type ChatRequest, type ChatTiming, CHAT_TIMING, type Mode, type Ran, readChat, runChat } from "./engine.js";
import type { ChatgptHost, ChatgptVoice } from "./host.js";
import type { FoundImage } from "./page-hands.js";
import { CHATGPT_PAGE } from "./site.js";

// What the agent is told after chatgpt_send and chatgpt_read: ChatGPT's words, whatever pictures it made (saved into
// the sandbox), and where the chat is to go on in. image.ts words chatgpt_image's own answers on the same pieces.

// An answer past this many characters is saved whole as a Markdown file and only its start handed back: a Deep Research
// report runs to tens of thousands, more than a tool answer should carry.
const INLINE_CHARS = 6000;
const EXCERPT_CHARS = 2500;

const size = (bytes: number): string =>
    bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1000 ? `${Math.round(bytes / 1000)} kB` : `${bytes} bytes`;

// Where the chat is, and how to go on in it.
export const where = (voice: ChatgptVoice, chat: Chat, tool: string, personalized: boolean): string => {
    const kind =
        chat.home === "temporary"
            ? `a temporary chat, ${personalized ? "personalized" : "unpersonalized"}`
            : chat.home === "project"
              ? `in this sandbox's ChatGPT project`
              : `one of the account's own chats`;
    const lives = chat.home === "temporary" ? ` A temporary chat lives only in that tab: it is gone once the tab closes or goes to another page.` : "";
    return `Chat: "${chat.chat}" (${kind}), in ${voice.page(chat.tabId)}, ${chat.url}. To go on in this same chat, call ${tool} with chat "${chat.chat}".${lives}`;
};

export interface SavedImage {
    readonly file: SavedFile;
    readonly image: FoundImage;
}

export const saveImages = async (
    host: ChatgptHost,
    page: number,
    images: readonly FoundImage[],
    stem: string,
): Promise<{ saved: SavedImage[]; failed: string[] }> => {
    const saved: SavedImage[] = [];
    const failed: string[] = [];
    for (const [index, image] of images.entries()) {
        try {
            saved.push({ file: await host.saveImage(page, image.src, images.length === 1 ? stem : `${stem}-${index + 1}`), image });
        } catch (error) {
            failed.push(errorMessage(error));
        }
    }
    return { saved, failed };
};

export const imageLines = (saved: readonly SavedImage[], failed: readonly string[]): string[] => [
    ...saved.map(({ file, image }) => {
        const dimensions = image.width > 0 && image.height > 0 ? `, ${image.width}×${image.height}` : "";
        return `- ${file.path} (${size(file.bytes)}, ${file.mimeType}${dimensions})`;
    }),
    ...failed.map((reason) => `- not saved: ${reason}`),
];

export const stemOf = (chat: Chat, name: string | undefined): string => name ?? `chatgpt-${chat.chat.replace(/^t-/, "").slice(0, 8)}`;

// The host's own sentence after another (host.ts, voice.asking), or nothing.
export const aside = (said: string): string => (said === "" ? "" : ` ${said}`);

// The host's last word on a finished answer (host.ts, open), set apart by a blank line.
export const afterword = (said: string): string[] => (said === "" ? [] : [``, said]);

// ChatGPT's words: whole when short, else saved as a file and begun here. `label` heads words that are not its answer
// yet (still working, waiting on the person).
const words = async (host: ChatgptHost, text: string, stem: string, label = "ChatGPT wrote:"): Promise<string[]> => {
    if (text === "") {
        return [];
    }
    if (text.length <= INLINE_CHARS) {
        return [``, label, text];
    }
    try {
        const file = await host.saveText(text, stem);
        return [``, `ChatGPT's answer is ${text.length} characters, saved whole at ${file.path}. It begins:`, `${text.slice(0, EXCERPT_CHARS)}…`];
    } catch (error) {
        return [``, `ChatGPT's answer is ${text.length} characters and could not be saved (${errorMessage(error)}); its first ${INLINE_CHARS}:`, text.slice(0, INLINE_CHARS)];
    }
};

const duration = (ms: number): string => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

// Whether what ChatGPT said when it failed is its usage limit.
export const limited = (failure: string): boolean => new RegExp(CHATGPT_PAGE.limit.source, CHATGPT_PAGE.limit.flags).test(failure);

export const UNSENT = `The prompt was typed into ChatGPT but did not send: it is still in the message box, twice pressed. Nothing was sent, so calling again is safe; if it says the same, ChatGPT changed its page: tell the owner the ChatGPT kit needs fixing.`;

interface Described {
    readonly name?: string | undefined;
    readonly personalized: boolean;
    readonly waitedMs: number;
}

// The answer for every outcome. Still working and waiting on the person are states the agent acts on, not failures, so
// they come back as answers; a failure throws, with ChatGPT's words.
const describe = async (host: ChatgptHost, ran: Ran, request: Described): Promise<string> => {
    const { page, watched, chat } = ran;
    const place = where(host.voice, chat, "chatgpt_send", request.personalized);
    const notes = ran.notes.length === 0 ? [] : [``, ...ran.notes];
    const stem = stemOf(chat, request.name);
    if (watched.outcome === "unsent") {
        throw new KitRefusal(UNSENT);
    }
    if (watched.outcome === "failed") {
        const head = limited(watched.failure)
            ? `ChatGPT refused on a usage limit: "${watched.failure}". Calling again now fails the same way; wait until the limit resets, and tell the owner.`
            : `ChatGPT failed: "${watched.failure.slice(0, 600)}". Change the prompt rather than repeating it, or start a new chat.`;
        throw new KitRefusal([head, place, ...notes].join("\n"));
    }
    const { saved, failed } = await saveImages(host, page, watched.images, stem);
    const pictures = watched.images.length === 0 ? [] : [``, `ChatGPT made ${watched.images.length} image${watched.images.length === 1 ? "" : "s"}:`, ...imageLines(saved, failed)];
    const finished = watched.outcome === "done" || watched.outcome === "answered";
    const said = await words(host, watched.text, stem, finished ? "ChatGPT wrote:" : "So far it shows:");
    if (watched.outcome === "asking") {
        const head = `ChatGPT is waiting for the person to press "${watched.asks}" in ${host.voice.page(page)}. This kit never presses ChatGPT's own confirmations: ask the person to look at that tab and decide, then collect the answer with chatgpt_read (chat "${chat.chat}"). Do not send the prompt again.${aside(host.voice.asking)}`;
        return [head, place, ...notes, ...pictures, ...said].join("\n");
    }
    if (watched.outcome === "working") {
        const hint = watched.hint === "" ? "" : ` (it shows "${watched.hint}")`;
        const head = `ChatGPT is still working after ${duration(request.waitedMs)}${hint}. The prompt was sent: do not send it again. Collect the answer with chatgpt_read (chat "${chat.chat}", wait up to 540 s a call); Deep research and agent mode often take 5 to 30 minutes.`;
        return [head, place, ...notes, ...pictures, ...said].join("\n");
    }
    const head = said.length === 0 && pictures.length === 0 ? `ChatGPT finished without words or pictures.` : `ChatGPT answered.`;
    return [head, place, ...notes, ...pictures, ...said, ...afterword(ran.afterword)].join("\n");
};

export interface SendRequest {
    readonly prompt: string;
    readonly chat?: string | undefined;
    readonly mode: Mode;
    // The host's references to the files to attach (host.ts, collectFiles).
    readonly files: readonly string[];
    readonly waitSeconds?: number | undefined;
    readonly name?: string | undefined;
    readonly personalized: boolean;
    readonly temporary: boolean;
}

export interface ReadRequest {
    readonly chat: string;
    readonly waitSeconds?: number | undefined;
    readonly name?: string | undefined;
}

export const chatgptSend = async <File>(host: ChatgptHost<File>, request: SendRequest, timing: ChatTiming = CHAT_TIMING): Promise<string> => {
    const waitMs = request.waitSeconds === undefined ? undefined : request.waitSeconds * 1000;
    const chat: ChatRequest = { ...request, waitMs };
    const waitedMs = Math.min(waitMs ?? timing.capMs, timing.capMs);
    return await runChat(host, chat, async (ran) => await describe(host, ran, { name: request.name, personalized: request.personalized, waitedMs }), timing);
};

export const chatgptRead = async (host: ChatgptHost, request: ReadRequest, timing: ChatTiming = CHAT_TIMING): Promise<string> => {
    const waitMs = (request.waitSeconds ?? 0) * 1000;
    const waitedMs = Math.min(waitMs, timing.capMs);
    return await readChat(host, request.chat, waitMs, async (ran) => await describe(host, ran, { name: request.name, personalized: false, waitedMs }), timing);
};
