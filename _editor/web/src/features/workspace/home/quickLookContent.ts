import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import type { ShikiLang } from "@intentic/code-read/langs";
import { type FileCategory, formatOf } from "@intentic/ui/file-format";
import { t } from "@intentic/ui/i18n";
import { resolveFile } from "../explorer/fileType";

// What a hover can show of an entry, and what to call it. Text gets its first lines, a picture gets painted, a video
// plays silently, a document is drawn as its own first page, a folder lists what it holds; anything else (a PDF, an
// archive, a font) has no cheap look and gets its name and size only. Pure, no framework code.

export type QuickLookKind = "folder" | "text" | "picture" | "video" | "document" | "none";

export interface QuickLookPlan {
    readonly kind: QuickLookKind;
    // Shiki grammar for the text kind; undefined renders plain.
    readonly lang?: ShikiLang;
}

// Parsed on the main thread under the pointer, so a document this big is left to the tab that can afford it.
const DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
const documentPlan = (size: number | undefined): QuickLookPlan => ((size ?? 0) > DOCUMENT_MAX_BYTES ? { kind: `none` } : { kind: `document` });

export const quickLookPlan = (entry: WorkspaceTreeEntry): QuickLookPlan => {
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

// The word for a format with no name of its own; built when read so it follows the language.
const byCategory = (category: FileCategory): string =>
    (
        ({
            code: t(`workspace.quickLookContent.code`),
            style: t(`workspace.quickLookContent.style`),
            config: t(`workspace.quickLookContent.config`),
            data: t(`workspace.quickLookContent.data`),
            image: t(`workspace.quickLookContent.image`),
            audio: t(`workspace.quickLookContent.audio`),
            video: t(`workspace.quickLookContent.video`),
            doc: t(`workspace.quickLookContent.doc`),
            shell: t(`workspace.quickLookContent.shell`),
            archive: t(`workspace.quickLookContent.archive`),
            lock: t(`workspace.quickLookContent.lock`),
            binary: t(`workspace.quickLookContent.file`),
            generic: t(`workspace.quickLookContent.file`),
        }) satisfies Record<FileCategory, string>
    )[category];

export const kindLabel = (entry: Pick<WorkspaceTreeEntry, "name" | "type">): string => {
    if (entry.type === `dir`) {
        return t(`workspace.quickLookContent.folder`);
    }
    const format = formatOf(entry.name);
    return format.label ?? byCategory(format.category);
};

// Lines the card shows: enough to recognise a file, few enough to stay a glance.
export const QUICK_LOOK_LINES = 14;
// Bytes asked for: QUICK_LOOK_LINES of long lines, and a cheap round trip whatever the file's size.
export const QUICK_LOOK_BYTES = 2048;

// The card's text: the first QUICK_LOOK_LINES lines, a cut line dropped rather than shown torn. `bytes` is how much of the
// file `content` decodes from; a window shorter than the file may end mid-line.
export const quickLookLines = (content: string, bytes: number, size: number): string => {
    const lines = content.split(`\n`);
    const whole = bytes >= size;
    const kept = whole ? lines : lines.slice(0, -1);
    return kept.slice(0, QUICK_LOOK_LINES).join(`\n`);
};
