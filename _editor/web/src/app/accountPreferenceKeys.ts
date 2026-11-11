// WHICH PREFERENCES FOLLOW THE ACCOUNT (accountPreferences.ts syncs them): a list of its own so the test can hold it to the
// platform's rule for a preference's name and to how many it keeps, which a key added here must also meet.

/** What follows the account: how the app looks, and how its technical screens read. */
export const ACCOUNT_PREFERENCE_KEYS: readonly string[] = [
    `ui-color-scheme`,
    `ui-skin`,
    `ui-wallpaper`,
    `ui-motion`,
    `ui-text-size`,
    `ui-locale`,
    `ui-explorer-style`,
    `ui-file-nesting`,
    `ui-changes-by-module`,
    `ui-changes-largest-first`,
    `ui-chat-show-tool-calls`,
    `ui-agents-live-metrics`,
];
// Left out on purpose. `ui-accent`: index.html paints the accent before any module runs, from `ui-accent-vars`, a copy
// that only the window picking the colour refreshes (useTheme's `setAccent`), never the preference's own `apply`; an
// accent taken from the account would open this device in its old colour on every load until one was picked here.
// `ui-audience`: the words are the sandbox's to keep (client/sandbox/audienceSync.ts). `ui-profile`: which link brought
// this browser, a fact about the browser.
