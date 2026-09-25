import { MARK_CLASS, redline, type DocxNode, type RedlineEvent, type RedlineOptions } from "./docxRedline.js";

// The compare pipeline without the Vue: both versions parsed by docx-preview, the new one's body replaced by the
// redline, and that drawn into a host with revision marks on. What the compare viewer calls, and what a test drives
// in a DOM.

export interface ComparedDocx {
    readonly events: readonly RedlineEvent[];
    readonly whole: boolean;
}

// docx-preview's parsed document, the one field this touches.
interface ParsedDocx {
    documentPart: { body: { children: DocxNode[] } };
}

// docx-preview is lazy-imported for the same reason DocxViewer imports it lazily: its jszip payload stays out of the
// initial bundle, and only a Word document's diff needs it.
export const compareDocx = async (before: Blob | Uint8Array, after: Blob | Uint8Array, host: HTMLElement, options: RedlineOptions): Promise<ComparedDocx> => {
    const { parseAsync, renderDocument } = await import("docx-preview");
    const [old, current] = (await Promise.all([parseAsync(before), parseAsync(after)])) as [ParsedDocx, ParsedDocx];
    const result = redline(old.documentPart.body.children, current.documentPart.body.children, options);
    current.documentPart.body.children = [...result.children];
    // docx-preview 0.4 returns the rendered nodes (styles included) instead of drawing into a container.
    host.replaceChildren(...(await renderDocument(current, { renderChanges: true })));
    return { events: result.events, whole: result.whole };
};

const EVENT_CLASS = new RegExp(`^${MARK_CLASS}-e(\\d+)$`);

/** The marked paragraphs of a rendered redline by event id, each list in document order; what stepping walks. */
export const anchorsOf = (host: HTMLElement): Map<number, HTMLElement[]> => {
    const anchors = new Map<number, HTMLElement[]>();
    for (const element of host.querySelectorAll<HTMLElement>(`.${MARK_CLASS}`)) {
        for (const name of element.classList) {
            const id = EVENT_CLASS.exec(name)?.[1];
            if (id !== undefined) {
                anchors.set(Number(id), [...(anchors.get(Number(id)) ?? []), element]);
            }
        }
    }
    return anchors;
};
