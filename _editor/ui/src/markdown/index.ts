/* The markdown engine's own entry point, deliberately separate from the design-system barrel.
 *
 * The barrel is a .vue component graph with import-time side effects (useDevice reads window.matchMedia), so
 * anything that pulls it needs a DOM and the Vue plugin. This engine is plain TypeScript exercised from plain
 * unit tests, and the app imports it from modules that are too — hence a subpath (`@intentic/ui/markdown`)
 * that costs neither. The <Markdown> component, being a component, stays on the barrel. */

export { type CodeBlock, codeBlockHtml, copyCodeFromEvent, escapeHtml } from "./code.js";
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
    type MarkdownDecorator,
    markdownParseCount,
    renderMarkdown,
    type RenderedMarkdown,
    settledEnd,
    type StreamingMarkdown,
} from "./render.js";
