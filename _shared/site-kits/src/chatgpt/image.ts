import { KitRefusal } from "../host.js";
import { afterword, aside, imageLines, limited, saveImages, stemOf, UNSENT, where } from "./answers.js";
import { type ChatTiming, CHAT_TIMING, type Ran, runChat } from "./engine.js";
import type { ChatgptHost } from "./host.js";

// chatgpt_image: one prompt in, one saved picture out (2026-11-12). Since 2026-11-14 it is the chat engine (engine.ts)
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
const notMade = (host: ChatgptHost, ran: Ran, request: ImageRequest, timing: ChatTiming): KitRefusal => {
    const { watched, chat } = ran;
    const place = where(host.voice, chat, "chatgpt_image", request.personalized);
    if (watched.outcome === "working") {
        const minutes = Math.round(timing.capMs / 60_000);
        return new KitRefusal(
            [
                `ChatGPT was still working after ${minutes} minutes${watched.hint === "" ? "" : ` (it shows "${watched.hint}")`}. The prompt was sent: do not send it again. It may still finish: collect it later with chatgpt_read (chat "${chat.chat}"), which saves the image.`,
                place,
            ].join("\n"),
        );
    }
    if (watched.outcome === "unsent") {
        return new KitRefusal(UNSENT);
    }
    if (watched.outcome === "asking") {
        return new KitRefusal(
            [
                `ChatGPT is waiting for the person to press "${watched.asks}" in ${host.voice.page(chat.tabId)}; this kit never presses ChatGPT's own confirmations. Ask the person to look, then collect the image with chatgpt_read (chat "${chat.chat}").${aside(host.voice.asking)}`,
                place,
            ].join("\n"),
        );
    }
    const next =
        watched.outcome === "answered" || watched.outcome === "done"
            ? `ChatGPT answered without making an image. If it asked something, answer it with chatgpt_image in this same chat; otherwise ask plainly for an image, in one sentence that starts with the style.`
            : limited(watched.failure)
              ? `ChatGPT refused on a usage limit: "${watched.failure}". Calling again now fails the same way; wait until the limit resets, and tell the owner.`
              : `ChatGPT did not make an image: "${watched.failure.slice(0, 600)}". Change the prompt rather than repeating it, or start a new chat.`;
    return new KitRefusal([next, place, ...wrote(watched.text)].join("\n"));
};

const made = async (host: ChatgptHost, ran: Ran, request: ImageRequest): Promise<string> => {
    const { page, watched, chat } = ran;
    const { saved, failed } = await saveImages(host, page, watched.images, stemOf(chat, request.name));
    const count = `${watched.images.length} image${watched.images.length === 1 ? "" : "s"}`;
    const head =
        saved.length === 0
            ? `ChatGPT made ${count}, but none could be saved into the sandbox. They are on its page in ${host.voice.page(page)}: take a snapshot there and save one with ${host.voice.saveTool}, rather than asking ChatGPT again.`
            : `Made ${count} with ChatGPT and saved ${saved.length === watched.images.length ? (saved.length === 1 ? "it" : "them") : `${saved.length}`}:`;
    const notes = ran.notes.length === 0 ? [] : [``, ...ran.notes];
    const text = [head, ...imageLines(saved, failed), where(host.voice, chat, "chatgpt_image", request.personalized), ...notes, ...wrote(watched.text), ...afterword(ran.afterword)].join(
        "\n",
    );
    if (saved.length === 0) {
        throw new KitRefusal(text);
    }
    return text;
};

export const chatgptImage = async <File>(host: ChatgptHost<File>, request: ImageRequest, timing: ImageTiming = CHAT_TIMING): Promise<string> =>
    await runChat(
        host,
        { prompt: request.prompt, chat: request.chat, mode: "image", files: [], personalized: request.personalized, temporary: request.temporary === true },
        async (ran) => (ran.watched.outcome === "done" && ran.watched.images.length > 0 ? await made(host, ran, request) : Promise.reject(notMade(host, ran, request, timing))),
        timing,
        "chatgpt_image",
    );
