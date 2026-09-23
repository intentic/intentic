import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import type { ShikiLang } from "@intentic/code-read/langs";
import { type FileCategory, formatOf } from "@intentic/ui/file-format";
import { resolveFile } from "../explorer/fileType";

// What a hover can show of an entry, and what to call it. Text gets its first lines, a picture gets painted, a video
// plays silently, a document is drawn as its own first page, a folder lists what it holds; anything else (a PDF, an
// archive, a font) has no cheap look and gets its name and size only. Pure, no framework code.

export type PeekKind = "folder" | "text" | "picture" | "video" | "document" | "none";

export interface PeekPlan {
    readonly kind: PeekKind;
    // Shiki grammar for the text kind; undefined renders plain.
    readonly lang?: ShikiLang;
}

// Parsed on the main thread under the pointer, so a document this big is left to the tab that can afford it.
const DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
const documentPlan = (size: number | undefined): PeekPlan => ((size ?? 0) > DOCUMENT_MAX_BYTES ? { kind: `none` } : { kind: `document` });

export const peekPlan = (entry: WorkspaceTreeEntry): PeekPlan => {
    if (entry.type === `dir`) {
        return { kind: `folder` };
    }
    // Nothing to read or paint; the card's size line says "0 B" on its own.
    if (entry.size === 0) {
        return { kind: `none` };
    }
    const format = formatOf(entry.name);
    if (format.category === `image`) {
        return { kind: `picture` };
    }
    if (format.category === `video`) {
        return { kind: `video` };
    }
    if (format.pages === true) {
        return documentPlan(entry.size);
    }
    const resolved = resolveFile(entry.path, entry.size);
    if (resolved.mode === `binary` || resolved.mode === `empty`) {
        return { kind: `none` };
    }
    return resolved.lang === undefined ? { kind: `text` } : { kind: `text`, lang: resolved.lang };
};

// The word for a format with no name of its own.
const BY_CATEGORY: Record<FileCategory, string> = {
    code: `Code`,
    style: `Style sheet`,
    config: `Config`,
    data: `Data`,
    image: `Picture`,
    audio: `Sound`,
    video: `Video`,
    doc: `Document`,
    shell: `Script`,
    archive: `Archive`,
    lock: `Lockfile`,
    binary: `File`,
    generic: `File`,
};

export const kindLabel = (entry: Pick<WorkspaceTreeEntry, "name" | "type">): string => {
    if (entry.type === `dir`) {
        return `Folder`;
    }
    const format = formatOf(entry.name);
    return format.label ?? BY_CATEGORY[format.category];
};

// Lines the card shows: enough to recognise a file, few enough to stay a glance.
export const PEEK_LINES = 14;
// Bytes asked for: PEEK_LINES of long lines, and a cheap round trip whatever the file's size.
export const PEEK_BYTES = 2048;

// The card's text: the first PEEK_LINES lines, a cut line dropped rather than shown torn. `bytes` is how much of the
// file `content` decodes from; a window shorter than the file may end mid-line.
export const peekLines = (content: string, bytes: number, size: number): string => {
    const lines = content.split(`\n`);
    const whole = bytes >= size;
    const kept = whole ? lines : lines.slice(0, -1);
    return kept.slice(0, PEEK_LINES).join(`\n`);
};
