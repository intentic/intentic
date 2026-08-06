import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { langLoader } from "./shikiLangs.js";

/* Shared Shiki highlighter. One lazily-built core instance for the whole app, using the JavaScript RegExp
 * engine (no WASM, so no asset-pipeline config) and fine-grained, dynamically-imported grammars/themes —
 * only what's actually rendered ships in the bundle.
 *
 * Emits dual-theme HTML (light color inline + a `--shiki-dark` CSS var per token), so light/dark switching
 * is pure CSS keyed off the app's `[data-mode="dark"]` attribute — no re-highlighting on theme toggle (see
 * code.css). Module-level state = one singleton for the whole app. */

const THEME_LIGHT = `light-plus`;
const THEME_DARK = `dark-plus`;

/* One line's colour tokens, for a surface that must put its OWN markup inside the code and so cannot render
 * Shiki's finished HTML — the workspace search list interleaves a match `<mark>` with the colour spans. Each
 * token's `htmlStyle` is the same inline light colour + `--shiki-dark` var pair the HTML path emits, so
 * code.css's dark-mode flip governs these identically. */
export type CodeToken = Pick<ThemedToken, "content" | "offset" | "htmlStyle">;

/* A throwaway line, tokenized once per grammar the moment it loads. A grammar's patterns are compiled lazily —
 * the JS engine transpiles each rule's Oniguruma to a RegExp the first time a line reaches that rule — and
 * vscode-textmate charges that compile to the 500ms budget it runs PER LINE. Over budget, tokenization stops
 * mid-line and hands back the remainder as one token, so the line renders silently mis-coloured (and the search
 * list, which caches what it got, keeps it that way for the session). Cold, the first TypeScript line costs
 * ~100ms; on a machine with every core busy that is over the budget, which is how a correct line came back flat.
 * Paying the compile here — inside the load every caller already awaits, off the render path — leaves a real
 * line at a millisecond or two, and the budget doing only what it is meant to do: bound a pathological line.
 * The text is nonsense in most languages by design; it only has to drive the scanner through the rules a line
 * of code hits (keywords, strings, brackets, a comment). */
const WARM_UP = `export class A { async b(c = "d") { return [1, /e/g]; } } // f`;

let core: Promise<HighlighterCore> | undefined;
// lang → the load in flight or already settled. Keyed rather than a plain "loaded" set because grammar loads
// arrive in bursts: a list of search snippets asks for the same language a few hundred times in one tick, and
// a set only recorded the language AFTER the import resolved, so every one of them re-imported and
// re-registered it. A rejected load is dropped from the map so a later render retries.
const grammars = new Map<string, Promise<HighlighterCore>>();

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

// Ensure the core is built and `lang`'s grammar is loaded (both one-time, however many callers ask at once),
// returning the shared instance — or undefined for a language we don't ship. Shared by highlight (HTML),
// tokenizeLine and the Monaco bridge (useMonaco).
const ensureLang = (lang: string): Promise<HighlighterCore | undefined> => {
    const pending = grammars.get(lang);
    if (pending) {
        return pending;
    }
    const load = langLoader(lang);
    if (!load) {
        return Promise.resolve(undefined);
    }
    const loading = (async () => {
        const instance = await ensureCore();
        await instance.loadLanguage((await load()) as Parameters<HighlighterCore[`loadLanguage`]>[0]);
        instance.codeToTokens(WARM_UP, { lang, themes: { light: THEME_LIGHT, dark: THEME_DARK } });
        return instance;
    })();
    grammars.set(lang, loading);
    // A grammar chunk that failed to load (offline, a dev optimizer 504) must not be remembered as failed —
    // forget it so the next render tries again. The rejection still reaches the caller awaiting `loading`.
    void loading.catch(() => grammars.delete(lang));
    return loading;
};

// Highlight `code` as `lang`, returning dual-theme HTML. Unsupported langs return undefined so the caller
// can fall back to rendering the raw text.
const highlight = async (code: string, lang: string): Promise<string | undefined> =>
    (await ensureLang(lang))?.codeToHtml(code, { lang, themes: { light: THEME_LIGHT, dark: THEME_DARK } });

// The colour tokens of a SINGLE line, for the callers that render their own markup around the code (see
// CodeToken). Tokenized on its own, with no grammar state carried in from the lines above it — all a snippet
// lifted out of its file can do. Unsupported langs return undefined, like `highlight`.
const tokenizeLine = async (line: string, lang: string): Promise<readonly CodeToken[] | undefined> =>
    (await ensureLang(lang))?.codeToTokens(line, { lang, themes: { light: THEME_LIGHT, dark: THEME_DARK } }).tokens[0];

export function useHighlighter() {
    return { highlight, tokenizeLine, ensureCore, ensureLang };
}
