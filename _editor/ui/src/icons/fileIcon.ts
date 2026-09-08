// Which glyph and colour a tree row draws. A file's category, not its extension directly, drives both; a few
// extensions/names override the glyph where the category default loses signal. Category colour only shows in the
// colorful/vivid explorer setups.
import type { ExplorerStyle } from "./explorerStyle.js";
import type { IconName } from "./iconSets.js";

export type FileCategory = "code" | "style" | "config" | "data" | "image" | "doc" | "shell" | "archive" | "lock" | "binary" | "generic";

const EXT_CATEGORY: Record<string, FileCategory> = {
    // images
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
    webp: "image",
    avif: "image",
    bmp: "image",
    ico: "image",
    svg: "image",
    // documents
    pdf: "doc",
    md: "doc",
    markdown: "doc",
    mdx: "doc",
    txt: "doc",
    // code
    ts: "code",
    tsx: "code",
    mts: "code",
    cts: "code",
    js: "code",
    jsx: "code",
    mjs: "code",
    cjs: "code",
    go: "code",
    rs: "code",
    java: "code",
    c: "code",
    h: "code",
    cpp: "code",
    cs: "code",
    py: "code",
    rb: "code",
    php: "code",
    kt: "code",
    swift: "code",
    vue: "code",
    svelte: "code",
    astro: "code",
    html: "code",
    htm: "code",
    // styles
    css: "style",
    scss: "style",
    sass: "style",
    less: "style",
    // data / config
    json: "config",
    jsonc: "config",
    yaml: "config",
    yml: "config",
    toml: "config",
    ini: "config",
    cfg: "config",
    conf: "config",
    xml: "config",
    // database / schema
    sql: "data",
    prisma: "data",
    graphql: "data",
    gql: "data",
    // shell
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ps1: "shell",
    // archives
    zip: "archive",
    gz: "archive",
    tgz: "archive",
    tar: "archive",
    rar: "archive",
    "7z": "archive",
    // fonts / binaries
    woff: "binary",
    woff2: "binary",
    ttf: "binary",
    otf: "binary",
    // locks
    lock: "lock",
    lockb: "lock",
};

// Exact filenames (extensionless or dotfiles) that fall through the extension map.
const BY_NAME_CATEGORY: Record<string, FileCategory> = {
    dockerfile: "config",
    makefile: "config",
    ".gitignore": "config",
    ".gitattributes": "config",
    ".dockerignore": "config",
    ".editorconfig": "config",
    ".npmrc": "config",
    ".env": "config",
    ".prettierignore": "config",
};

// The default glyph per category.
const CATEGORY_ICON: Record<FileCategory, IconName> = {
    code: "code",
    style: "palette",
    config: "cog",
    data: "database",
    image: "image",
    doc: "file-edit",
    shell: "server",
    archive: "box",
    lock: "lock",
    binary: "file",
    generic: "file",
};

// The category hue (colourful/vivid). Quiet categories keep the muted role, no dedicated token.
const CATEGORY_COLOR: Record<FileCategory, string> = {
    code: "text-file-code",
    style: "text-file-style",
    config: "text-file-config",
    data: "text-file-data",
    image: "text-file-image",
    doc: "text-file-doc",
    shell: "text-file-shell",
    archive: "text-file-archive",
    lock: "text-muted",
    binary: "text-muted",
    generic: "text-muted",
};

// Glyph overrides where the category's default icon drops signal worth keeping.
const ICON_BY_EXT: Partial<Record<string, IconName>> = {
    pdf: "file-pdf",
};
const ICON_BY_NAME: Partial<Record<string, IconName>> = {
    ".gitignore": "github",
    ".gitattributes": "github",
};

const extOf = (lower: string): string => {
    const dot = lower.lastIndexOf(`.`);
    return dot > 0 ? lower.slice(dot + 1) : ``;
};

// The category of a file entry, drives its colour, and its default glyph.
export const categoryForEntry = (name: string): FileCategory => {
    const lower = name.toLowerCase();
    return EXT_CATEGORY[extOf(lower)] ?? BY_NAME_CATEGORY[lower] ?? `generic`;
};

// The icon for a tree entry. Directories get an open/closed folder; files map by exact name, then by a
// glyph override, then by their category's default glyph.
export const iconForEntry = (name: string, type: "file" | "dir", expanded = false): IconName => {
    if (type === `dir`) {
        return expanded ? `folder-open` : `folder`;
    }
    const lower = name.toLowerCase();
    return ICON_BY_NAME[lower] ?? ICON_BY_EXT[extOf(lower)] ?? CATEGORY_ICON[categoryForEntry(name)];
};

export interface ExplorerTreatment {
    icon: IconName;
    sizeClass: string;
    slotClass: string;
    colorClass: string;
}

// Icon size steps up per setup; row font stays fixed. `slotClass` is a fixed-width box, so filenames stay aligned
// despite differing glyph widths.
const SIZE_CLASS: Record<ExplorerStyle, string> = {
    minimal: `text-2xs`,
    colorful: `text-xs`,
    vivid: `text-sm`,
};
const SLOT_CLASS: Record<ExplorerStyle, string> = {
    minimal: `w-3.5`,
    colorful: `w-4`,
    vivid: `w-5`,
};

// Colour class for an entry under the active explorer setup. `ignored` entries always dim regardless of setup.
// Shared by the tree and the open-file tabs.
export const explorerColorClass = (style: ExplorerStyle, name: string, type: "file" | "dir", ignored: boolean | undefined): string => {
    if (ignored) {
        return `text-subtle`;
    }
    if (style === `minimal`) {
        return type === `dir` ? `text-content/70` : `text-muted`;
    }
    return type === `dir` ? `text-file-folder` : CATEGORY_COLOR[categoryForEntry(name)];
};

// How to draw one tree row's icon under the active explorer setup.
export const explorerTreatment = (
    style: ExplorerStyle,
    name: string,
    type: "file" | "dir",
    expanded: boolean,
    ignored: boolean | undefined,
): ExplorerTreatment => ({
    icon: iconForEntry(name, type, expanded),
    sizeClass: SIZE_CLASS[style],
    slotClass: SLOT_CLASS[style],
    colorClass: explorerColorClass(style, name, type, ignored),
});
