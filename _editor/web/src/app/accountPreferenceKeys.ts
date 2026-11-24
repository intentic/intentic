// WHICH PREFERENCES FOLLOW THE ACCOUNT (accountPreferences.ts syncs them): a list of its own so the test can hold it to the
// platform's rule for a preference's name and to how many it keeps, which a key added here must also meet.

/** What follows the account: how the app looks, and how its technical screens read. */
export const ACCOUNT_PREFERENCE_KEYS: readonly string[] = [
    `ui-color-scheme`,
    `ui-skin`,
    `ui-wallpaper`,
    `ui-text-size`,
    `ui-locale`,
    `ui-file-nesting`,
    `ui-changes-by-module`,
    `ui-changes-largest-first`,
    `ui-chat-show-tool-calls`,
    `ui-agents-live-metrics`,
    // What the file tree lists, and how a diff and a file read (workbench/window/useLayout.ts).
    `ui-workspace-show-ignored`,
    `ui-workspace-hide-tests`,
    `ui-workspace-hide-technical`,
    `ui-diff-open`,
    `ui-diff-layout`,
    `ui-diff-prose`,
    `ui-diff-document`,
    `ui-diff-show-comments`,
    `ui-file-hide-comments`,
    `ui-markdown-outline`,
];
// Left out on purpose. `ui-audience`: the words are the sandbox's to keep (client/sandbox/audienceSync.ts).
// `ui-profile`: which link brought this browser, a fact about the browser.
