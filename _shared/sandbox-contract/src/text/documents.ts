import type { CardDocument, ToolCallContent } from "../events/cards.js";
import { planParts } from "./title.js";
import { PLAN_DOCUMENTS_DIR } from "../state/workspace-state.js";

// A document is a turn's output for a person to read, distinct from a file changed for the machine; only a whole-file
// write counts, an Edit's fragment stays a diff. Shared here so the daemon (parked-card logic) and the browser
// (tool-card rendering) can't drift on what counts as one.

// Markdown only: the chat's prose pipeline renders it; a .txt report is better left as a plain-text box.
const DOCUMENT_EXTENSIONS = [".md", ".markdown"];

export const isDocumentPath = (path: string): boolean => {
    const lower = path.toLowerCase();
    return DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

// Matched by directory, not name (a mint-fresh phrase like `map-of-this-wiggly-spring.md` carries no signal). The
// directory is declared in workspace-state.ts, the one exception to its lock.
export const isPlanDocumentPath = (path: string): boolean => path.startsWith(`${PLAN_DOCUMENTS_DIR}/`);

// The opening heading (planParts) when there is one, else the file name; never the path, which is the CLI's mint and
// tells the reader nothing.
export const documentTitle = (markdown: string, path: string): string => planParts(markdown).title ?? path.split("/").pop() ?? path;

// Reads the call's structured diff, not its result text: a Write's whole file already rides the frame as newText
// (capped, truncated flags it). Works even for a published transcript with no workspace behind it.
export const documentOf = (name: string, content: readonly ToolCallContent[] | undefined): CardDocument | undefined => {
    if (name.toLowerCase() !== "write") {
        return undefined;
    }
    const diff = content?.find((entry) => entry.type === "diff" && isDocumentPath(entry.path));
    if (diff === undefined || diff.type !== "diff") {
        return undefined;
    }
    return {
        path: diff.path,
        title: documentTitle(diff.newText, diff.path),
        markdown: diff.newText,
        ...(diff.truncated === true ? { truncated: true } : {}),
        ...(isPlanDocumentPath(diff.path) ? { plan: true } : {}),
    };
};
