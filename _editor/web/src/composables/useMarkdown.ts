import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import { createStreamingMarkdown, renderMarkdownParts, type RenderedMarkdown } from "./renderMarkdown";

/* The single markdown entry point for chat surfaces — the assistant's answer, a plan card's body, anything
 * else that renders agent prose.
 *
 * Either way the answer is a list of PARTS — prose runs already rendered to HTML, and the figures between them
 * as data for the caller to draw (see the engine's renderMarkdownParts). A turn without figures is one part
 * while it streams and one part when it is done, which is the shape the transcript has always rendered.
 *
 * What differs is how they are produced, and it is picked from whether the text is still being written. A live
 * turn takes the settled/tail split (see renderMarkdown): the finished prefix is parsed once and its runs come
 * back byte-identical on later frames, so Vue skips patching that v-html and the DOM — along with any text the
 * user has selected in it — survives. Anything finished takes the whole-message path instead, which is both
 * cheaper (no per-frame tail re-parse) and more correct: a message's LAST block never settles, since nothing
 * follows it to confirm the boundary, so under the split a turn ending in a code fence would never be
 * highlighted. */
// `agent` is whose copy of the workspace this prose is about (workspaceScope) — the conversation's own id when
// it runs isolated, so the files it names link into the tree it actually wrote them in.
export const useMarkdown = (
    source: MaybeRefOrGetter<string>,
    streaming: MaybeRefOrGetter<boolean>,
    agent?: MaybeRefOrGetter<string | undefined>,
): ComputedRef<RenderedMarkdown> => {
    // Held for the caller's lifetime, so a message keeps its boundary across frames. Unused, and costing
    // nothing, when the text never streams.
    const stream = createStreamingMarkdown(() => toValue(agent));
    return computed(() => (toValue(streaming) ? stream.render(toValue(source)) : renderMarkdownParts(toValue(source), toValue(agent))));
};
