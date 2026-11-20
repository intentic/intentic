import type { SearchEngine } from "@intentic/sandbox-contract/schemas/browsing";
import { onScopeDispose, type Ref, shallowRef, watch } from "vue";
import { addressOf } from "../address";
import { useBrowsingSource } from "./browsingSource";
import { parseKeyword } from "./engines";

// The search engine's suggestions for what is in the address bar, asked a beat after typing pauses rather than on every
// keystroke, and dropped when they arrive for text that is no longer there. The address bar never waits for them: it
// ranks what it holds at once, and these join the list when they come.
//
// An address is never sent: a host typed (`192.168.0.168`, `intranet.acme`) is the person's own business, and a
// keyword search is for its site, not the engine.

const DEBOUNCE_MS = 120;

export const useSearchSuggestions = (
    text: Ref<string>,
    engine: Ref<SearchEngine>,
    // Only while the dropdown is open: a field at rest asks nothing.
    open: Ref<boolean>,
    debounceMs = DEBOUNCE_MS,
): Readonly<Ref<readonly string[]>> => {
    const source = useBrowsingSource();
    const suggestions = shallowRef<readonly string[]>([]);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const ask = async (query: string, from: SearchEngine): Promise<void> => {
        try {
            const answer = await source.suggest(query, from);
            // Only for the text still in the field: a late answer for an earlier keystroke is dropped.
            if (text.value.trim() === query && engine.value === from) {
                suggestions.value = answer.suggestions;
            }
        } catch {
            // allow(silent-catch): no suggestions is what an unreachable sandbox has to offer; the rest of the list stands.
        }
    };

    watch(
        [text, engine, open],
        ([typed, from, shown]) => {
            clearTimeout(timer);
            const query = typed.trim();
            if (!shown || query === `` || query.length > 200 || addressOf(query) !== undefined || parseKeyword(query) !== undefined) {
                suggestions.value = [];
                return;
            }
            timer = setTimeout(() => void ask(query, from), debounceMs);
        },
        { immediate: true },
    );
    onScopeDispose(() => clearTimeout(timer));
    return suggestions;
};
