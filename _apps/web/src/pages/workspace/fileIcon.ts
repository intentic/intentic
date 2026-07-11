// How a tree row is drawn: which glyph, and — for the colourful/vivid explorer setups — which hue.
// A file's CATEGORY is the source of truth: it drives the colour (text-file-* tokens) and the default
// glyph. A few extensions/names override the glyph where the category's default loses useful signal
// (a PDF still reads as a PDF). The tree colours uniformly in the "minimal" setup; category colour only
// applies in "colorful"/"vivid".
import type { ExplorerStyle, IconName } from "@intentic-app/ui";

export type FileCategory =
    | "code"
    | "style"
    | "config"
    | "data"
    | "image"
    | "doc"
    | "shell"
    | "archive"
    | "lock"
    | "binary"
    | "generic";

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

// The category hue (colourful/vivid). Quiet categories keep the muted role — no dedicated token.
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

// The category of a file entry — drives its colour, and its default glyph.
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

// Icon size steps up across the setups; the row font stays fixed. `slotClass` is a fixed-width centred
// box so glyphs of different intrinsic widths occupy the same column and filenames line up.
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

// How to draw one tree row's icon under the active explorer setup. `ignored` entries always dim (the
// tree's existing cue), regardless of setup.
export const explorerTreatment = (
    style: ExplorerStyle,
    name: string,
    type: "file" | "dir",
    expanded: boolean,
    ignored: boolean | undefined,
): ExplorerTreatment => {
    const icon = iconForEntry(name, type, expanded);
    const sizeClass = SIZE_CLASS[style];
    const slotClass = SLOT_CLASS[style];
    if (ignored) {
        return { icon, sizeClass, slotClass, colorClass: `text-subtle` };
    }
    if (style === `minimal`) {
        return { icon, sizeClass, slotClass, colorClass: type === `dir` ? `text-content/70` : `text-muted` };
    }
    const colorClass = type === `dir` ? `text-file-folder` : CATEGORY_COLOR[categoryForEntry(name)];
    return { icon, sizeClass, slotClass, colorClass };
};
