// Source of truth for Shiki grammars the app ships; vite.config's optimizeDeps.include derives from this list. Import
// specifiers must stay literal since vite resolves them at build time, not from data.

// Lazily-imported grammars keyed by Shiki lang id; only actually-rendered ones ship in the bundle.
export const LANGS = {
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
    // Local grammar: @shikijs/langs has none for ignore files.
    gitignore: () => import(`./gitignore-grammar.js`),
    make: () => import(`@shikijs/langs/make`),
    prisma: () => import(`@shikijs/langs/prisma`),
    graphql: () => import(`@shikijs/langs/graphql`),
    vue: () => import(`@shikijs/langs/vue`),
    svelte: () => import(`@shikijs/langs/svelte`),
    astro: () => import(`@shikijs/langs/astro`),
    php: () => import(`@shikijs/langs/php`),
    ruby: () => import(`@shikijs/langs/ruby`),
    kotlin: () => import(`@shikijs/langs/kotlin`),
    swift: () => import(`@shikijs/langs/swift`),
    diff: () => import(`@shikijs/langs/diff`),
    markdown: () => import(`@shikijs/langs/markdown`),
    log: () => import(`@shikijs/langs/log`),
} satisfies Record<string, () => Promise<unknown>>;

// Ids above, typed: naming an id with no shipped grammar (a markdown fence, a file-viewer entry) fails to compile
// instead of rendering as plain text.
export type ShikiLang = keyof typeof LANGS;

// Loader for an untrusted external id (a markdown fence's info string); unknown ids return undefined.
const loaders: ReadonlyMap<string, () => Promise<unknown>> = new Map(Object.entries(LANGS));
export const langLoader = (lang: string): (() => Promise<unknown>) | undefined => loaders.get(lang);

// Grammar packages vite.config must pre-bundle (optimizeDeps.include), derived from LANGS so it can't drift.
export const shikiLangDeps = Object.keys(LANGS)
    .filter((id) => id !== `gitignore`)
    .map((id) => `@shikijs/langs/${id}`);
