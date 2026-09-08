import type { ShikiLang } from "./langs.js";

// The grammar table (ShikiLang, langs.ts) decides how a path is read everywhere in this package: the app's colouring,
// the daemon's line counts, and the diff renderer must resolve to the same id. An id absent from the table fails to
// compile rather than falling back to plain text.

// Above this, render as plain <pre>; the regex tokenizer chokes on huge or minified files.
export const HIGHLIGHT_MAX_BYTES = 512_000;

const EXT_LANG: Record<string, ShikiLang> = {
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    tsx: "tsx",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "jsx",
    json: "json",
    jsonc: "json",
    json5: "json",
    webmanifest: "json",
    yaml: "yaml",
    yml: "yaml",
    css: "css",
    scss: "scss",
    sass: "scss",
    less: "less",
    html: "html",
    htm: "html",
    py: "python",
    pyi: "python",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hxx: "cpp",
    hh: "cpp",
    cs: "csharp",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    psm1: "powershell",
    sql: "sql",
    toml: "toml",
    xml: "xml",
    ini: "ini",
    cfg: "ini",
    conf: "ini",
    prisma: "prisma",
    graphql: "graphql",
    gql: "graphql",
    vue: "vue",
    svelte: "svelte",
    astro: "astro",
    php: "php",
    rb: "ruby",
    kt: "kotlin",
    kts: "kotlin",
    swift: "swift",
    diff: "diff",
    patch: "diff",
    // svg stays markup, not an image lang: the viewer's Source toggle, diff and fallback all render it as text.
    svg: "xml",
    // Large logs exceed the highlight cap and open plain in the windowed viewer regardless of this mapping.
    log: "log",
    mk: "make",
    md: "markdown",
    markdown: "markdown",
    mdx: "markdown",
};

// Lowercased filename → Shiki lang id, for config files with no usable extension.
const NAME_LANG: Record<string, ShikiLang> = {
    ".npmrc": "ini",
    ".yarnrc": "ini",
    ".editorconfig": "ini",
    ".gitconfig": "ini",
    ".gitmodules": "ini",
    // Glob-per-line syntax like ignore files.
    ".gitattributes": "gitignore",
    ".prettierrc": "json",
    ".babelrc": "json",
    ".eslintrc": "json",
    ".swcrc": "json",
    ".bashrc": "bash",
    ".zshrc": "bash",
    ".bash_profile": "bash",
    ".profile": "bash",
    makefile: "make",
};

// Lowercased basename and extension of a path; dot > 0 keeps a dotfile's name whole with an empty extension.
export const nameExt = (path: string): { name: string; ext: string } => {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const dot = name.lastIndexOf(".");
    return { name, ext: dot > 0 ? name.slice(dot + 1) : "" };
};

// Shiki lang id for a name+ext pair, including extensionless specials (dockerfile, .env variants, config dotfiles).
export const langFor = (name: string, ext: string): ShikiLang | undefined => {
    if (name === "dockerfile" || ext === "dockerfile") {
        return "docker";
    }
    if (ext === "env" || name === ".env" || name.startsWith(".env.")) {
        return "dotenv";
    }
    // Any dotfile ending "ignore" (.gitignore, .dockerignore, …) shares gitignore syntax.
    if (name.startsWith(".") && name.endsWith("ignore")) {
        return "gitignore";
    }
    return NAME_LANG[name] ?? EXT_LANG[ext];
};

// Same name/ext resolution as the workspace editor; shebang detection is separate since it needs file bytes.
export const codeLangForPath = (path: string): ShikiLang | undefined => {
    const { name, ext } = nameExt(path);
    return langFor(name, ext);
};

// Interpreter → Shiki lang id, used only as fallback; deno/bun map to typescript (a JS superset).
const SHEBANG_LANG: Record<string, ShikiLang> = {
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    dash: "bash",
    ksh: "bash",
    ash: "bash",
    node: "javascript",
    nodejs: "javascript",
    deno: "typescript",
    bun: "typescript",
    python: "python",
    ruby: "ruby",
    php: "php",
    pwsh: "powershell",
    powershell: "powershell",
};

const basename = (token: string): string => token.slice(token.lastIndexOf("/") + 1);

// Shiki lang id implied by a #! first line, or undefined if none or unshipped; called only after the filename resolves
// nothing, so a known extension always wins.
export const langFromShebang = (content: string): ShikiLang | undefined => {
    if (!content.startsWith("#!")) {
        return undefined;
    }
    const newline = content.indexOf("\n");
    const tokens = (newline === -1 ? content : content.slice(0, newline)).slice(2).trim().split(/\s+/).filter(Boolean);
    const first = tokens[0];
    if (first === undefined) {
        return undefined;
    }
    // `env` execs its first non-flag arg (skipping `-S` etc); otherwise the path itself is the interpreter.
    const interpreter =
        basename(first) === "env"
            ? tokens
                  .slice(1)
                  .map(basename)
                  .find((token) => !token.startsWith("-"))
            : basename(first);
    if (interpreter === undefined) {
        return undefined;
    }
    // Trim a trailing version (python3.11 → python) so the base interpreter still resolves.
    return SHEBANG_LANG[interpreter] ?? SHEBANG_LANG[interpreter.replace(/[0-9.]+$/, "")];
};

// Final lang once the file's bytes and real size are known (table, then shebang, none above cap); resolveFile's lang
// was only a pre-warm guess.
export const highlightLangFor = (path: string, size: number, content: string): ShikiLang | undefined => {
    if (size > HIGHLIGHT_MAX_BYTES) {
        return undefined;
    }
    return codeLangForPath(path) ?? langFromShebang(content);
};
