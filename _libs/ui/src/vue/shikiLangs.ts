/* Single source of truth for the Shiki grammars the app ships. Split out from useHighlighter so the web
 * app's vite.config can derive its optimizeDeps.include from the same list without pulling in shiki/core.
 *
 * The import specifiers MUST stay literal — Vite reads them at build time to know which grammar chunks to
 * emit, so the map can't be generated from data. */

// Lazily-importable grammars, keyed by Shiki language id — only the ones actually rendered ship in the
// bundle. The workspace file viewer maps a file's extension to one of these ids (see file-type.ts); add a
// row here and an extension mapping there to cover a new language. Callers stay untouched.
export const LANGS: Record<string, () => Promise<unknown>> = {
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

// The @shikijs/langs packages Vite must pre-bundle (see the web app's vite.config optimizeDeps.include):
// every grammar except the local gitignore one. Derived from LANGS so it can't drift. Without pre-bundling,
// the dev optimizer serves 504 for each dynamically-imported grammar chunk and <Code> falls back to plain
// text.
export const shikiLangDeps = Object.keys(LANGS)
    .filter((id) => id !== `gitignore`)
    .map((id) => `@shikijs/langs/${id}`);
