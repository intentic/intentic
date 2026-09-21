import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { categoryForEntry, type FileCategory } from "@intentic/ui/file-icon";
import { t } from "@intentic/ui/i18n";

// How the home lays a folder out: folders first, then files in KIND groups, each in natural name order. A kind, not an
// extension: extension groups shatter a source folder into json/ts/tsx/vue/css islands, while a kind is what the icon's
// colour already says, so the grouping reads without a legend. Pure, no framework code.

export type HomeGroupKey = "folders" | "documents" | "pictures" | "media" | "code" | "styles" | "data" | "config" | "archives" | "other";

export interface HomeGroup {
    readonly key: HomeGroupKey;
    readonly label: string;
    readonly entries: readonly WorkspaceTreeEntry[];
}

// Reading order: what a person opens first, down to what a tool put here.
const groupOrder = (): readonly { readonly key: HomeGroupKey; readonly label: string }[] => [
    { key: `folders`, label: t(`workspace.homeOrder.folders`) },
    { key: `documents`, label: t(`workspace.homeOrder.documents`) },
    { key: `pictures`, label: t(`workspace.homeOrder.pictures`) },
    { key: `media`, label: t(`workspace.homeOrder.media`) },
    { key: `code`, label: t(`workspace.homeOrder.code`) },
    { key: `styles`, label: t(`workspace.homeOrder.styles`) },
    { key: `data`, label: t(`workspace.homeOrder.data`) },
    { key: `config`, label: t(`workspace.homeOrder.config`) },
    { key: `archives`, label: t(`workspace.homeOrder.archives`) },
    { key: `other`, label: t(`workspace.homeOrder.other`) },
];

// Video is `generic` to fileIcon.ts; the home seats it with sound, since both are watched rather than read.
const VIDEO_EXTS: ReadonlySet<string> = new Set([`mp4`, `m4v`, `webm`, `ogv`, `mov`, `mkv`, `avi`, `wmv`, `3gp`]);

const BY_CATEGORY: Record<FileCategory, HomeGroupKey> = {
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

export const groupOf = (entry: WorkspaceTreeEntry): HomeGroupKey => {
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
export const homeGroups = (entries: readonly WorkspaceTreeEntry[]): readonly HomeGroup[] => {
    const buckets = new Map<HomeGroupKey, WorkspaceTreeEntry[]>();
    for (const entry of entries) {
        const key = groupOf(entry);
        const bucket = buckets.get(key);
        if (bucket === undefined) {
            buckets.set(key, [entry]);
        } else {
            bucket.push(entry);
        }
    }
    return groupOrder().flatMap(({ key, label }) => {
        const bucket = buckets.get(key);
        return bucket === undefined ? [] : [{ key, label, entries: bucket.toSorted(byNaturalName) }];
    });
};

// A label earns its row only where there is something to tell apart: a folder of one kind shows none.
export const labelsShown = (groups: readonly HomeGroup[]): boolean => groups.length >= 2;

// Every entry in home order, for keyboard travel and selection across group boundaries.
export const homeOrder = (groups: readonly HomeGroup[]): readonly WorkspaceTreeEntry[] => groups.flatMap((group) => group.entries);
