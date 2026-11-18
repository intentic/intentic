// Which glyph and colour a tree row draws. A file's category, not its extension directly, drives both; a few
// extensions/names override the glyph where the category default loses signal.
import type { IconName } from "./iconSets.js";
import { extensionOf, type FileCategory, formatOf } from "../lib/fileFormat.js";

// The default glyph per category.
const CATEGORY_ICON: Record<FileCategory, IconName> = {
    code: "code",
    style: "palette",
    config: "cog",
    data: "database",
    image: "image",
    audio: "waveform",
    video: "file",
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
    audio: "text-file-audio",
    video: "text-muted",
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

// The icon for a tree entry. Directories get an open/closed folder; files map by exact name, then by a
// glyph override, then by their category's default glyph.
export const iconForEntry = (name: string, type: "file" | "dir", expanded = false): IconName => {
    if (type === `dir`) {
        return expanded ? `folder-open` : `folder`;
    }
    const lower = name.toLowerCase();
    return ICON_BY_NAME[lower] ?? ICON_BY_EXT[extensionOf(lower)] ?? CATEGORY_ICON[formatOf(name).category];
};

export interface ExplorerTreatment {
    icon: IconName;
    sizeClass: string;
    slotClass: string;
    colorClass: string;
}

// `slotClass` is a fixed-width box, so filenames stay aligned despite differing glyph widths.
const SIZE_CLASS = `text-xs`;
const SLOT_CLASS = `w-4`;

// Colour class for a tree entry: a hue per file category, accent-tinted folders. `ignored` entries dim. Shared by the
// tree and the open-file tabs.
export const explorerColorClass = (name: string, type: "file" | "dir", ignored: boolean | undefined): string => {
    if (ignored) {
        return `text-subtle`;
    }
    return type === `dir` ? `text-file-folder` : CATEGORY_COLOR[formatOf(name).category];
};

// How to draw one tree row's icon.
export const explorerTreatment = (name: string, type: "file" | "dir", expanded: boolean, ignored: boolean | undefined): ExplorerTreatment => ({
    icon: iconForEntry(name, type, expanded),
    sizeClass: SIZE_CLASS,
    slotClass: SLOT_CLASS,
    colorClass: explorerColorClass(name, type, ignored),
});
