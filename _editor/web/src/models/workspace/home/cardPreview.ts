import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { formatOf } from "@intentic/ui/file-format";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { readFileWindow } from "../files/fileWindow";
import { QUICK_LOOK_BYTES, quickLookLines, quickLookPlan } from "./quickLookContent";

// What a home card draws of a file: the start of it, as the quick look reads it (quickLookContent.ts), never more than
// QUICK_LOOK_BYTES. A text file's own first lines; a document's (a Word file, a PDF) the markdown copy the sandbox already
// keeps beside it, read and never derived here, so a card costs a small read and no parse. Kept per file version, so a
// card scrolled away and back paints at once, and the quick look's own read stays the quick look's.

export interface CardPreview {
    readonly kind: "markdown" | "text";
    readonly text: string;
}

const KEPT = 200;
const asked = new Map<string, Promise<CardPreview | undefined>>();
const settled = new Map<string, CardPreview | undefined>();

const versionOf = (entry: WorkspaceTreeEntry): string => `${entry.path}\n${entry.size ?? 0}\n${entry.mtime ?? 0}`;

// A miniature cannot show a picture, and a README's badges and banner would each be a request for nothing.
const withoutPictures = (markdown: string): string =>
    markdown
        .replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, ``)
        .replaceAll(/<(img|picture|source|video)\b[^>]*>/giu, ``)
        .replaceAll(/<\/(picture|video)>/giu, ``);

const read = async (entry: WorkspaceTreeEntry): Promise<CardPreview | undefined> => {
    if (formatOf(entry.name).pages === true) {
        const derived = await sandboxRpc.workspace.derived({ path: entry.path });
        return derived.present ? { kind: `markdown`, text: withoutPictures(derived.content.slice(0, QUICK_LOOK_BYTES)) } : undefined;
    }
    const plan = quickLookPlan(entry);
    if (plan.kind !== `markdown` && plan.kind !== `text`) {
        return undefined;
    }
    const window = await readFileWindow(entry.path, { limit: QUICK_LOOK_BYTES });
    if (!window.present || window.content.includes(`\0`)) {
        return undefined;
    }
    const text = quickLookLines(window.content, window.bytes, window.size);
    if (text.trim() === ``) {
        return undefined;
    }
    return plan.kind === `markdown` ? { kind: `markdown`, text: withoutPictures(text) } : { kind: `text`, text };
};

/** The card's preview, read once per version of the file; undefined where it has nothing to show or the read failed. */
export const cardPreview = (entry: WorkspaceTreeEntry): Promise<CardPreview | undefined> => {
    const version = versionOf(entry);
    const held = asked.get(version);
    if (held !== undefined) {
        return held;
    }
    const reading = read(entry)
        // allow(silent-catch): a preview is decoration; a read that fails leaves the card its glyph, and opening the file reports the failure.
        .catch(() => undefined)
        .then((preview) => {
            settled.set(version, preview);
            return preview;
        });
    asked.set(version, reading);
    // The oldest go first once more are kept than a few screens of cards.
    for (const [key] of asked) {
        if (asked.size <= KEPT) {
            break;
        }
        asked.delete(key);
        settled.delete(key);
    }
    return reading;
};

/** What a card already read of this version, to paint before asking again; `null` where nothing has been read yet. */
export const heldPreview = (entry: WorkspaceTreeEntry): CardPreview | undefined | null => {
    const version = versionOf(entry);
    return settled.has(version) ? settled.get(version) : null;
};
