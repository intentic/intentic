import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import { createStreamingMarkdown, renderMarkdown, type RenderedMarkdown } from "./renderMarkdown";

/* The single markdown entry point for chat surfaces — the assistant's answer, a plan card's body, anything
 * else that renders agent prose.
 *
 * It picks the rendering strategy from whether the text is still being written. A live turn takes the
 * settled/tail split (see renderMarkdown): the finished prefix is parsed once and handed back byte-identical
 * on later frames, so Vue skips patching that v-html and the DOM — along with any text the user has selected
 * in it — survives. Anything finished takes the whole-message path instead, which is both cheaper (no
 * per-frame tail re-parse) and more correct: a message's LAST block never settles, since nothing follows it
 * to confirm the boundary, so under the split a turn ending in a code fence would never be highlighted. */
export const useMarkdown = (
    source: MaybeRefOrGetter<string>,
    streaming: MaybeRefOrGetter<boolean>,
): ComputedRef<RenderedMarkdown> => {
    // Held for the caller's lifetime, so a message keeps its boundary across frames. Unused, and costing
    // nothing, when the text never streams.
    const stream = createStreamingMarkdown();
    return computed(() =>
        toValue(streaming) ? stream.render(toValue(source)) : { settled: renderMarkdown(toValue(source)), tail: `` },
    );
};
