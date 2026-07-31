// Pure file-type resolution for the workspace viewer: maps a path + size to a render mode (and a Shiki lang id
// for text), so the viewer dispatches WITHOUT fetching first. No framework code here — unit-testable in isolation.

/* `big-text` is decided AFTER the read, from the size the daemon reports, like `binary` is decided from the
 * bytes: text over the editable cap renders windowed and read-only (BigTextView) instead of as a buffer.
 * `too-large` is now only ever a raw-BYTE family — an image or a PDF past what /workspace/raw will serve. */
export type ViewMode = "code" | "markdown" | "big-text" | "image" | "svg" | "pdf" | "audio" | "docx" | "xlsx" | "binary" | "too-large" | "empty";

export interface FileResolution {
    readonly mode: ViewMode;
    // Shiki language id, carried by every TEXT mode (`code`, `markdown`, `svg`) — all three render source through
    // the same editor, so all three need a grammar. undefined opens as plaintext (unknown extension, or a file too
    // big to tokenize) and is the only value a non-text mode ever carries. Must be a key of useHighlighter LANGS.
    readonly lang?: string;
}

// Size gates (bytes). Tuned for a browser relay, not VSCode's multi-GB limits.
// Matches the daemon's MAX_RAW_BYTES — a larger image/PDF would 413 on /workspace/raw, so pre-empt it.
export const RAW_MAX_BYTES = 25 * 1024 * 1024;
/* Above this a text file opens READ-ONLY and WINDOWED (BigTextView) instead of as an editable buffer: the
 * editor holds the whole text plus a baseline to diff it against, and a save posts all of it back, none of
 * which a log wants. It is not a refusal — text always opens. Monaco itself is comfortable far above this
 * (a 120MB, 1M-line model builds in ~150ms); the ceiling is what the daemon will serve in one window. */
export const TEXT_EDIT_MAX_BYTES = 2_000_000;
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
    // SVG is XML. The image is what the viewer SHOWS, but its Source toggle and its diff are markup.
    svg: "xml",
    // Timestamps, levels and paths coloured like a terminal. Only under the highlight cap — the logs that most
    // want it are the ones far too big for a tokenizer, and those open plain in the windowed viewer.
    log: "log",
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

/* The Shiki lang id for a file whose REAL size is now known (the daemon reported it with the first window),
 * and whose bytes are in hand: the extension/filename table, then the shebang the way VSCode does it, and
 * nothing at all above the highlight cap. The one place the tokenizer decision is made once the guesswork is
 * over — resolveFile's `lang` is only a pre-warm hint, made before the read from a size that may be missing. */
export const highlightLangFor = (path: string, size: number, content: string): string | undefined => {
    if (size > HIGHLIGHT_MAX_BYTES) {
        return undefined;
    }
    return codeLangForPath(path) ?? langFromShebang(content);
};

// Resolve how to render `path` given its byte size (undefined when unknown — the tree cap, or stat failed; we
// then proceed optimistically and let the post-read NUL check / daemon 413 catch the rare bad case).
export const resolveFile = (path: string, size: number | undefined): FileResolution => {
    const { name, ext } = nameExt(path);
    const tooBig = (limit: number): boolean => size !== undefined && size > limit;
    // An empty file has nothing to preview — but text types (code/markdown, incl. unknown/dotfiles) still fall
    // through to their editable blank editor. Only the non-text preview types below short-circuit to "empty".
    const empty = size === 0;
    // The tokenizer hint every TEXT mode carries. Resolved ONCE here rather than per-branch: markdown and svg
    // render their source through the same editor `code` does, so "what grammar is this file?" has exactly one
    // answer per path, independent of which preview the mode picks. Nothing at all above the highlight cap.
    const lang = tooBig(HIGHLIGHT_MAX_BYTES) ? undefined : langFor(name, ext);

    if (ext === "svg") {
        return empty ? { mode: "empty" } : tooBig(RAW_MAX_BYTES) ? { mode: "too-large" } : { mode: "svg", lang };
    }
    if (IMAGE_EXTS.has(ext)) {
        return empty ? { mode: "empty" } : tooBig(RAW_MAX_BYTES) ? { mode: "too-large" } : { mode: "image" };
    }
    if (ext === "pdf") {
        return empty ? { mode: "empty" } : tooBig(RAW_MAX_BYTES) ? { mode: "too-large" } : { mode: "pdf" };
    }
    if (MARKDOWN_EXTS.has(ext)) {
        return { mode: "markdown", lang };
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
    // Code or plain text — including unknown extensions and dotfiles, optimistically treated as text. No size
    // gate here: the SIZE the gate needs is the daemon's, which arrives with the first window (FileViewer), and
    // a resolution made from a tree entry that may be missing is exactly how an unbounded read used to slip
    // through. Text always resolves to text; how much of it opens, and whether it is editable, is decided there.
    return { mode: "code", lang };
};

// The render modes that are TEXT — the ones a line-by-line diff is the right tool for.
const TEXT_MODES: ReadonlySet<ViewMode> = new Set<ViewMode>(["code", "markdown", "svg"]);

// Is a DIFF of this path one to show as bytes rather than as text? Two independent answers, and both are
// needed:
//   - the daemon read NUL bytes out of a file whose extension told us nothing (`binary` on the response), or
//   - the path itself says there was never any text here — a .png, a .pdf, a .zip.
// The second is what stops an image from falling into the "too large to diff" message. The daemon flags a side
// over its 512 KiB text cap as `truncated` BEFORE it ever looks for NUL bytes, so a megabyte screenshot arrives
// claiming to be an oversized text file. It isn't one, and /diff/raw serves it to 25 MiB — the size that
// matters for showing a picture, not the size that matters for tokenizing source. `truncated` keeps its
// meaning for what it actually describes: a genuinely huge TEXT file, which this leaves alone.
export const rendersAsBytes = (path: string, binary: boolean | undefined): boolean =>
    binary === true || !TEXT_MODES.has(resolveFile(path, undefined).mode);
