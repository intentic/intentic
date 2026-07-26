// Pure file-type resolution for the workspace viewer: maps a path + size to a render mode (and a Shiki lang id
// for code), so the viewer dispatches WITHOUT fetching first. No framework code here — unit-testable in isolation.

export type ViewMode = "code" | "markdown" | "image" | "svg" | "pdf" | "audio" | "docx" | "xlsx" | "binary" | "too-large" | "empty";

export interface FileResolution {
    readonly mode: ViewMode;
    // Shiki language id for `code` mode; undefined renders as plain <pre> (unknown extension, or a file too big
    // to tokenize). Must be a key of useHighlighter LANGS.
    readonly lang?: string;
}

// Size gates (bytes). Tuned for a browser relay, not VSCode's multi-GB limits.
// Matches the daemon's MAX_RAW_BYTES — a larger image/PDF would 413 on /workspace/raw, so pre-empt it.
export const RAW_MAX_BYTES = 25 * 1024 * 1024;
// Above this a text file is never fetched — show "too large" + a download instead of streaming megabytes of text.
const TEXT_MAX_BYTES = 2_000_000;
// Above this fetch the text but SKIP Shiki (plain <pre>): the JS-regex engine janks on huge/minified input.
const HIGHLIGHT_MAX_BYTES = 512_000;

// File extension → Shiki language id. Keys must exist in useHighlighter LANGS.
const EXT_LANG: Record<string, string> = {
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
    php: "php",
    rb: "ruby",
    kt: "kotlin",
    kts: "kotlin",
    swift: "swift",
    diff: "diff",
    patch: "diff",
    mk: "make",
    md: "markdown",
    markdown: "markdown",
    mdx: "markdown",
};

// Inline-renderable images (svg is handled separately — it's text and gets a source toggle).
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);
// Played inline via a native <audio> element (raw bytes → blob: URL), so they leave BINARY_EXTS below.
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac"]);
// Known-binary extensions we never try to render as text — straight to the "download" fallback.
const BINARY_EXTS = new Set([
    "woff",
    "woff2",
    "ttf",
    "otf",
    "eot", // fonts
    "zip",
    "gz",
    "tgz",
    "tar",
    "rar",
    "7z",
    "bz2",
    "xz", // archives
    "exe",
    "dll",
    "so",
    "dylib",
    "bin",
    "dat",
    "o",
    "a",
    "obj",
    "wasm",
    "node", // binaries
    "class",
    "jar",
    "pyc",
    "lockb", // compiled/lock
    "mp4",
    "mov",
    "avi",
    "mkv",
    "webm",
    "wmv", // video
    "heic",
    "heif",
    "tiff",
    "psd",
    "sketch",
    "fig", // non-inline images / design
]);

// Exact (lowercased) filenames → Shiki lang id, for well-known config files that carry no usable extension.
const NAME_LANG: Record<string, string> = {
    ".npmrc": "ini",
    ".yarnrc": "ini",
    ".editorconfig": "ini",
    ".gitconfig": "ini",
    ".gitmodules": "ini",
    // Glob-per-line like ignore files — comments and wildcards highlight correctly.
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
const nameExt = (path: string): { name: string; ext: string } => {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const dot = name.lastIndexOf(".");
    return { name, ext: dot > 0 ? name.slice(dot + 1) : "" };
};

// The Shiki lang id for a file, accounting for extensionless special files (Dockerfile, .env variants,
// config dotfiles).
const langFor = (name: string, ext: string): string | undefined => {
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

// The Shiki lang id for a file PATH — the same extension/filename resolution the workspace code viewer applies
// (langFor: extension table, well-known filenames, and the dockerfile/.env/ignore specials). Exposed so the
// chat's Read tool cards color file contents from the same source of truth as the /workspace editor. Content-
// based shebang detection stays out here: it needs the file bytes (see langFromShebang), which a card lacks.
export const codeLangForPath = (path: string): string | undefined => {
    const { name, ext } = nameExt(path);
    return langFor(name, ext);
};

// Shebang interpreter basename → Shiki lang id, for extensionless scripts whose name carries no clue
// (`intentic-machine-boot`, `run`, …). This is the content-based fallback VSCode uses when the filename
// doesn't already resolve a language. Only interpreters whose grammar the app ships appear here; the rest
// stay plain text. Deno/Bun run TS as often as JS, and the TypeScript grammar is a JS superset, so both map
// to typescript (it colors plain JS correctly too).
const SHEBANG_LANG: Record<string, string> = {
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
// language — so a known extension always wins, matching VSCode's precedence. Handles `#!/bin/bash`,
// `#!/usr/bin/env bash`, `#!/usr/bin/env -S bash -eu`, and version suffixes (`python3.11` → python). Cheap for
// the overwhelmingly common no-shebang case: it bails on the first two bytes before scanning anything.
export const langFromShebang = (content: string): string | undefined => {
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

// Resolve how to render `path` given its byte size (undefined when unknown — the tree cap, or stat failed; we
// then proceed optimistically and let the post-read NUL check / daemon 413 catch the rare bad case).
export const resolveFile = (path: string, size: number | undefined): FileResolution => {
    const { name, ext } = nameExt(path);
    const tooBig = (limit: number): boolean => size !== undefined && size > limit;
    // An empty file has nothing to preview — but text types (code/markdown, incl. unknown/dotfiles) still fall
    // through to their editable blank editor. Only the non-text preview types below short-circuit to "empty".
    const empty = size === 0;

    if (ext === "svg") {
        return empty ? { mode: "empty" } : tooBig(RAW_MAX_BYTES) ? { mode: "too-large" } : { mode: "svg" };
    }
    if (IMAGE_EXTS.has(ext)) {
        return empty ? { mode: "empty" } : tooBig(RAW_MAX_BYTES) ? { mode: "too-large" } : { mode: "image" };
    }
    if (ext === "pdf") {
        return empty ? { mode: "empty" } : tooBig(RAW_MAX_BYTES) ? { mode: "too-large" } : { mode: "pdf" };
    }
    if (MARKDOWN_EXTS.has(ext)) {
        return tooBig(TEXT_MAX_BYTES) ? { mode: "too-large" } : { mode: "markdown" };
    }
    // Raw-byte families: fetched via /workspace/raw, so the 25 MiB cap applies (oversize → download).
    if (AUDIO_EXTS.has(ext)) {
        return empty ? { mode: "empty" } : tooBig(RAW_MAX_BYTES) ? { mode: "too-large" } : { mode: "audio" };
    }
    if (ext === "docx") {
        return empty ? { mode: "empty" } : tooBig(RAW_MAX_BYTES) ? { mode: "too-large" } : { mode: "docx" };
    }
    if (ext === "xlsx") {
        return empty ? { mode: "empty" } : tooBig(RAW_MAX_BYTES) ? { mode: "too-large" } : { mode: "xlsx" };
    }
    if (BINARY_EXTS.has(ext)) {
        return empty ? { mode: "empty" } : { mode: "binary" };
    }
    // Code or plain text — including unknown extensions and dotfiles, optimistically treated as text.
    if (tooBig(TEXT_MAX_BYTES)) {
        return { mode: "too-large" };
    }
    return { mode: "code", lang: tooBig(HIGHLIGHT_MAX_BYTES) ? undefined : langFor(name, ext) };
};
