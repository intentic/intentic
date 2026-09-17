import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { categoryForEntry, type FileCategory } from "@intentic/ui/file-icon";

// How the desk lays a folder out: folders first, then files in KIND groups, each in natural name order. A kind, not an
// extension: extension groups shatter a source folder into json/ts/tsx/vue/css islands, while a kind is what the icon's
// colour already says, so the grouping reads without a legend. Pure, no framework code.

export type DeskGroupKey = "folders" | "documents" | "pictures" | "media" | "code" | "styles" | "data" | "config" | "archives" | "other";

export interface DeskGroup {
    readonly key: DeskGroupKey;
    readonly label: string;
    readonly entries: readonly WorkspaceTreeEntry[];
}

// Reading order: what a person opens first, down to what a tool put here.
const GROUP_ORDER: readonly { readonly key: DeskGroupKey; readonly label: string }[] = [
    { key: `folders`, label: `Folders` },
    { key: `documents`, label: `Documents` },
    { key: `pictures`, label: `Pictures` },
    { key: `media`, label: `Media` },
    { key: `code`, label: `Code` },
    { key: `styles`, label: `Styles` },
    { key: `data`, label: `Data` },
    { key: `config`, label: `Config` },
    { key: `archives`, label: `Archives` },
    { key: `other`, label: `Other` },
];

// Video is `generic` to fileIcon.ts; the desk seats it with sound, since both are watched rather than read.
const VIDEO_EXTS: ReadonlySet<string> = new Set([`mp4`, `m4v`, `webm`, `ogv`, `mov`, `mkv`, `avi`, `wmv`, `3gp`]);

const BY_CATEGORY: Record<FileCategory, DeskGroupKey> = {
    doc: `documents`,
    image: `pictures`,
    audio: `media`,
    code: `code`,
    shell: `code`,
    style: `styles`,
    data: `data`,
    config: `config`,
    lock: `config`,
    archive: `archives`,
    binary: `other`,
    generic: `other`,
};

export const extOf = (name: string): string => {
    const dot = name.lastIndexOf(`.`);
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : ``;
};

// A moving picture, by extension; what the browser can play is its own question, answered by the element.
export const isVideoName = (name: string): boolean => VIDEO_EXTS.has(extOf(name));

export const groupOf = (entry: WorkspaceTreeEntry): DeskGroupKey => {
    if (entry.type === `dir`) {
        return `folders`;
    }
    return isVideoName(entry.name) ? `media` : BY_CATEGORY[categoryForEntry(entry.name)];
};

// Numeric-aware and case-blind: img2 before img10, Readme beside readme. The code-point tie-break keeps two names the
// collator calls equal in one fixed order across renders.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: `base` });
export const byNaturalName = (left: WorkspaceTreeEntry, right: WorkspaceTreeEntry): number =>
    collator.compare(left.name, right.name) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

// Takes the level's entries as shown (already filtered); empty groups are left out rather than labelled.
export const deskGroups = (entries: readonly WorkspaceTreeEntry[]): readonly DeskGroup[] => {
    const buckets = new Map<DeskGroupKey, WorkspaceTreeEntry[]>();
    for (const entry of entries) {
        const key = groupOf(entry);
        const bucket = buckets.get(key);
        if (bucket === undefined) {
            buckets.set(key, [entry]);
        } else {
            bucket.push(entry);
        }
    }
    return GROUP_ORDER.flatMap(({ key, label }) => {
        const bucket = buckets.get(key);
        return bucket === undefined ? [] : [{ key, label, entries: bucket.toSorted(byNaturalName) }];
    });
};

// A label earns its row only where there is something to tell apart: a folder of one kind shows none.
export const labelsShown = (groups: readonly DeskGroup[]): boolean => groups.length >= 2;

// Every entry in desk order, for keyboard travel and selection across group boundaries.
export const deskOrder = (groups: readonly DeskGroup[]): readonly WorkspaceTreeEntry[] => groups.flatMap((group) => group.entries);
