// Markdown engine's entry point, separate from the design-system barrel: the barrel is a .vue graph with
// import-time DOM side effects (useDevice reads window.matchMedia), while this is plain TypeScript importable from
// node tests. The <Markdown> component stays on the barrel.

export { blockAtOffset, type MarkdownBlock, type MarkdownBlocks, offsetOfLine, splitMarkdownBlocks } from "./blocks.js";
export { type CodeBlock, codeBlockHtml, copyCodeFromEvent, escapeHtml } from "./code.js";
// Writing half of the engine: shared by every surface in the product that authors markdown (see
// MarkdownDocument.vue), not owned by one view. `edits.ts`/`history.ts` are pure over (text, selection);
// `sourceDom.ts` defers DOM access to call time, so this subpath stays importable from a node test.
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
