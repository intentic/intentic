// What a file is, by its name: the one format table the icon, the home, a diff's reading and every thumbnail ask.

// `image` is what an <img> paints (a picture no browser paints stays `generic`); `video` is what a <video> is handed.
export type FileCategory =
    "code" | "style" | "config" | "data" | "image" | "audio" | "video" | "doc" | "shell" | "archive" | "lock" | "binary" | "generic";

export interface FileFormat {
    readonly category: FileCategory;
    // What people call it; absent where the category's word says enough.
    readonly label?: string;
    // Never read as text: a viewer draws it, or it is offered as bytes.
    readonly binary?: true;
    // How a diff reads it: markdown and plain as prose, a table as cells, a document as the text fileq renders from it.
    readonly reads?: "markdown" | "plain" | "table" | "document";
    // A document whose rendered text is one table per sheet, so its diff is a grid of cells.
    readonly sheet?: true;
    // Its viewer draws pages and nothing else, so a card that takes no pointer can mount it as it stands.
    readonly pages?: true;
}

const picture = (label?: string): FileFormat => ({ category: `image`, binary: true, ...(label === undefined ? {} : { label }) });
const media = (category: "audio" | "video", label?: string): FileFormat => ({ category, binary: true, ...(label === undefined ? {} : { label }) });
const archive = (label?: string): FileFormat => ({ category: `archive`, binary: true, reads: `document`, ...(label === undefined ? {} : { label }) });
const BYTES: FileFormat = { category: `binary`, binary: true };
const DOCUMENT: FileFormat = { category: `doc`, binary: true, reads: `document` };
const SHEET: FileFormat = { category: `data`, binary: true, reads: `document`, sheet: true };
const PAGES: FileFormat = { ...DOCUMENT, pages: true };

const BY_EXT: Readonly<Record<string, FileFormat>> = {
    png: picture(`PNG picture`),
    jpg: picture(`JPEG picture`),
    jpeg: picture(`JPEG picture`),
    gif: picture(`GIF picture`),
    webp: picture(`WebP picture`),
    avif: picture(`AVIF picture`),
    bmp: picture(),
    ico: picture(`Icon`),
    // Markup, so it reads and diffs as text, though an <img> paints it too.
    svg: { category: `image`, label: `SVG drawing` },
    heic: BYTES,
    heif: BYTES,
    tiff: BYTES,
    psd: BYTES,
    sketch: BYTES,
    fig: BYTES,
    // The set the daemon types as audio/* on /workspace/raw, which is what a player is handed.
    mp3: media(`audio`, `MP3 audio`),
    wav: media(`audio`, `WAV audio`),
    flac: media(`audio`, `FLAC audio`),
    ogg: media(`audio`, `Ogg audio`),
    oga: media(`audio`),
    opus: media(`audio`),
    weba: media(`audio`),
    m4a: media(`audio`, `AAC audio`),
    aac: media(`audio`),
    mp4: media(`video`, `MP4 video`),
    m4v: media(`video`),
    webm: media(`video`, `WebM video`),
    ogv: media(`video`),
    mov: media(`video`, `QuickTime video`),
    "3gp": media(`video`),
    mkv: media(`video`, `Matroska video`),
    avi: media(`video`),
    wmv: media(`video`),
    pdf: { ...DOCUMENT, label: `PDF document` },
    docx: { ...PAGES, label: `Word document` },
    odt: PAGES,
    ott: PAGES,
    rtf: PAGES,
    epub: DOCUMENT,
    pptx: { ...DOCUMENT, label: `PowerPoint deck` },
    odp: DOCUMENT,
    otp: DOCUMENT,
    odg: DOCUMENT,
    otg: { category: `generic`, binary: true },
    // JSON by every other rule, and unreadable as JSON, so its diff reads the text fileq renders from it.
    ipynb: { category: `doc`, reads: `document` },
    md: { category: `doc`, label: `Markdown`, reads: `markdown` },
    markdown: { category: `doc`, label: `Markdown`, reads: `markdown` },
    mdx: { category: `doc`, label: `Markdown`, reads: `markdown` },
    txt: { category: `doc`, label: `Plain text`, reads: `plain` },
    xlsx: { ...SHEET, label: `Excel spreadsheet` },
    ods: SHEET,
    ots: SHEET,
    csv: { category: `data`, reads: `table` },
    tsv: { category: `data`, reads: `table` },
    sql: { category: `data`, label: `SQL` },
    prisma: { category: `data`, label: `Prisma schema` },
    graphql: { category: `data`, label: `GraphQL` },
    gql: { category: `data`, label: `GraphQL` },
    ts: { category: `code`, label: `TypeScript` },
    tsx: { category: `code`, label: `TypeScript` },
    mts: { category: `code`, label: `TypeScript` },
    cts: { category: `code`, label: `TypeScript` },
    js: { category: `code`, label: `JavaScript` },
    jsx: { category: `code`, label: `JavaScript` },
    mjs: { category: `code`, label: `JavaScript` },
    cjs: { category: `code`, label: `JavaScript` },
    vue: { category: `code`, label: `Vue component` },
    svelte: { category: `code`, label: `Svelte component` },
    astro: { category: `code`, label: `Astro page` },
    html: { category: `code`, label: `Web page` },
    htm: { category: `code`, label: `Web page` },
    py: { category: `code`, label: `Python` },
    rs: { category: `code`, label: `Rust` },
    go: { category: `code`, label: `Go` },
    rb: { category: `code`, label: `Ruby` },
    java: { category: `code`, label: `Java` },
    kt: { category: `code`, label: `Kotlin` },
    swift: { category: `code`, label: `Swift` },
    c: { category: `code`, label: `C` },
    h: { category: `code`, label: `C header` },
    cpp: { category: `code`, label: `C++` },
    cs: { category: `code`, label: `C#` },
    php: { category: `code`, label: `PHP` },
    css: { category: `style`, label: `Style sheet` },
    scss: { category: `style`, label: `Style sheet` },
    sass: { category: `style`, label: `Style sheet` },
    less: { category: `style`, label: `Style sheet` },
    json: { category: `config`, label: `JSON` },
    jsonc: { category: `config`, label: `JSON` },
    yaml: { category: `config`, label: `YAML` },
    yml: { category: `config`, label: `YAML` },
    toml: { category: `config`, label: `TOML` },
    xml: { category: `config`, label: `XML` },
    ini: { category: `config` },
    cfg: { category: `config` },
    conf: { category: `config` },
    sh: { category: `shell`, label: `Shell script` },
    bash: { category: `shell`, label: `Shell script` },
    zsh: { category: `shell`, label: `Shell script` },
    ps1: { category: `shell`, label: `PowerShell script` },
    zip: archive(`ZIP archive`),
    tar: archive(`Tar archive`),
    tgz: archive(`Tar archive`),
    gz: archive(`Gzip archive`),
    "7z": archive(`7-Zip archive`),
    rar: archive(`RAR archive`),
    bz2: archive(),
    xz: archive(),
    zst: archive(),
    jar: archive(),
    war: archive(),
    whl: archive(),
    woff: { ...BYTES, label: `Web font` },
    woff2: { ...BYTES, label: `Web font` },
    ttf: { ...BYTES, label: `TrueType font` },
    otf: { ...BYTES, label: `OpenType font` },
    eot: BYTES,
    exe: BYTES,
    dll: BYTES,
    so: BYTES,
    dylib: BYTES,
    bin: BYTES,
    dat: BYTES,
    o: BYTES,
    a: BYTES,
    obj: BYTES,
    wasm: BYTES,
    node: BYTES,
    class: BYTES,
    pyc: BYTES,
    lock: { category: `lock`, label: `Lockfile` },
    lockb: { category: `lock`, binary: true },
};

// Whole names (lowercased) the extension map cannot reach: extensionless, or a dotfile.
const BY_NAME: Readonly<Record<string, FileFormat>> = {
    dockerfile: { category: `config` },
    makefile: { category: `config` },
    ".gitignore": { category: `config` },
    ".gitattributes": { category: `config` },
    ".dockerignore": { category: `config` },
    ".editorconfig": { category: `config` },
    ".npmrc": { category: `config` },
    ".env": { category: `config` },
    ".prettierignore": { category: `config` },
};

const UNKNOWN: FileFormat = { category: `generic` };

// The lowercased extension of a path's last segment; "" when it has none, a dotfile included.
export const extensionOf = (path: string): string => {
    const name = path.slice(path.lastIndexOf(`/`) + 1).toLowerCase();
    const dot = name.lastIndexOf(`.`);
    return dot > 0 ? name.slice(dot + 1) : ``;
};

export const formatOf = (path: string): FileFormat =>
    BY_EXT[extensionOf(path)] ?? BY_NAME[path.slice(path.lastIndexOf(`/`) + 1).toLowerCase()] ?? UNKNOWN;
