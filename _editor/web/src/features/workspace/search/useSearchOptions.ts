import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

// Workspace search settings: persisted module-level singleton for the three match switches (Aa/ab/.*), search
// scope, and file glob. Lives outside useLayout because these change what a query means, not how it looks; both
// content search and filename quick-open read them.

const REGEX_KEY = `ui-workspace-search-regex`;
const CASE_KEY = `ui-workspace-search-case`;
const WORD_KEY = `ui-workspace-search-word`;
// Widens quick-open and content search into node_modules/.gitignored (secrets blocked); off by default.
const INCLUDE_IGNORED_KEY = `ui-workspace-include-ignored`;
// Comma-separated globs (`!` excludes); empty = whole workspace, narrowed within includeIgnored's scope.
const INCLUDE_KEY = `ui-workspace-search-include`;

// Write-through lives in the ref itself (definePreference), not a setter beside it: splitting update from
// persistence lets `.value =` drift from the stored value.
const boolPref = (key: string): Ref<boolean> => definePreference<boolean>({ key, read: (raw) => raw === `1`, write: (value) => (value ? `1` : `0`) });

const textPref = (key: string): Ref<string> => definePreference<string>({ key, read: (raw) => raw ?? ``, write: (value) => value });

const useRegex = boolPref(REGEX_KEY);
const matchCase = boolPref(CASE_KEY);
const wholeWord = boolPref(WORD_KEY);
const includeIgnored = boolPref(INCLUDE_IGNORED_KEY);
const include = textPref(INCLUDE_KEY);

export function useSearchOptions() {
    return { useRegex, matchCase, wholeWord, includeIgnored, include };
}

// Each row carries the live ref itself: callers read and assign `state.value` directly, no setter.
export const MATCH_TOGGLES: readonly { label: string; title: string; state: Ref<boolean> }[] = [
    { label: `Aa`, title: `Match case`, state: matchCase },
    { label: `ab`, title: `Match whole word`, state: wholeWord },
    { label: `.*`, title: `Use regular expression`, state: useRegex },
];
