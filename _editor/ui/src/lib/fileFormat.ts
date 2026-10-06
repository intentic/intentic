import { t } from "../i18n/index.js";

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

// A label is a function wherever it is a word rather than a name: `t` reads the language at the moment it is called, so
// the table holds what to say and `formatOf` says it when asked (docs/architecture/languages.md, "Words are built when
// they are read").
type Label = string | (() => string);
type Entry = Omit<FileFormat, "label"> & { readonly label?: Label };

const labelled = (label?: Label): { label?: Label } => (label === undefined ? {} : { label });
const picture = (label?: Label): Entry => ({ category: `image`, binary: true, ...labelled(label) });
const media = (category: "audio" | "video", label?: Label): Entry => ({ category, binary: true, ...labelled(label) });
const archive = (label?: Label): Entry => ({ category: `archive`, binary: true, reads: `document`, ...labelled(label) });
const BYTES: Entry = { category: `binary`, binary: true };
const DOCUMENT: Entry = { category: `doc`, binary: true, reads: `document` };
const SHEET: Entry = { category: `data`, binary: true, reads: `document`, sheet: true };
const PAGES: Entry = { ...DOCUMENT, pages: true };

const BY_EXT: Readonly<Record<string, Entry>> = {
    png: picture(() => t(`ui.fileFormat.pngPicture`)),
    jpg: picture(() => t(`ui.fileFormat.jpegPicture`)),
    jpeg: picture(() => t(`ui.fileFormat.jpegPicture`)),
    gif: picture(() => t(`ui.fileFormat.gifPicture`)),
    webp: picture(() => t(`ui.fileFormat.webpPicture`)),
    avif: picture(() => t(`ui.fileFormat.avifPicture`)),
    bmp: picture(),
    ico: picture(() => t(`ui.fileFormat.icon`)),
    // Markup, so it reads and diffs as text, though an <img> paints it too.
    svg: { category: `image`, label: () => t(`ui.fileFormat.svgDrawing`) },
    heic: BYTES,
    heif: BYTES,
    tiff: BYTES,
    psd: BYTES,
    sketch: BYTES,
    fig: BYTES,
    // The set the daemon types as audio/* on /workspace/raw, which is what a player is handed.
    mp3: media(`audio`, () => t(`ui.fileFormat.mp3Audio`)),
    wav: media(`audio`, () => t(`ui.fileFormat.wavAudio`)),
    flac: media(`audio`, () => t(`ui.fileFormat.flacAudio`)),
    ogg: media(`audio`, () => t(`ui.fileFormat.oggAudio`)),
    oga: media(`audio`),
    opus: media(`audio`),
    weba: media(`audio`),
    m4a: media(`audio`, () => t(`ui.fileFormat.aacAudio`)),
    m4b: media(`audio`, () => t(`ui.fileFormat.audiobook`)),
    aac: media(`audio`),
    aif: media(`audio`, () => t(`ui.fileFormat.aiffAudio`)),
    aiff: media(`audio`, () => t(`ui.fileFormat.aiffAudio`)),
    caf: media(`audio`),
    mka: media(`audio`),
    wma: media(`audio`, () => t(`ui.fileFormat.windowsMediaAudio`)),
    amr: media(`audio`),
    mp4: media(`video`, () => t(`ui.fileFormat.mp4Video`)),
    m4v: media(`video`),
    webm: media(`video`, () => t(`ui.fileFormat.webmVideo`)),
    ogv: media(`video`),
    mov: media(`video`, () => t(`ui.fileFormat.quickTimeVideo`)),
    "3gp": media(`video`),
    mkv: media(`video`, () => t(`ui.fileFormat.matroskaVideo`)),
    avi: media(`video`),
    wmv: media(`video`),
    mpg: media(`video`, () => t(`ui.fileFormat.mpegVideo`)),
    mpeg: media(`video`, () => t(`ui.fileFormat.mpegVideo`)),
    "3g2": media(`video`),
    flv: media(`video`, () => t(`ui.fileFormat.flashVideo`)),
    pdf: { ...DOCUMENT, label: () => t(`ui.fileFormat.pdfDocument`) },
    docx: { ...PAGES, label: () => t(`ui.fileFormat.wordDocument`) },
    odt: PAGES,
    ott: PAGES,
    rtf: PAGES,
    epub: DOCUMENT,
    pptx: { ...DOCUMENT, label: () => t(`ui.fileFormat.powerPointDeck`) },
    odp: DOCUMENT,
    otp: DOCUMENT,
    odg: DOCUMENT,
    otg: { category: `generic`, binary: true },
    // JSON by every other rule, and unreadable as JSON, so its diff reads the text fileq renders from it.
    ipynb: { category: `doc`, reads: `document` },
    md: { category: `doc`, label: `Markdown`, reads: `markdown` },
    markdown: { category: `doc`, label: `Markdown`, reads: `markdown` },
    mdx: { category: `doc`, label: `Markdown`, reads: `markdown` },
    txt: { category: `doc`, label: () => t(`ui.fileFormat.plainText`), reads: `plain` },
    xlsx: { ...SHEET, label: () => t(`ui.fileFormat.excelSpreadsheet`) },
    ods: SHEET,
    ots: SHEET,
    csv: { category: `data`, reads: `table` },
    tsv: { category: `data`, reads: `table` },
    sql: { category: `data`, label: `SQL` },
    prisma: { category: `data`, label: () => t(`ui.fileFormat.prismaSchema`) },
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
    vue: { category: `code`, label: () => t(`ui.fileFormat.vueComponent`) },
    svelte: { category: `code`, label: () => t(`ui.fileFormat.svelteComponent`) },
    astro: { category: `code`, label: () => t(`ui.fileFormat.astroPage`) },
    html: { category: `code`, label: () => t(`ui.fileFormat.webPage`) },
    htm: { category: `code`, label: () => t(`ui.fileFormat.webPage`) },
    py: { category: `code`, label: `Python` },
    rs: { category: `code`, label: `Rust` },
    go: { category: `code`, label: `Go` },
    rb: { category: `code`, label: `Ruby` },
    java: { category: `code`, label: `Java` },
    kt: { category: `code`, label: `Kotlin` },
    swift: { category: `code`, label: `Swift` },
    c: { category: `code`, label: `C` },
    h: { category: `code`, label: () => t(`ui.fileFormat.cHeader`) },
    cpp: { category: `code`, label: `C++` },
    cs: { category: `code`, label: `C#` },
    php: { category: `code`, label: `PHP` },
    css: { category: `style`, label: () => t(`ui.fileFormat.styleSheet`) },
    scss: { category: `style`, label: () => t(`ui.fileFormat.styleSheet`) },
    sass: { category: `style`, label: () => t(`ui.fileFormat.styleSheet`) },
    less: { category: `style`, label: () => t(`ui.fileFormat.styleSheet`) },
    json: { category: `config`, label: `JSON` },
    jsonc: { category: `config`, label: `JSON` },
    yaml: { category: `config`, label: `YAML` },
    yml: { category: `config`, label: `YAML` },
    toml: { category: `config`, label: `TOML` },
    toon: { category: `data`, label: `TOON` },
    xml: { category: `config`, label: `XML` },
    ini: { category: `config` },
    cfg: { category: `config` },
    conf: { category: `config` },
    sh: { category: `shell`, label: () => t(`ui.fileFormat.shellScript`) },
    bash: { category: `shell`, label: () => t(`ui.fileFormat.shellScript`) },
    zsh: { category: `shell`, label: () => t(`ui.fileFormat.shellScript`) },
    ps1: { category: `shell`, label: () => t(`ui.fileFormat.powerShellScript`) },
    zip: archive(() => t(`ui.fileFormat.zipArchive`)),
    tar: archive(() => t(`ui.fileFormat.tarArchive`)),
    tgz: archive(() => t(`ui.fileFormat.tarArchive`)),
    gz: archive(() => t(`ui.fileFormat.gzipArchive`)),
    "7z": archive(() => t(`ui.fileFormat.sevenZipArchive`)),
    rar: archive(() => t(`ui.fileFormat.rarArchive`)),
    bz2: archive(),
    xz: archive(),
    zst: archive(),
    jar: archive(),
    war: archive(),
    whl: archive(),
    woff: { ...BYTES, label: () => t(`ui.fileFormat.webFont`) },
    woff2: { ...BYTES, label: () => t(`ui.fileFormat.webFont`) },
    ttf: { ...BYTES, label: () => t(`ui.fileFormat.trueTypeFont`) },
    otf: { ...BYTES, label: () => t(`ui.fileFormat.openTypeFont`) },
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
    lock: { category: `lock`, label: () => t(`ui.fileFormat.lockfile`) },
    lockb: { category: `lock`, binary: true },
};

// Whole names (lowercased) the extension map cannot reach: extensionless, or a dotfile.
const BY_NAME: Readonly<Record<string, Entry>> = {
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

const UNKNOWN: Entry = { category: `generic` };

// The lowercased extension of a path's last segment; "" when it has none, a dotfile included.
export const extensionOf = (path: string): string => {
    const name = path.slice(path.lastIndexOf(`/`) + 1).toLowerCase();
    const dot = name.lastIndexOf(`.`);
    return dot > 0 ? name.slice(dot + 1) : ``;
};

export const formatOf = (path: string): FileFormat => {
    const entry = BY_EXT[extensionOf(path)] ?? BY_NAME[path.slice(path.lastIndexOf(`/`) + 1).toLowerCase()] ?? UNKNOWN;
    const { label } = entry;
    return typeof label === `function` ? { ...entry, label: label() } : (entry as FileFormat);
};
