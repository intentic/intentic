import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import { fileRefTree } from "../../features/workspace/files/refs/fileRefs";
import { createStreamingMarkdown, type ParsedMarkdown, parseMarkdownParts, type RenderedMarkdown, renderParsedMarkdown } from "./renderMarkdown";

// Single markdown entry point for chat surfaces, returning a list of parts (rendered prose, figure data). Streaming
// text uses the settled/tail split so finished runs stay byte-identical and Vue skips patching; finished text renders
// whole-message instead, since a live split would leave its last block unhighlighted.
// `agent` is whose workspace copy this prose is about; the conversation's own id when it runs isolated.

// FINISHED PROSE IS PARSED ONCE PER WINDOW, NOT ONCE PER MOUNT. A message's parse (marked, DOMPurify, the file-link walk,
// an innerHTML round trip) was held only by the component showing it, so every reopening of a chat, every phone tab
// switch and every older page parsed every message again. Held here by its words and whose workspace they are about, and
// only while the workspace tree its file links resolved against still stands: a tree that loads or changes re-links
// the next render, as a remount always did. The parse is immutable (code blocks stay placeholders until render), so
// every surface showing the same words can share one.
const CACHED_PARSES = 400;
const parses = new Map<string, { readonly tree: unknown; readonly parsed: ParsedMarkdown }>();

export const cachedParse = (source: string, agent: string | undefined): ParsedMarkdown => {
    const key = `${agent ?? ``}\u0000${source}`;
    const tree = fileRefTree();
    const hit = parses.get(key);
    if (hit !== undefined && hit.tree === tree) {
        // Least recently used goes first: a hit moves to the back.
        parses.delete(key);
        parses.set(key, hit);
        return hit.parsed;
    }
    const parsed = parseMarkdownParts(source, agent);
    parses.set(key, { tree, parsed });
    if (parses.size > CACHED_PARSES) {
        const oldest = parses.keys().next().value;
        if (oldest !== undefined) {
            parses.delete(oldest);
        }
    }
    return parsed;
};

export const useMarkdown = (
    source: MaybeRefOrGetter<string>,
    streaming: MaybeRefOrGetter<boolean>,
    agent?: MaybeRefOrGetter<string | undefined>,
): ComputedRef<RenderedMarkdown> => {
    // Held for the caller's lifetime so a message keeps its boundary; unused cost when the text never streams.
    const stream = createStreamingMarkdown(() => toValue(agent));
    // Finished text parses once per source; a highlight landing or a copy press anywhere re-runs only the render.
    const parsed = computed(() => (toValue(streaming) ? undefined : cachedParse(toValue(source), toValue(agent))));
    return computed(() => {
        const whole = parsed.value;
        return whole === undefined ? stream.render(toValue(source)) : renderParsedMarkdown(whole);
    });
};
