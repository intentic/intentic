import {
    createStreamingMarkdown as createEngineStream,
    renderMarkdown as renderEngine,
    type RenderedMarkdown,
    type StreamingMarkdown,
} from "@intentic-app/ui/markdown";
import { linkifyFileRefs } from "./markdownFileLinks";

/* The app's markdown entry point: the design system's engine (which every surface, extensions included,
 * shares) plus the one thing only this app can do — turning the file paths in a document into links that
 * open the workspace.
 *
 * The engine is generic on purpose. Where a file reference points, and what it should read as, depends on the
 * workspace tree and this app's routes; handing that in as a decorator keeps route knowledge out of the
 * design system without giving the app a second renderer to keep in step. Every call site imports from here,
 * so nothing in the app can accidentally render prose WITHOUT its file links. */

export { markdownParseCount, settledEnd } from "@intentic-app/ui/markdown";
export type { RenderedMarkdown, StreamingMarkdown };

/* `dir` is the directory a relative file reference resolves against — a previewed document's own, so its links
 * to its neighbours land on the right files. Agent prose omits it: an agent names files from the workspace
 * root, and the streaming path below never takes one for the same reason. */
export const renderMarkdown = (source: string, dir?: string): string => renderEngine(source, (fragment) => linkifyFileRefs(fragment, dir));

// One renderer per streaming message (the caller holds it for the message's lifetime) — see the engine for
// why a live turn is split into a settled prefix and a re-parsed tail.
export const createStreamingMarkdown = (): StreamingMarkdown => createEngineStream((fragment) => linkifyFileRefs(fragment, undefined));
