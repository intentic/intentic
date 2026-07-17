import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { LANGS } from "./shikiLangs.js";

/* Shared Shiki highlighter. One lazily-built core instance for the whole app, using the JavaScript RegExp
 * engine (no WASM, so no asset-pipeline config) and fine-grained, dynamically-imported grammars/themes —
 * only what's actually rendered ships in the bundle.
 *
 * Emits dual-theme HTML (light color inline + a `--shiki-dark` CSS var per token), so light/dark switching
 * is pure CSS keyed off the app's `[data-mode="dark"]` attribute — no re-highlighting on theme toggle (see
 * code.css). Module-level state = one singleton for the whole app. */

const THEME_LIGHT = `light-plus`;
const THEME_DARK = `dark-plus`;

let core: Promise<HighlighterCore> | undefined;
const loaded = new Set<string>();

// Build the shared core (+ both themes) once, off the render critical path. Also the instance handed to
// @shikijs/monaco so Monaco tokenizes with the exact same themes/grammars as the <Code> HTML preview.
const ensureCore = (): Promise<HighlighterCore> => {
    if (!core) {
        core = createHighlighterCore({
            themes: [import(`@shikijs/themes/light-plus`), import(`@shikijs/themes/dark-plus`)],
            langs: [],
            // forgiving: don't throw on a grammar regex the JS engine can't compile — degrade gracefully
            // instead, which matters as more languages get added for file preview.
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        });
    }
    return core;
};

// Ensure the core is built and `lang`'s grammar is loaded (both one-time), returning the shared instance — or
// undefined for a language we don't ship. Shared by highlight (HTML) and the Monaco bridge (useMonaco).
const ensureLang = async (lang: string): Promise<HighlighterCore | undefined> => {
    const load = LANGS[lang];
    if (!load) {
        return undefined;
    }
    const instance = await ensureCore();
    if (!loaded.has(lang)) {
        await instance.loadLanguage((await load()) as Parameters<HighlighterCore[`loadLanguage`]>[0]);
        loaded.add(lang);
    }
    return instance;
};

// Highlight `code` as `lang`, returning dual-theme HTML. Unsupported langs return undefined so the caller
// can fall back to rendering the raw text.
const highlight = async (code: string, lang: string): Promise<string | undefined> =>
    (await ensureLang(lang))?.codeToHtml(code, { lang, themes: { light: THEME_LIGHT, dark: THEME_DARK } });

export function useHighlighter() {
    return { highlight, ensureCore, ensureLang };
}
