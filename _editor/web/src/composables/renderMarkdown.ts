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

/* The app's markdown entry point: the design system's engine (which every surface, extensions included,
 * shares) plus the one thing only this app can do, turning the file paths in a document into links that
 * open the workspace.
 *
 * The engine is generic on purpose. Where a file reference points, and what it should read as, depends on the
 * workspace tree and this app's routes; handing that in as a decorator keeps route knowledge out of the
 * design system without giving the app a second renderer to keep in step. Every call site imports from here,
 * so nothing in the app can accidentally render prose WITHOUT its file links. */

export { markdownParseCount, settledEnd } from "@intentic/ui/markdown";
export type { MarkdownPart, RenderedMarkdown, StreamingMarkdown };

/* The app's decorator, in the one shape both ways of rendering prose take it. A surface that renders to a
 * STRING (the chat, below) hands it to the engine; one that renders through the kit's <Markdown> component (the
 * workspace file preview, whose documents carry figure fences a single v-html string cannot hold) passes it as
 * that component's `decorate` prop. Either way the links come from here, so no surface can render prose that
 * looks like the rest of the app but leaves its file mentions dead.
 *
 * `dir` is the directory a relative file reference resolves against, a previewed document's own, so its links
 * to its neighbours land on the right files. Agent prose omits it: an agent names files from the workspace
 * root, and the streaming path below never takes one for the same reason.
 *
 * `agent` is WHOSE copy of the workspace the prose is about (workspaceScope). An isolated conversation writes
 * files into its own checkout, so the file it names in its answer is the one in THAT tree, the same path in
 * the shared tree is a different file, or no file at all. Decided where the prose is rendered, because that is
 * the only place that knows which conversation is speaking. */
export const fileLinkDecorator =
    (options?: { readonly dir?: string; readonly agent?: string }): MarkdownDecorator =>
    (fragment) =>
        linkifyFileRefs(fragment, options?.dir, options?.agent);

export const renderMarkdown = (source: string, agent?: string): string => renderEngine(source, fileLinkDecorator({ agent }));

// The same document as the pieces a surface mounts, prose runs plus the figures between them (see the engine's
// renderMarkdownParts). What a chat turn renders, so an agent's ```mermaid draws in the answer that wrote it
// rather than only in the file it later saves it to.
export const renderMarkdownParts = (source: string, agent?: string): RenderedMarkdown => renderEngineParts(source, fileLinkDecorator({ agent }));

// One renderer per streaming message (the caller holds it for the message's lifetime), see the engine for
// why a live turn is split into a settled prefix and a re-parsed tail. The scope arrives as a GETTER precisely
// because the renderer outlives any one frame: a conversation can still be switched between isolated and
// shared before its first turn, and a decorator holding the value it had at construction would keep minting
// links into the tree that conversation no longer works in.
export const createStreamingMarkdown = (agent: () => string | undefined): StreamingMarkdown =>
    createEngineStream((fragment) => linkifyFileRefs(fragment, undefined, agent()));
