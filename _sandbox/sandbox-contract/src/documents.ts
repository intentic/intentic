import type { CardDocument, ToolCallContent } from "./events.js";
import { planParts } from "./title.js";
import { PLAN_DOCUMENTS_DIR } from "./workspace-state.js";

/* A DOCUMENT A TURN WROTE FOR A PERSON TO READ, told apart from the files it changed for the machine.
 *
 * A transcript renders ACTS: a file was written, a command ran, a page was fetched. That is the right shape for
 * nearly everything an agent does, and the wrong shape for the one thing it produces that is addressed to the
 * reader. An analysis, a findings write-up, a plan: the card for those said `Write · +135 −0` and folded, so the
 * document the next question was ABOUT was the one thing the chat would not show. Worse, the model reaches for a
 * file precisely BECAUSE prose in the answer is expensive, so the better it behaves the less the reader sees.
 *
 * The rules live here, in the contract, because both sides run them and they must not drift: the daemon reads
 * them to decide what a parked card is about (agent.ts), the browser to decide how a tool card draws
 * (toolPresentation.ts). Two copies would let a card render a document the question card had never heard of.
 *
 * ONLY A WHOLE-FILE WRITE COUNTS. An Edit's `newText` is the replacement fragment, not the document: rendered as
 * prose it is a mid-sentence slice with no heading, and the DIFF is what a reader wants from an edit anyway. So
 * a Write of a markdown file is a document, and an edit to one stays a diff. */

// Prose, by extension. Deliberately short: a document is something the chat can RENDER, and markdown is what
// the chat's prose pipeline speaks. A `.txt` report would render as an unstyled wall and reads better as the
// plain text box it already gets.
const DOCUMENT_EXTENSIONS = [".md", ".markdown"];

export const isDocumentPath = (path: string): boolean => {
    const lower = path.toLowerCase();
    return DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

/* Whether a path is one of the CLI's plan files, which is what earns a document the plan treatment here rather
 * than the general markdown rule above: the harness owns that address, so there is no guessing whether prose is
 * a plan and no threshold on length. Matched on the DIRECTORY rather than on the name, which is a mint-fresh
 * three-word phrase (`map-of-this-wiggly-spring.md`) carrying no signal at all.
 *
 * The directory itself is declared in workspace-state.ts, beside the lock it is the one exception to. */
export const isPlanDocumentPath = (path: string): boolean => path.startsWith(`${PLAN_DOCUMENTS_DIR}/`);

/* What a document is CALLED. Its opening heading when it has one, which is the line the author wrote to name
 * the whole thing (planParts, the same split the plan card titles from), and its file name when it does not.
 *
 * Never the path: a card that says `.intentic/records/sessions/claude/plans/map-of-this-wiggly-spring.md`
 * has told the reader nothing about what is in it, and that string is the CLI's mint, not anybody's title. */
export const documentTitle = (markdown: string, path: string): string => planParts(markdown).title ?? path.split("/").pop() ?? path;

/* The document a tool call produced, or undefined when it produced none, the ONE test both sides ask.
 *
 * Reads the call's structured diff rather than its result text, because the content is already there: a Write's
 * whole file rides the tool_call frame as `newText` (capped at the wire limit, which `truncated` reports), so
 * nothing has to be re-read from disk to draw it, and a published transcript with no workspace behind it draws
 * exactly the same document. */
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
