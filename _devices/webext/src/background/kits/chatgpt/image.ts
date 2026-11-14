import { RefusedError } from "../../policy.js";
import type { SandboxKey } from "../../store.js";
import { imageLines, saveImages, stemOf, where, windowNote } from "./answers.js";
import { type ChatTiming, CHAT_TIMING, type Ran, runChat } from "./chat.js";
import { CHATGPT_PAGE } from "./site.js";

// chatgpt_image: one prompt in, one saved picture out (2026-11-12). Since 2026-11-14 it is the chat engine (chat.ts)
// judged as a picture: done means an image came, and words alone are not an answer. Its chats live in the sandbox's
// project like chatgpt_send's, unless `temporary`.

export interface ImageRequest {
    readonly prompt: string;
    readonly chat?: string | undefined;
    readonly name?: string | undefined;
    readonly personalized: boolean;
    readonly temporary?: boolean | undefined;
}

// Kept under its first name for the suites that drive it with short times.
export type ImageTiming = ChatTiming;

const wrote = (text: string): string[] => (text === "" ? [] : [``, `ChatGPT wrote:`, text.slice(0, 4000)]);

// The answer for an outcome that is not a picture.
const notMade = (ran: Ran, request: ImageRequest, timing: ChatTiming): RefusedError => {
    const { watched, chat } = ran;
    const place = where(chat, "chatgpt_image", request.personalized);
    if (watched.outcome === "working") {
        const minutes = Math.round(timing.capMs / 60_000);
        return new RefusedError(
            [
                `ChatGPT was still working after ${minutes} minutes${watched.hint === "" ? "" : ` (it shows "${watched.hint}")`}. The prompt was sent: do not send it again. It may still finish: collect it later with chatgpt_read (chat "${chat.chat}"), which saves the image.`,
                place,
            ].join("\n"),
        );
    }
    if (watched.outcome === "unsent") {
        return new RefusedError(
            `The prompt was typed into ChatGPT but did not send: it is still in the message box, twice pressed. Nothing was sent, so calling again is safe; if it says the same, ChatGPT changed its page: tell the owner the ChatGPT kit needs fixing.`,
        );
    }
    if (watched.outcome === "asking") {
        return new RefusedError(
            [`ChatGPT is waiting for the person to press "${watched.asks}" in tab ${chat.tabId}; this kit never presses ChatGPT's own confirmations. Ask the person to look, then collect the image with chatgpt_read (chat "${chat.chat}").`, place].join("\n"),
        );
    }
    const limited = new RegExp(CHATGPT_PAGE.limit.source, CHATGPT_PAGE.limit.flags).test(watched.failure);
    const next =
        watched.outcome === "answered" || watched.outcome === "done"
            ? `ChatGPT answered without making an image. If it asked something, answer it with chatgpt_image in this same chat; otherwise ask plainly for an image, in one sentence that starts with the style.`
            : limited
              ? `ChatGPT refused on a usage limit: "${watched.failure}". Calling again now fails the same way; wait until the limit resets, and tell the owner.`
              : `ChatGPT did not make an image: "${watched.failure.slice(0, 600)}". Change the prompt rather than repeating it, or start a new chat.`;
    return new RefusedError([next, place, ...wrote(watched.text)].join("\n"));
};

const made = async (from: SandboxKey, ran: Ran, request: ImageRequest): Promise<string> => {
    const { tab, watched, chat } = ran;
    const { saved, failed } = await saveImages(from, tab, watched.images, stemOf(chat, request.name));
    const count = `${watched.images.length} image${watched.images.length === 1 ? "" : "s"}`;
    const head =
        saved.length === 0
            ? `ChatGPT made ${count}, but none could be saved into the sandbox. They are on its page in tab ${tab.id}: take a snapshot there and save one with save_media, rather than asking ChatGPT again.`
            : `Made ${count} with ChatGPT and saved ${saved.length === watched.images.length ? (saved.length === 1 ? "it" : "them") : `${saved.length}`}:`;
    const notes = ran.notes.length === 0 ? [] : [``, ...ran.notes];
    const text = [head, ...imageLines(saved, failed), where(chat, "chatgpt_image", request.personalized), ...notes, ...wrote(watched.text), ...windowNote(ran.createdWindow)].join("\n");
    if (saved.length === 0) {
        throw new RefusedError(text);
    }
    return text;
};

export const chatgptImage = async (from: SandboxKey, request: ImageRequest, timing: ImageTiming = CHAT_TIMING): Promise<string> =>
    await runChat(
        from,
        { prompt: request.prompt, chat: request.chat, mode: "image", tickets: [], personalized: request.personalized, temporary: request.temporary === true },
        async (ran) => (ran.watched.outcome === "done" && ran.watched.images.length > 0 ? await made(from, ran, request) : Promise.reject(notMade(ran, request, timing))),
        timing,
        "chatgpt_image",
    );
