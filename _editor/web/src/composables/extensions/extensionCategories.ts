import type { ExtensionEntry } from "./useExtensionList";

/* WHAT AN EXTENSION IS FOR — the Extensions tab's sections.
 *
 * The one fact about an extension that its manifest's `contributes` cannot supply. Grouping by contribution was
 * the obvious move and it does not work: nine of the first-party extensions contribute a rail tile, so the
 * derived grouping puts more than half the list under one heading that says nothing about any row in it. What
 * the reader is actually looking for — "where's the thing that watches CI?", "what can the agent reach outside
 * this box?" — is a purpose, so purpose is declared (manifest.category) and this file is the vocabulary.
 *
 * ORDER IS FIXED AND EDITORIAL, not alphabetical and not by size: the sections a reader opens this tab for come
 * first. Alphabetical would lead with "Connections" every time, and by-size would reshuffle the whole tab the
 * moment an extension is installed — a list whose headings move is a list that has to be re-read.
 *
 * The vocabulary lives HERE rather than in the manifest schema, mirroring a connector's `catalog.category`
 * against CAPABILITY_CATEGORIES: an extension is installed by pinning a commit, and a third-party one written
 * against a section this build has never heard of must still install, still render and still be switchable.
 * It lands in `Other`. */

export interface ExtensionSection {
    readonly id: string;
    readonly label: string;
    /** Only where the heading alone would leave the reader guessing what put a row there. */
    readonly caption?: string;
    readonly entries: readonly ExtensionEntry[];
}

const CATEGORIES: readonly { readonly id: string; readonly label: string; readonly caption?: string }[] = [
    { id: `work`, label: `Work & delivery` },
    { id: `workspace`, label: `Workspace` },
    { id: `connections`, label: `Connections` },
    { id: `knowledge`, label: `Knowledge` },
    { id: `sandbox`, label: `The sandbox` },
];

// Declared nothing, or something this build doesn't know. A real section rather than a silent drop: an
// extension the tab doesn't render is an extension its owner cannot switch off.
const OTHER = { id: `other`, label: `Other`, caption: `no section declared, or one this build doesn't know` };

/** The tab's sections in render order, each holding its rows — empty ones omitted, so a filter that empties a
 *  section removes the heading with it rather than leaving a label over nothing. */
export const sectionsOf = (entries: readonly ExtensionEntry[]): ExtensionSection[] => {
    const known = new Set(CATEGORIES.map((category) => category.id));
    const buckets = new Map<string, ExtensionEntry[]>();
    for (const entry of entries) {
        const declared = entry.extension.manifest.category;
        const id = declared !== undefined && known.has(declared) ? declared : OTHER.id;
        const bucket = buckets.get(id);
        if (bucket === undefined) {
            buckets.set(id, [entry]);
            continue;
        }
        bucket.push(entry);
    }
    // A bucket exists only where a row landed in it, so "has a bucket" IS "is non-empty".
    const sections: ExtensionSection[] = [];
    for (const category of [...CATEGORIES, OTHER]) {
        const held = buckets.get(category.id);
        if (held !== undefined) {
            sections.push({ id: category.id, label: category.label, caption: category.caption, entries: held });
        }
    }
    return sections;
};
