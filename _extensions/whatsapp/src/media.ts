import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { unwrap } from "./content.js";
import type { WaRawMessage } from "./types.js";

// Files in and out of WhatsApp, without baileys: what message a workspace file becomes, how audio becomes a voice
// note, and what a received medium is saved as.

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const AUDIO_TYPES = new Map([
    [".mp3", "audio/mpeg"],
    [".m4a", "audio/mp4"],
    [".aac", "audio/aac"],
    [".ogg", "audio/ogg; codecs=opus"],
    [".opus", "audio/ogg; codecs=opus"],
    [".wav", "audio/wav"],
]);
// A voice note is Ogg/Opus; WhatsApp plays nothing else with the voice-note waveform.
export const VOICE_MIME = "audio/ogg; codecs=opus";

export type FileContent =
    | { readonly image: Buffer; readonly caption: string }
    | { readonly audio: Buffer; readonly mimetype: string; readonly ptt: boolean }
    | { readonly document: Buffer; readonly fileName: string; readonly mimetype: string };

// Images arrive as photos and audio as playable audio; everything else goes as a document with its filename intact.
export const fileContentOf = async (path: string): Promise<FileContent> => {
    const buffer = await readFile(path);
    const name = basename(path);
    const extension = extname(path).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
        return { image: buffer, caption: name };
    }
    const audio = AUDIO_TYPES.get(extension);
    if (audio !== undefined) {
        return { audio: buffer, mimetype: audio, ptt: false };
    }
    return { document: buffer, fileName: name, mimetype: "application/octet-stream" };
};

const runFile = promisify(execFile);

// An audio file as an Ogg/Opus voice note: as it is when it already is one, else converted with ffmpeg when present.
export const voiceNoteOf = async (path: string): Promise<Buffer> => {
    const extension = extname(path).toLowerCase();
    if (extension === ".ogg" || extension === ".opus") {
        return readFile(path);
    }
    const scratch = await mkdtemp(join(tmpdir(), "wa-voice-"));
    const out = join(scratch, "voice.ogg");
    try {
        await runFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", out]);
        return await readFile(out);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            throw new Error(
                `A voice note must be Ogg/Opus, and converting ${extension || "this file"} needs ffmpeg, which this sandbox lacks: send an .ogg/.opus file, or send it with send-file as ordinary audio`,
                { cause: error },
            );
        }
        throw error;
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
};

// The file extension for a downloaded medium, derived from its declared mimetype.
const extensionOf = (mimetype: string | null | undefined): string => {
    const subtype = mimetype?.split("/")[1]?.split(";")[0]?.trim();
    return subtype === undefined || subtype === "" ? "bin" : subtype.replace("jpeg", "jpg");
};

// Filename a raw message's media should be saved as; a document keeps its own name, others use kind plus extension.
export const mediaNameOf = (raw: WaRawMessage): string | undefined => {
    const inner = unwrap(raw.message);
    const document = inner?.documentMessage;
    if (document !== undefined && document !== null) {
        return document.fileName ?? `document.${extensionOf(document.mimetype)}`;
    }
    const slots = [
        ["photo", inner?.imageMessage],
        ["voice", inner?.audioMessage],
        ["video", inner?.videoMessage],
        ["sticker", inner?.stickerMessage],
    ] as const;
    const found = slots.find(([, slot]) => slot !== undefined && slot !== null);
    return found === undefined ? undefined : `${found[0]}.${extensionOf(found[1]?.mimetype)}`;
};
