import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/* Shared Shiki highlighter. One lazily-built core instance for the whole app, using the JavaScript RegExp
 * engine (no WASM, so no asset-pipeline config) and fine-grained, dynamically-imported grammars/themes —
 * only what's actually rendered ships in the bundle.
 *
 * Emits dual-theme HTML (light color inline + a `--shiki-dark` CSS var per token), so light/dark switching
 * is pure CSS keyed off the app's `[data-mode="dark"]` attribute — no re-highlighting on theme toggle (see
 * code.css). Module-level state = one singleton for the whole app. */

const THEME_LIGHT = `light-plus`;
const THEME_DARK = `dark-plus`;

// Lazily-importable grammars, keyed by Shiki language id — only the ones actually rendered ship in the
// bundle. The workspace file viewer maps a file's extension to one of these ids (see file-type.ts); add a
// row here and an extension mapping there to cover a new language. Callers stay untouched.
const LANGS: Record<string, () => Promise<unknown>> = {
    bash: () => import(`@shikijs/langs/bash`),
    powershell: () => import(`@shikijs/langs/powershell`),
    typescript: () => import(`@shikijs/langs/typescript`),
    tsx: () => import(`@shikijs/langs/tsx`),
    javascript: () => import(`@shikijs/langs/javascript`),
    jsx: () => import(`@shikijs/langs/jsx`),
    json: () => import(`@shikijs/langs/json`),
    yaml: () => import(`@shikijs/langs/yaml`),
    css: () => import(`@shikijs/langs/css`),
    scss: () => import(`@shikijs/langs/scss`),
    less: () => import(`@shikijs/langs/less`),
    html: () => import(`@shikijs/langs/html`),
    python: () => import(`@shikijs/langs/python`),
    go: () => import(`@shikijs/langs/go`),
    rust: () => import(`@shikijs/langs/rust`),
    java: () => import(`@shikijs/langs/java`),
    c: () => import(`@shikijs/langs/c`),
    cpp: () => import(`@shikijs/langs/cpp`),
    csharp: () => import(`@shikijs/langs/csharp`),
    sql: () => import(`@shikijs/langs/sql`),
    toml: () => import(`@shikijs/langs/toml`),
    xml: () => import(`@shikijs/langs/xml`),
    ini: () => import(`@shikijs/langs/ini`),
    docker: () => import(`@shikijs/langs/docker`),
    dotenv: () => import(`@shikijs/langs/dotenv`),
    // Local grammar — @shikijs/langs has none for ignore files.
    gitignore: () => import(`./gitignoreGrammar`),
    make: () => import(`@shikijs/langs/make`),
    prisma: () => import(`@shikijs/langs/prisma`),
    graphql: () => import(`@shikijs/langs/graphql`),
    vue: () => import(`@shikijs/langs/vue`),
    svelte: () => import(`@shikijs/langs/svelte`),
    php: () => import(`@shikijs/langs/php`),
    ruby: () => import(`@shikijs/langs/ruby`),
    kotlin: () => import(`@shikijs/langs/kotlin`),
    swift: () => import(`@shikijs/langs/swift`),
    diff: () => import(`@shikijs/langs/diff`),
    markdown: () => import(`@shikijs/langs/markdown`),
};

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
