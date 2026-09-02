import type { ShikiLang } from "./langs.js";

/* WHICH GRAMMAR A PATH IS READ WITH, which is the first question of every reading in this package: the
 * comment-free source a diff renders, the code-only +/− a review shows, and the colours the editor paints are
 * all downstream of it, and they have to agree. One table, one answer, wherever the question is asked — the
 * app resolving a file it is about to open, and the daemon counting a changed file it will never render.
 *
 * `ShikiLang` is the grammar table itself (langs.ts), so an id we ship no grammar for does not compile: it used
 * to render as uncoloured plain text, which looks exactly like a plain file. */

// Above this fetch the text but SKIP Shiki (plain <pre>): the JS-regex engine janks on huge/minified input.
export const HIGHLIGHT_MAX_BYTES = 512_000;

// File extension → Shiki language id.
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
    // SVG is XML, and stays TEXT here on purpose. The viewers extension shows the picture; its Source toggle,
    // its diff, and its fallback when no extension is loaded are all markup in the editor.
    svg: "xml",
    // Timestamps, levels and paths coloured like a terminal. Only under the highlight cap, the logs that most
    // want it are the ones far too big for a tokenizer, and those open plain in the windowed viewer.
    log: "log",
    mk: "make",
    md: "markdown",
    markdown: "markdown",
    mdx: "markdown",
};

// Exact (lowercased) filenames → Shiki lang id, for well-known config files that carry no usable extension.
const NAME_LANG: Record<string, ShikiLang> = {
    ".npmrc": "ini",
    ".yarnrc": "ini",
    ".editorconfig": "ini",
    ".gitconfig": "ini",
    ".gitmodules": "ini",
    // Glob-per-line like ignore files, comments and wildcards highlight correctly.
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

// Lowercased basename + extension of a path. dot > 0 so a dotfile (".gitignore") keeps an empty extension
// rather than "gitignore".
export const nameExt = (path: string): { name: string; ext: string } => {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const dot = name.lastIndexOf(".");
    return { name, ext: dot > 0 ? name.slice(dot + 1) : "" };
};

// The Shiki lang id for a file, accounting for extensionless special files (Dockerfile, .env variants,
// config dotfiles).
export const langFor = (name: string, ext: string): ShikiLang | undefined => {
    if (name === "dockerfile" || ext === "dockerfile") {
        return "docker";
    }
    if (ext === "env" || name === ".env" || name.startsWith(".env.")) {
        return "dotenv";
    }
    // Any ".xxxignore" dotfile (.gitignore, .dockerignore, .prettierignore, .npmignore, .helmignore, …)
    // shares gitignore syntax.
    if (name.startsWith(".") && name.endsWith("ignore")) {
        return "gitignore";
    }
    return NAME_LANG[name] ?? EXT_LANG[ext];
};

// The Shiki lang id for a file PATH, the same extension/filename resolution the workspace code viewer applies
// (langFor: extension table, well-known filenames, and the dockerfile/.env/ignore specials). Exposed so the
// chat's Read tool cards color file contents from the same source of truth as the /workspace editor. Content-
// based shebang detection stays out here: it needs the file bytes (see langFromShebang), which a card lacks.
export const codeLangForPath = (path: string): ShikiLang | undefined => {
    const { name, ext } = nameExt(path);
    return langFor(name, ext);
};

// Shebang interpreter basename → Shiki lang id, for extensionless scripts whose name carries no clue
// (`intentic-machine-boot`, `run`, …). This is the content-based fallback VSCode uses when the filename
// doesn't already resolve a language. Only interpreters whose grammar the app ships appear here; the rest
// stay plain text. Deno/Bun run TS as often as JS, and the TypeScript grammar is a JS superset, so both map
// to typescript (it colors plain JS correctly too).
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

// The Shiki lang id implied by a `#!…` first line, or undefined when there's no shebang or its interpreter
// isn't one we ship. Called AFTER the bytes are read (unlike resolveFile), only when the filename resolved no
// language, so a known extension always wins, matching VSCode's precedence. Handles `#!/bin/bash`,
// `#!/usr/bin/env bash`, `#!/usr/bin/env -S bash -eu`, and version suffixes (`python3.11` → python). Cheap for
// the overwhelmingly common no-shebang case: it bails on the first two bytes before scanning anything.
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
    // `env` execs the first following non-flag argument (so skip `-S` and friends); otherwise the path itself.
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
    // Trim a trailing version (python3, python3.11, ruby2.7) so the base interpreter still resolves.
    return SHEBANG_LANG[interpreter] ?? SHEBANG_LANG[interpreter.replace(/[0-9.]+$/, "")];
};

/* The Shiki lang id for a file whose REAL size is now known (the daemon reported it with the first window),
 * and whose bytes are in hand: the extension/filename table, then the shebang the way VSCode does it, and
 * nothing at all above the highlight cap. The one place the tokenizer decision is made once the guesswork is
 * over, resolveFile's `lang` is only a pre-warm hint, made before the read from a size that may be missing. */
export const highlightLangFor = (path: string, size: number, content: string): ShikiLang | undefined => {
    if (size > HIGHLIGHT_MAX_BYTES) {
        return undefined;
    }
    return codeLangForPath(path) ?? langFromShebang(content);
};
