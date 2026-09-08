import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { langLoader } from "@intentic/code-read/langs";

// Shared Shiki highlighter: one lazily-built core for the app, using the JS RegExp engine (no WASM) with
// dynamically-imported grammars/themes so only rendered languages ship. Emits dual-theme HTML so a theme
// toggle needs no re-highlighting (see code.css).

const THEME_LIGHT = `light-plus`;
const THEME_DARK = `dark-plus`;

// One line's colour tokens, for a surface that interleaves its own markup with the code (the workspace
// search list's match `<mark>`); matches the HTML path's dual-theme pair.
export type CodeToken = Pick<ThemedToken, "content" | "offset" | "htmlStyle">;

// Tokenizes once per grammar at load time, off the render path: a cold grammar's regex compile can
// exceed vscode-textmate's per-line budget and silently mis-colour real code. The nonsense text just
// has to exercise a line's usual rule set.
const WARM_UP = `export class A { async b(c = "d") { return [1, /e/g]; } } // f`;

let core: Promise<HighlighterCore> | undefined;
// lang -> the load in flight or settled; keyed rather than a loaded set, since a burst of requests for
// one language would otherwise each re-import before the first resolves. A rejected load is dropped so
// a later render retries.
const grammars = new Map<string, Promise<HighlighterCore>>();

// Builds the shared core once, off the render path; also what @shikijs/monaco tokenizes with, so
// preview and editor agree.
const ensureCore = (): Promise<HighlighterCore> => {
    if (!core) {
        core = createHighlighterCore({
            themes: [import(`@shikijs/themes/light-plus`), import(`@shikijs/themes/dark-plus`)],
            langs: [],
            // Don't throw on a grammar regex the JS engine can't compile; degrade instead.
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        });
    }
    return core;
};

// Ensures the core and `lang`'s grammar are loaded once however many callers ask at once; shared by
// `highlight`, `tokenizeLine` and the Monaco bridge.
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
    // A grammar that failed to load must not be remembered as failed; forget it so the next render retries.
    void loading.catch(() => grammars.delete(lang));
    return loading;
};

// Unsupported langs return undefined so the caller can fall back to raw text.
const highlight = async (code: string, lang: string): Promise<string | undefined> =>
    (await ensureLang(lang))?.codeToHtml(code, { lang, themes: { light: THEME_LIGHT, dark: THEME_DARK } });

// Tokenizes a single line with no grammar state carried in from lines above it, all a lifted snippet can offer.
const tokenizeLine = async (line: string, lang: string): Promise<readonly CodeToken[] | undefined> =>
    (await ensureLang(lang))?.codeToTokens(line, { lang, themes: { light: THEME_LIGHT, dark: THEME_DARK } }).tokens[0];

export function useHighlighter() {
    return { highlight, tokenizeLine, ensureCore, ensureLang };
}
