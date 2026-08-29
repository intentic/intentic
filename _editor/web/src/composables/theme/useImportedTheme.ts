import type { Ref } from "vue";
// Both off their own entry points rather than the barrel, the same reason skins/useSkin.ts gives: this is a
// plain state module, and reaching the kit through @intentic/ui would drag its whole component graph (and
// mermaid, shiki and vue-flow behind it) into every window that merely holds an imported theme — which, now
// that the document's look is installed from main.ts, is every window of the app.
import { definePreference } from "@intentic/ui/preference";
import { useTheme } from "@intentic/ui/theme";
import { THEME_TOKEN_VARS, vscodeThemeToTokens, type ImportedTheme } from "./vscodeTheme";

/* Apply an imported VSCode/OpenVSX theme to the live app, the user-facing half of the theme-import lever (the
 * mapper in vscodeTheme.ts is the pure core). Bringing your VSCode look is the #1 switch-blocker, so this is a
 * direct "familiar for developers" win. The imported theme's tokens are written as inline `--color-*` overrides on
 * <html>: these are the CHROME tokens, one tier below which the picked accent writes its own primitive ramps on
 * the same element, so an import layers cleanly over whatever colour the app is wearing, and over the scheme,
 * without forking @intentic/ui. An account preference (composables/preference.ts), so an import applied on the
 * settings page recolors every window the account has open, the popped-out chat included.
 *
 * Scope (honest): this maps the ~13 chrome IDENTITY tokens, not the full primary/surface RAMPS, and does not yet
 * re-theme Monaco syntax from `tokenColors` (Shiki consumes those natively, a follow-on). It's a recognizable
 * reskin of the app chrome, not a pixel-perfect port. Single-mode: an imported theme pins its own light/dark. */

interface StoredTheme extends ImportedTheme {
    readonly name: string;
    // The original VSCode theme object (colors + tokenColors), kept so Monaco can theme SYNTAX from it via Shiki,
    // the chrome `tokens` above can't carry token scopes. Loosely typed; cast to Shiki's ThemeInput at that seam.
    readonly raw: Record<string, unknown>;
    // A stable, unique Shiki/Monaco theme id for this import, so useMonaco loads + activates it by name.
    readonly shikiName: string;
}

const STORAGE_KEY = `ui-imported-theme`;

// Per-import unique id (no Date/random needed), each distinct import gets its own Shiki theme name so re-importing
// never collides with a stale, same-named theme still loaded in the core.
let sequence = 0;

const parse = (raw: string | null): StoredTheme | undefined => {
    if (raw === null) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        // Trust only a well-shaped blob; a corrupt/hand-edited one reverts to the built-in theme.
        if (
            typeof parsed === `object` &&
            parsed !== null &&
            typeof (parsed as StoredTheme).tokens === `object` &&
            typeof (parsed as StoredTheme).raw === `object` &&
            typeof (parsed as StoredTheme).shikiName === `string` &&
            ((parsed as StoredTheme).mode === `dark` || (parsed as StoredTheme).mode === `light`)
        ) {
            return parsed as StoredTheme;
        }
    } catch {
        // Bad JSON, no imported theme.
    }
    return undefined;
};

/* THE OVERRIDES ON <html>, SET TO EXACTLY THIS THEME, whichever theme was there before. Cleared first rather
 * than diffed: the token list is fixed and short (THEME_TOKEN_VARS), and a second import that happens to name
 * fewer tokens than the first must not inherit the difference from it. This is also what makes "no theme" an
 * ordinary value of this preference rather than a separate teardown path.
 *
 * It clears only what it has actually SET, which is what keeps "no theme" free of the DOM entirely: these
 * properties exist on that element because this module put them there, so with none put there there is nothing
 * to take away. The app with no import (almost everyone) therefore touches nothing on load, and so does a plain
 * state module imported somewhere without a document at all. */
let painted = false;

const applyTokens = (theme: StoredTheme | undefined): void => {
    if (!painted && theme === undefined) {
        return;
    }
    const root = document.documentElement.style;
    for (const cssVar of THEME_TOKEN_VARS) {
        root.removeProperty(cssVar);
    }
    painted = false;
    if (theme === undefined) {
        return;
    }
    for (const [cssVar, color] of Object.entries(theme.tokens)) {
        root.setProperty(cssVar, color);
    }
    painted = true;
};

const active: Ref<StoredTheme | undefined> = definePreference<StoredTheme | undefined>({
    key: STORAGE_KEY,
    read: parse,
    // `undefined` removes the key, which is what "no imported theme" means in storage as well as in memory.
    write: (value) => (value === undefined ? null : JSON.stringify(value)),
    apply: applyTokens,
});

// Parse a pasted/loaded VSCode theme JSON, map it, apply + persist. Throws on invalid JSON so the caller can show
// the parse error inline, the raw error propagates unchanged (CLAUDE.md: don't wrap).
const importThemeJson = (json: string): void => {
    const parsed: unknown = JSON.parse(json);
    const source = typeof parsed === `object` && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const rawName = source[`name`];
    const name = typeof rawName === `string` && rawName.length > 0 ? rawName : `Imported theme`;
    const imported = vscodeThemeToTokens(parsed as Parameters<typeof vscodeThemeToTokens>[0]);
    sequence += 1;
    active.value = { name, mode: imported.mode, tokens: imported.tokens, raw: source, shikiName: `imported-${sequence}` };
    /* An imported theme PINS a scheme, and flipping it is a second preference write, made here in the window the
     * import happened in. Every other window hears that write as its own note and needs no rule connecting the
     * two (the same split useSkin makes): a scheme decided inside `apply` would be re-decided, and re-written, by
     * every window that merely heard about the import. */
    useTheme().set(imported.mode);
};

const clearImportedTheme = (): void => {
    active.value = undefined;
};

export function useImportedTheme() {
    return { active, importThemeJson, clearImportedTheme };
}
