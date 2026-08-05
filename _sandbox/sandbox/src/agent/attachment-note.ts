import { extname } from "node:path";

/* How user-attached files reach the model. On the Claude SDK the Read tool handles them from disk, so the
 * paths ride the prompt as a note (withAttachmentNote); a provider that isn't the Claude SDK gets raster
 * images split out as native image inputs and the rest referenced by path (splitAttachments/withFileNote —
 * the codex, grok, and acp adapters). The SDK transcript stores the combined prompt verbatim, so a reopened
 * tab would redraw the note as the user's own words — builder and stripper live together so session restore
 * recognizes exactly what a turn injected and turns it back into attachment chips. */

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

const NOTE_HEADER = "The user attached these files — read them with the Read tool as needed:";

// Fold attached-file paths into the prompt — Claude Code's canonical attachment mechanism (its Read tool
// handles images and PDFs from disk natively, same as dragging a file into the CLI). An empty prompt is the
// attachment-only message (a screenshot with nothing typed), where the note IS the message.
export const withAttachmentNote = (prompt: string, paths: readonly string[]): string => {
    const note = `${NOTE_HEADER}\n${paths.map((path) => `- ${path}`).join("\n")}`;
    return prompt === "" ? note : `${prompt}\n\n${note}`;
};

// The restore-side inverse. Anchored, not fuzzy: only a message that ENDS with the note — the header line
// followed by nothing but `- path` lines — is touched, so a user who quoted the wording mid-message keeps
// their text intact. An attachment-only message strips to empty text, exactly what the send appended locally.
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
