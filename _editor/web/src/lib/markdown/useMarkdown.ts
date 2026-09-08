import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import { createStreamingMarkdown, renderMarkdownParts, type RenderedMarkdown } from "./renderMarkdown";

// Single markdown entry point for chat surfaces, returning a list of parts (rendered prose, figure data). Streaming
// text uses the settled/tail split so finished runs stay byte-identical and Vue skips patching; finished text renders
// whole-message instead, since a live split would leave its last block unhighlighted.
// `agent` is whose workspace copy this prose is about; the conversation's own id when it runs isolated.
export const useMarkdown = (
    source: MaybeRefOrGetter<string>,
    streaming: MaybeRefOrGetter<boolean>,
    agent?: MaybeRefOrGetter<string | undefined>,
): ComputedRef<RenderedMarkdown> => {
    // Held for the caller's lifetime so a message keeps its boundary; unused cost when the text never streams.
    const stream = createStreamingMarkdown(() => toValue(agent));
    return computed(() => (toValue(streaming) ? stream.render(toValue(source)) : renderMarkdownParts(toValue(source), toValue(agent))));
};
