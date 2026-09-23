import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { type FileCategory, formatOf } from "@intentic/ui/file-format";
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
    { key: `folders`, label: t(`shared.folders`) },
    { key: `documents`, label: t(`workspace.homeOrder.documents`) },
    { key: `pictures`, label: t(`workspace.homeOrder.pictures`) },
    { key: `media`, label: t(`workspace.homeOrder.media`) },
    { key: `code`, label: t(`shared.code`) },
    { key: `styles`, label: t(`workspace.homeOrder.styles`) },
    { key: `data`, label: t(`workspace.homeOrder.data`) },
    { key: `config`, label: t(`workspace.homeOrder.config`) },
    { key: `archives`, label: t(`workspace.homeOrder.archives`) },
    { key: `other`, label: t(`shared.other`) },
];

const BY_CATEGORY: Record<FileCategory, HomeGroupKey> = {
    doc: `documents`,
    image: `pictures`,
    audio: `media`,
    // Seated with sound: both are watched rather than read.
    video: `media`,
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

export const groupOf = (entry: WorkspaceTreeEntry): HomeGroupKey => (entry.type === `dir` ? `folders` : BY_CATEGORY[formatOf(entry.name).category]);

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
