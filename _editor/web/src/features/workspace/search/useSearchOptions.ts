import type { Ref } from "vue";
import { boolPreference, textPreference } from "@intentic/ui/preference";
import { t } from "@intentic/ui/i18n";

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

// Write-through lives in the ref itself (a kit preference), not a setter beside it: splitting update from persistence
// lets `.value =` drift from the stored value.
const useRegex = boolPreference(REGEX_KEY);
const matchCase = boolPreference(CASE_KEY);
const wholeWord = boolPreference(WORD_KEY);
const includeIgnored = boolPreference(INCLUDE_IGNORED_KEY);
const include = textPreference(INCLUDE_KEY);

export function useSearchOptions() {
    return { useRegex, matchCase, wholeWord, includeIgnored, include };
}

// Each row carries the live ref itself: callers read and assign `state.value` directly, no setter.
export const matchToggles = (): readonly { label: string; title: string; state: Ref<boolean> }[] => [
    { label: t(`workspace.useSearchOptions.aa`), title: t(`workspace.useSearchOptions.matchCase`), state: matchCase },
    { label: `ab`, title: t(`workspace.useSearchOptions.matchWholeWord`), state: wholeWord },
    { label: `.*`, title: t(`workspace.useSearchOptions.useRegularExpression`), state: useRegex },
];
