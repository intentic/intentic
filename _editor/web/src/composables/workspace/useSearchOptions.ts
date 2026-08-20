import { ref, watch, type Ref } from "vue";

/* What the workspace search box remembers between searches (module-level singleton, persisted): the three
 * match switches every editor puts inside its search field. VSCode's Aa / ab / .*, plus how wide the search
 * looks, and which files it is asked of. Persisted because they are a habit, not a per-query choice: someone
 * who works in regexes wants regexes still on tomorrow, the way VSCode keeps them.
 *
 * They live here rather than in useLayout because they are not layout: they change what a query MEANS, and the
 * two readers of that meaning (the content search and the filename quick-open) sit beside this file. */

const REGEX_KEY = `ui-workspace-search-regex`;
const CASE_KEY = `ui-workspace-search-case`;
const WORD_KEY = `ui-workspace-search-word`;
// Widens BOTH the filename quick-open and the content search into node_modules and .gitignore'd paths (the
// security floor still applies, secrets never surface). Off by default.
const INCLUDE_IGNORED_KEY = `ui-workspace-include-ignored`;
// VSCode's "files to include" box: comma-separated path globs (`package.json, src/**`), `!` on one to exclude
// instead. Empty = the whole workspace. Narrows WITHIN what includeIgnored admitted, and the grammar is read
// where both ends can share one reading of it (the contract's search-globs.ts), the field carries the text.
const INCLUDE_KEY = `ui-workspace-search-include`;

// Storage may be unavailable (private mode); the in-memory refs still hold for the session.
const readBool = (key: string): boolean => {
    try {
        return localStorage.getItem(key) === `1`;
    } catch {
        return false;
    }
};

const readText = (key: string): string => {
    try {
        return localStorage.getItem(key) ?? ``;
    } catch {
        return ``;
    }
};

/* One switch, seeded from storage and persisting every change, which is what makes it a plain ref every
 * caller can flip directly, the way the rest of the persisted singletons work (useFileNesting,
 * useChangeGrouping, useExplorerStyle all say the same thing in their own comment).
 *
 * Write-through belongs to the ref, not to a setter standing beside it. These four used to be paired with four
 * `toggleX` functions whose only job was to remember to save, so the ref and the stored value were two places
 * one preference lived: a `.value =` from anywhere but those four call sites read back fine for the rest of the
 * session and then silently forgot on reload. */
const persistedBool = (key: string): Ref<boolean> => {
    const state = ref(readBool(key));
    watch(state, (value) => {
        try {
            localStorage.setItem(key, value ? `1` : `0`);
        } catch {
            // Storage may be unavailable (private mode); the in-memory ref still holds.
        }
    });
    return state;
};

const persistedText = (key: string): Ref<string> => {
    const state = ref(readText(key));
    watch(state, (value) => {
        try {
            localStorage.setItem(key, value);
        } catch {
            // Storage may be unavailable (private mode); the in-memory ref still holds.
        }
    });
    return state;
};

const useRegex = persistedBool(REGEX_KEY);
const matchCase = persistedBool(CASE_KEY);
const wholeWord = persistedBool(WORD_KEY);
const includeIgnored = persistedBool(INCLUDE_IGNORED_KEY);
const include = persistedText(INCLUDE_KEY);

export function useSearchOptions() {
    return { useRegex, matchCase, wholeWord, includeIgnored, include };
}

/* The three match switches, in the order every editor puts them, shipped from here beside the state they
 * flip, because both search surfaces (the desktop field's inline row and the mobile row under it) were
 * writing the identical list of labels, tooltips and refs out by hand, and a third would have had to guess
 * whether the regex switch is `.*` or `re`. Same split as OS_OPTIONS: the descriptors are shared, the markup
 * is not, a 16px glyph inside a text field and a 32px touch target have nothing in common.
 *
 * Each row carries the REF, not a snapshot of it plus a function to flip it: the switch is the state, so a
 * caller reads `state.value` and assigns `state.value` like it would any other. */
export const MATCH_TOGGLES: readonly { label: string; title: string; state: Ref<boolean> }[] = [
    { label: `Aa`, title: `Match case`, state: matchCase },
    { label: `ab`, title: `Match whole word`, state: wholeWord },
    { label: `.*`, title: `Use regular expression`, state: useRegex },
];
