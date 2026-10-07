import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { type FileCategory, formatOf } from "@intentic/ui/file-format";
import { t } from "@intentic/ui/i18n";
import { type DateGroupKey, dateGroupOf } from "./homeDates";

// How the home lays a folder out: folders first, then files in KIND groups, each in natural name order. A kind, not an
// extension: extension groups shatter a source folder into json/ts/tsx/vue/css islands, while a kind is what the icon's
// colour already says, so the grouping reads without a legend. Pure, no framework code.
//
// Or by DATE (the home's Kind | Date switch, `HomeArrange`): folders first still, then files under when they last
// changed, newest first (homeDates.ts). That is how a folder like Downloads is read: the file just saved is at the top
// whatever its kind, which is what makes "open the folder, find the file in it" work for someone who would otherwise
// open the file alone. Folders keep their own group by name, since they are places to go rather than things that
// arrived, and a plain one is listed without the stat a date would cost.

export type HomeGroupKey = "folders" | "documents" | "pictures" | "media" | "code" | "styles" | "data" | "config" | "archives" | "other";

/** How the home groups a folder's files: by what they are, or by when they last changed. */
export type HomeArrange = `kind` | `date`;

export interface HomeGroup {
    readonly key: HomeGroupKey | DateGroupKey;
    readonly label: string;
    readonly entries: readonly WorkspaceTreeEntry[];
}

// Reading order: what a person opens first, down to what a tool put here.
const groupOrder = (): readonly { readonly key: HomeGroupKey; readonly label: string }[] => [
    { key: `folders`, label: t(`shared.folders`) },
    { key: `documents`, label: t(`workspace.homeOrder.documents`) },
    { key: `pictures`, label: t(`workspace.homeOrder.pictures`) },
    { key: `media`, label: t(`workspace.homeOrder.media`) },
    { key: `code`, label: t(`workspace.words.code`) },
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

// Newest first; a tie (two files from one save) falls back to natural name order, so the order holds across renders.
const byNewest = (left: WorkspaceTreeEntry, right: WorkspaceTreeEntry): number =>
    (right.mtime ?? Number.NEGATIVE_INFINITY) - (left.mtime ?? Number.NEGATIVE_INFINITY) || byNaturalName(left, right);

// Folders by name, then the files under their dates: each heading's files newest first, the headings newest first too,
// which is the order of their newest files since the buckets never overlap. Files with no time go last.
const dateGroups = (entries: readonly WorkspaceTreeEntry[], now: number): readonly HomeGroup[] => {
    const folders = entries.filter((entry) => entry.type === `dir`);
    const buckets = new Map<DateGroupKey, { label: string; entries: WorkspaceTreeEntry[] }>();
    for (const entry of entries) {
        if (entry.type === `dir`) {
            continue;
        }
        const { key, label } = dateGroupOf(entry.mtime, now);
        const bucket = buckets.get(key);
        if (bucket === undefined) {
            buckets.set(key, { label, entries: [entry] });
        } else {
            bucket.entries.push(entry);
        }
    }
    const dated = [...buckets]
        .map(([key, bucket]) => ({ key, label: bucket.label, entries: bucket.entries.toSorted(byNewest) }))
        .toSorted((left, right) => (right.entries[0]?.mtime ?? Number.NEGATIVE_INFINITY) - (left.entries[0]?.mtime ?? Number.NEGATIVE_INFINITY));
    return [
        ...(folders.length === 0 ? [] : [{ key: `folders` as const, label: t(`shared.folders`), entries: folders.toSorted(byNaturalName) }]),
        ...dated,
    ];
};

/**
 * Takes the level's entries as shown (already filtered); empty groups are left out rather than labelled.
 *
 * @param arrange By kind (the default) or by when each file last changed.
 * @param now The moment the date headings are measured from; only `date` reads it.
 */
export const homeGroups = (entries: readonly WorkspaceTreeEntry[], arrange: HomeArrange = `kind`, now = Date.now()): readonly HomeGroup[] => {
    if (arrange === `date`) {
        return dateGroups(entries, now);
    }
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

// A label earns its row only where there is something to tell apart: a folder of one kind shows none. A date heading
// always does, since "Today" says something even when everything in the folder is from today.
export const labelsShown = (groups: readonly HomeGroup[], arrange: HomeArrange = `kind`): boolean =>
    arrange === `date` ? groups.some((group) => group.key !== `folders`) : groups.length >= 2;

// Every entry in home order, for keyboard travel and selection across group boundaries.
export const homeOrder = (groups: readonly HomeGroup[]): readonly WorkspaceTreeEntry[] => groups.flatMap((group) => group.entries);
