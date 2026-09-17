import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import type { ShikiLang } from "@intentic/code-read/langs";
import { categoryForEntry, type FileCategory } from "@intentic/ui/file-icon";
import { resolveFile } from "../explorer/fileType";
import { extOf } from "./deskOrder";

// What a hover can show of an entry, and what to call it. Text gets its first lines, a picture gets painted, a folder
// lists what it holds; anything else (a PDF, an archive, a font) has no cheap look and gets its name and size only.
// Pure, no framework code.

export type PeekKind = "folder" | "text" | "picture" | "none";

export interface PeekPlan {
    readonly kind: PeekKind;
    // Shiki grammar for the text kind; undefined renders plain.
    readonly lang?: ShikiLang;
}

// Pictures a browser paints on its own; the rest of the `image` category (psd, tiff, heic) has no viewer here either.
const PICTURE_EXTS: ReadonlySet<string> = new Set([`png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `ico`, `svg`]);

export const peekPlan = (entry: WorkspaceTreeEntry): PeekPlan => {
    if (entry.type === `dir`) {
        return { kind: `folder` };
    }
    // Nothing to read or paint; the card's size line says "0 B" on its own.
    if (entry.size === 0) {
        return { kind: `none` };
    }
    if (PICTURE_EXTS.has(extOf(entry.name))) {
        return { kind: `picture` };
    }
    const resolved = resolveFile(entry.path, entry.size);
    if (resolved.mode === `binary` || resolved.mode === `empty`) {
        return { kind: `none` };
    }
    return resolved.lang === undefined ? { kind: `text` } : { kind: `text`, lang: resolved.lang };
};

// Names people use, for the extensions they meet most; the category word covers the rest.
const BY_EXT: Readonly<Record<string, string>> = {
    ts: `TypeScript`,
    tsx: `TypeScript`,
    mts: `TypeScript`,
    cts: `TypeScript`,
    js: `JavaScript`,
    mjs: `JavaScript`,
    cjs: `JavaScript`,
    jsx: `JavaScript`,
    vue: `Vue component`,
    svelte: `Svelte component`,
    astro: `Astro page`,
    html: `Web page`,
    htm: `Web page`,
    css: `Style sheet`,
    scss: `Style sheet`,
    sass: `Style sheet`,
    less: `Style sheet`,
    md: `Markdown`,
    markdown: `Markdown`,
    mdx: `Markdown`,
    txt: `Plain text`,
    pdf: `PDF document`,
    json: `JSON`,
    jsonc: `JSON`,
    yaml: `YAML`,
    yml: `YAML`,
    toml: `TOML`,
    xml: `XML`,
    sql: `SQL`,
    prisma: `Prisma schema`,
    graphql: `GraphQL`,
    gql: `GraphQL`,
    py: `Python`,
    rs: `Rust`,
    go: `Go`,
    rb: `Ruby`,
    java: `Java`,
    kt: `Kotlin`,
    swift: `Swift`,
    c: `C`,
    h: `C header`,
    cpp: `C++`,
    cs: `C#`,
    php: `PHP`,
    sh: `Shell script`,
    bash: `Shell script`,
    zsh: `Shell script`,
    ps1: `PowerShell script`,
    png: `PNG picture`,
    jpg: `JPEG picture`,
    jpeg: `JPEG picture`,
    gif: `GIF picture`,
    webp: `WebP picture`,
    avif: `AVIF picture`,
    svg: `SVG drawing`,
    ico: `Icon`,
    mp3: `MP3 audio`,
    wav: `WAV audio`,
    flac: `FLAC audio`,
    ogg: `Ogg audio`,
    m4a: `AAC audio`,
    mp4: `MP4 video`,
    webm: `WebM video`,
    mov: `QuickTime video`,
    mkv: `Matroska video`,
    zip: `ZIP archive`,
    tar: `Tar archive`,
    gz: `Gzip archive`,
    tgz: `Tar archive`,
    "7z": `7-Zip archive`,
    rar: `RAR archive`,
    woff: `Web font`,
    woff2: `Web font`,
    ttf: `TrueType font`,
    otf: `OpenType font`,
    docx: `Word document`,
    xlsx: `Excel spreadsheet`,
    pptx: `PowerPoint deck`,
    lock: `Lockfile`,
};

const BY_CATEGORY: Record<FileCategory, string> = {
    code: `Code`,
    style: `Style sheet`,
    config: `Config`,
    data: `Data`,
    image: `Picture`,
    audio: `Sound`,
    doc: `Document`,
    shell: `Script`,
    archive: `Archive`,
    lock: `Lockfile`,
    binary: `File`,
    generic: `File`,
};

export const kindLabel = (entry: Pick<WorkspaceTreeEntry, "name" | "type">): string => {
    if (entry.type === `dir`) {
        return `Folder`;
    }
    return BY_EXT[extOf(entry.name)] ?? BY_CATEGORY[categoryForEntry(entry.name)];
};

// Lines the card shows: enough to recognise a file, few enough to stay a glance.
export const PEEK_LINES = 14;
// Bytes asked for: PEEK_LINES of long lines, and a cheap round trip whatever the file's size.
export const PEEK_BYTES = 2048;

// The card's text: the first PEEK_LINES lines, a cut line dropped rather than shown torn. `bytes` is how much of the
// file `content` decodes from; a window shorter than the file may end mid-line.
export const peekLines = (content: string, bytes: number, size: number): string => {
    const lines = content.split(`\n`);
    const whole = bytes >= size;
    const kept = whole ? lines : lines.slice(0, -1);
    return kept.slice(0, PEEK_LINES).join(`\n`);
};
