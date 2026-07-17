import { extname } from "node:path";

/* How user-attached files reach a provider that isn't the Claude SDK (whose Read tool handles them from
 * disk): raster images the model accepts natively are split out to ride as image inputs, everything else is
 * referenced by path in the prompt for the agent's own tools to read. Shared by the codex, grok, and acp
 * adapters. */

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export const splitAttachments = (attachments: readonly string[] = []): { images: string[]; others: string[] } => {
    const images: string[] = [];
    const others: string[] = [];
    for (const path of attachments) {
        (IMAGE_EXTS.has(extname(path).toLowerCase()) ? images : others).push(path);
    }
    return { images, others };
};

export const withFileNote = (prompt: string, files: readonly string[]): string =>
    files.length === 0 ? prompt : `${prompt}\n\nThe user attached these files — read them as needed:\n${files.map((path) => `- ${path}`).join("\n")}`;
