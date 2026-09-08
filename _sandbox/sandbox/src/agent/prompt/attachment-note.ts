import { extname } from "node:path";

// Claude SDK reads attachments via its Read tool, so paths ride the prompt as a note; other providers split images out
// as native inputs and reference the rest by path. Builder and stripper live together so a reopened transcript can
// recognize what a turn injected.

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
    files.length === 0 ? prompt : `${prompt}\n\nThe user attached these files: read them as needed:\n${files.map((path) => `- ${path}`).join("\n")}`;

const NOTE_HEADER = "The user attached these files: read them with the Read tool as needed:";

// Claude Code's attachment mechanism: its Read tool handles files from disk. An empty prompt means an attachment-only
// message, where the note is the whole thing.
export const withAttachmentNote = (prompt: string, paths: readonly string[]): string => {
    const note = `${NOTE_HEADER}\n${paths.map((path) => `- ${path}`).join("\n")}`;
    return prompt === "" ? note : `${prompt}\n\n${note}`;
};

// Anchored, not fuzzy: only a message ending in the header followed by nothing but `- path` lines is touched, so quoted
// wording elsewhere survives.
export const stripAttachmentNote = (text: string): { text: string; attachments: string[] } => {
    const marker = `\n\n${NOTE_HEADER}\n`;
    const at = text.startsWith(`${NOTE_HEADER}\n`) ? 0 : text.lastIndexOf(marker);
    if (at === -1) {
        return { text, attachments: [] };
    }
    const lines = text.slice(at === 0 ? NOTE_HEADER.length + 1 : at + marker.length).split("\n");
    if (!lines.every((line) => line.startsWith("- "))) {
        return { text, attachments: [] };
    }
    return { text: at === 0 ? "" : text.slice(0, at), attachments: lines.map((line) => line.slice(2)) };
};

// Attachments ride as absolute paths; each adapter decides whether they become native image inputs or a file list.
// Lives here, not in turn-plan, since providers now own their own request-building.
export const withAttachments = <R extends { readonly attachments?: readonly string[] }>(request: R, paths: readonly string[]): R =>
    paths.length > 0 ? { ...request, attachments: [...paths] } : request;
