import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { TurnSpec } from "../../agent/providers/agent-request.js";
import { splitAttachments } from "../../agent/prompt/attachment-note.js";

// A turn's attachments as a vendor runtime takes them: pictures it can see natively read off disk, and everything else
// left for the prompt to name for its read tool. A picture that cannot be read is named instead of dropped.

// Mime type per raster extension, for every runtime that attaches pictures natively; anything else reads as PNG.
const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};

export interface AttachedImage {
    readonly path: string;
    readonly mimeType: string;
    // The file's bytes, base64: each runtime wraps them in its own part shape.
    readonly data: string;
}

export interface TurnAttachments {
    // Pictures read off disk, in attachment order; none for a runtime that takes no pictures natively.
    readonly images: readonly AttachedImage[];
    // Pictures not sent as pictures (unreadable, or a runtime that can't take them), to be named in the prompt.
    readonly unread: readonly string[];
    // Every picture's path, read or not, for a phase that names them all.
    readonly pictures: readonly string[];
    // Every attachment that isn't a picture.
    readonly files: readonly string[];
}

// `native` is whether this runtime (or this connection) takes pictures as input at all.
export const loadAttachments = async (spec: Pick<TurnSpec, "attachments">, native: boolean): Promise<TurnAttachments> => {
    const { images: pictures, others: files } = splitAttachments(spec.attachments);
    if (!native) {
        return { images: [], unread: [...pictures], pictures, files };
    }
    const images: AttachedImage[] = [];
    const unread: string[] = [];
    for (const path of pictures) {
        try {
            const data = await readFile(path);
            images.push({ path, mimeType: IMAGE_MIME[extname(path).toLowerCase()] ?? "image/png", data: data.toString("base64") });
        } catch {
            unread.push(path);
        }
    }
    return { images, unread, pictures, files };
};
