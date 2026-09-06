/* The markdown engine's own entry point, deliberately separate from the design-system barrel.
 *
 * The barrel is a .vue component graph with import-time side effects (useDevice reads window.matchMedia), so
 * anything that pulls it needs a DOM and the Vue plugin. This engine is plain TypeScript exercised from plain
 * unit tests, and the app imports it from modules that are too, hence a subpath (`@intentic/ui/markdown`)
 * that costs neither. The <Markdown> component, being a component, stays on the barrel. */

export { blockAtOffset, type MarkdownBlock, type MarkdownBlocks, offsetOfLine, splitMarkdownBlocks } from "./blocks.js";
export { type CodeBlock, codeBlockHtml, copyCodeFromEvent, escapeHtml } from "./code.js";
/* THE WRITING HALF OF THE ENGINE, which used to live in the web app beside the one view that used it. It is
 * here because it is not one view's: the same three modules now drive every surface in the product where
 * somebody authors markdown (see MarkdownDocument.vue), and a kit that shipped the reader without the writer
 * is what left five of those surfaces editing prose in a grey <textarea>.
 *
 * `edits.ts` and `history.ts` are pure functions over (text, selection) and need no DOM; `sourceDom.ts` builds
 * elements and asks for one at call time, not at import, so this subpath stays importable from a node test. */
export { continueList, indentLines, insertLink, type ListEnter, onListLine, outdentLines, type TextEdit, toggleWrap } from "./edits.js";
export { createMarkdownHistory, type DocumentState, type EditKind, type MarkdownHistory } from "./history.js";
export { blockBody, buildBlockElement, caretAtOffset, offsetOfCaret } from "./sourceDom.js";
export {
    type BarsFigure,
    type BarsFigureItem,
    type DagFigure,
    type DagFigureEdge,
    type DagFigureNode,
    type Figure,
    FIGURE_ACCENTS,
    type FigureAccent,
    FIGURE_LANGS,
    JSON_FIGURE_LANGS,
    type MarkdownSegment,
    MERMAID_LANG,
    type MermaidFigure,
    parseFigure,
    splitFigureSegments,
    type StatsFigure,
    type StatsFigureItem,
} from "./figures.js";
export {
    createStreamingMarkdown,
    lexBlocks,
    lexInline,
    type MarkdownDecorator,
    type MarkdownPart,
    markdownParseCount,
    type MarkdownToken,
    renderMarkdown,
    renderMarkdownParts,
    type RenderedMarkdown,
    settledEnd,
    type StreamingMarkdown,
} from "./render.js";
