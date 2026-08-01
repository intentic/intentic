import { ref } from "vue";

/* What the workspace search box remembers between searches (module-level singleton, persisted): the three
 * match switches every editor puts inside its search field — VSCode's Aa / ab / .* — plus how wide the search
 * looks. Persisted because they are a habit, not a per-query choice: someone who works in regexes wants regexes
 * still on tomorrow, the way VSCode keeps them.
 *
 * They live here rather than in useLayout because they are not layout: they change what a query MEANS, and the
 * two readers of that meaning (the content search and the filename quick-open) sit beside this file. */

const REGEX_KEY = `ui-workspace-search-regex`;
const CASE_KEY = `ui-workspace-search-case`;
const WORD_KEY = `ui-workspace-search-word`;
// Widens BOTH the filename quick-open and the content search into node_modules and .gitignore'd paths (the
// security floor still applies — secrets never surface). Off by default.
const INCLUDE_IGNORED_KEY = `ui-workspace-include-ignored`;

// Storage may be unavailable (private mode); the in-memory refs still hold for the session.
const readBool = (key: string): boolean => {
    try {
        return localStorage.getItem(key) === `1`;
    } catch {
        return false;
    }
};

const write = (key: string, value: boolean): void => {
    try {
        localStorage.setItem(key, value ? `1` : `0`);
    } catch {
        // ignore
    }
};

const useRegex = ref<boolean>(readBool(REGEX_KEY));
const matchCase = ref<boolean>(readBool(CASE_KEY));
const wholeWord = ref<boolean>(readBool(WORD_KEY));
const includeIgnored = ref<boolean>(readBool(INCLUDE_IGNORED_KEY));

const toggle = (state: typeof useRegex, key: string): void => {
    state.value = !state.value;
    write(key, state.value);
};

export function useSearchOptions() {
    return {
        useRegex,
        matchCase,
        wholeWord,
        includeIgnored,
        toggleRegex: () => toggle(useRegex, REGEX_KEY),
        toggleMatchCase: () => toggle(matchCase, CASE_KEY),
        toggleWholeWord: () => toggle(wholeWord, WORD_KEY),
        toggleIncludeIgnored: () => toggle(includeIgnored, INCLUDE_IGNORED_KEY),
    };
}
