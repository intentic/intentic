import { ref } from "vue";
import { useTheme } from "@intentic/ui";
import { THEME_TOKEN_VARS, vscodeThemeToTokens, type ImportedTheme } from "./vscodeTheme";

/* Apply an imported VSCode/OpenVSX theme to the live app — the user-facing half of the theme-import lever (the
 * mapper in vscodeTheme.ts is the pure core). Bringing your VSCode look is the #1 switch-blocker, so this is a
 * direct "familiar for developers" win. The imported theme's tokens are written as inline `--color-*` overrides on
 * <html>: these are the CHROME tokens, one tier below which the picked accent writes its own primitive ramps on
 * the same element — so an import layers cleanly over whatever colour the app is wearing, and over the scheme,
 * without forking @intentic/ui. Persisted to localStorage (per the
 * useLayout/useKeymap client-preference idiom) and re-applied on load.
 *
 * Scope (honest): this maps the ~13 chrome IDENTITY tokens, not the full primary/surface RAMPS, and does not yet
 * re-theme Monaco syntax from `tokenColors` (Shiki consumes those natively — a follow-on). It's a recognizable
 * reskin of the app chrome, not a pixel-perfect port. Single-mode: an imported theme pins its own light/dark. */

interface StoredTheme extends ImportedTheme {
    readonly name: string;
    // The original VSCode theme object (colors + tokenColors), kept so Monaco can theme SYNTAX from it via Shiki —
    // the chrome `tokens` above can't carry token scopes. Loosely typed; cast to Shiki's ThemeInput at that seam.
    readonly raw: Record<string, unknown>;
    // A stable, unique Shiki/Monaco theme id for this import, so useMonaco loads + activates it by name.
    readonly shikiName: string;
}

const STORAGE_KEY = `ui-imported-theme`;

// Per-import unique id (no Date/random needed) — each distinct import gets its own Shiki theme name so re-importing
// never collides with a stale, same-named theme still loaded in the core.
let sequence = 0;

const read = (): StoredTheme | undefined => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === null) {
            return undefined;
        }
        const parsed: unknown = JSON.parse(stored);
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
        // Storage unavailable or bad JSON — no imported theme.
    }
    return undefined;
};

const write = (value: StoredTheme | undefined): void => {
    try {
        if (value === undefined) {
            localStorage.removeItem(STORAGE_KEY);
        } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        }
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds for this session.
    }
};

const applyTokens = (theme: StoredTheme): void => {
    const root = document.documentElement.style;
    for (const [cssVar, color] of Object.entries(theme.tokens)) {
        root.setProperty(cssVar, color);
    }
    // Flip the color scheme so PrimeVue's dark preset and the role tokens match the imported theme's mode.
    useTheme().set(theme.mode);
};

const removeTokens = (): void => {
    const root = document.documentElement.style;
    for (const cssVar of THEME_TOKEN_VARS) {
        root.removeProperty(cssVar);
    }
};

const active = ref<StoredTheme | undefined>(read());
// Restore a saved import when the app loads (mirrors useTheme applying the saved scheme on module load).
if (active.value !== undefined) {
    applyTokens(active.value);
}

// Parse a pasted/loaded VSCode theme JSON, map it, apply + persist. Throws on invalid JSON so the caller can show
// the parse error inline — the raw error propagates unchanged (CLAUDE.md: don't wrap).
const importThemeJson = (json: string): void => {
    const parsed: unknown = JSON.parse(json);
    const source = typeof parsed === `object` && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const rawName = source[`name`];
    const name = typeof rawName === `string` && rawName.length > 0 ? rawName : `Imported theme`;
    const imported = vscodeThemeToTokens(parsed as Parameters<typeof vscodeThemeToTokens>[0]);
    sequence += 1;
    const stored: StoredTheme = { name, mode: imported.mode, tokens: imported.tokens, raw: source, shikiName: `imported-${sequence}` };
    active.value = stored;
    applyTokens(stored);
    write(stored);
};

const clearImportedTheme = (): void => {
    active.value = undefined;
    removeTokens();
    write(undefined);
};

export function useImportedTheme() {
    return { active, importThemeJson, clearImportedTheme };
}
