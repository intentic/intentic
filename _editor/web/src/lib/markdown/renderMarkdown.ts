import {
    createStreamingMarkdown as createEngineStream,
    type MarkdownDecorator,
    type MarkdownPart,
    renderMarkdown as renderEngine,
    renderMarkdownParts as renderEngineParts,
    type RenderedMarkdown,
    type StreamingMarkdown,
} from "@intentic/ui/markdown";
import { linkifyFileRefs } from "./markdownFileLinks";

// App's markdown entry point: the shared design-system engine plus file-path linking, added here as a decorator so
// route knowledge stays out of the design system. Every call site imports from here, so no surface can render prose
// without its file links.

export { markdownParseCount, settledEnd } from "@intentic/ui/markdown";
export type { MarkdownPart, RenderedMarkdown, StreamingMarkdown };

// The app's file-link decorator, handed to the engine directly or as the kit's <Markdown> `decorate` prop. `dir`
// resolves a relative reference; `agent` scopes links to that conversation's workspace copy.
export const fileLinkDecorator =
    (options?: { readonly dir?: string; readonly agent?: string }): MarkdownDecorator =>
    (fragment) =>
        linkifyFileRefs(fragment, options?.dir, options?.agent);

export const renderMarkdown = (source: string, agent?: string): string => renderEngine(source, fileLinkDecorator({ agent }));

// The document as the parts a surface mounts: prose runs plus the figures between them. What a chat turn renders, so a
// ```mermaid draws in the answer that wrote it, not only the file it is saved to.
export const renderMarkdownParts = (source: string, agent?: string): RenderedMarkdown => renderEngineParts(source, fileLinkDecorator({ agent }));

// One renderer per streaming message, held for its lifetime. `agent` arrives as a getter, not a value, since the
// renderer outlives any single frame and the conversation's scope can still change before its first turn.
export const createStreamingMarkdown = (agent: () => string | undefined): StreamingMarkdown =>
    createEngineStream((fragment) => linkifyFileRefs(fragment, undefined, agent()));
