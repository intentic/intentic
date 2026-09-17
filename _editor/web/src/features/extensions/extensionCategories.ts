import type { ExtensionEntry } from "./useExtensionList";
import { t } from "@intentic/ui/i18n";

// Extensions tab's sections, grouped by declared purpose (manifest.category) rather than by contribution kind, which
// clusters most extensions under one heading. Order is fixed and editorial, not alphabetical or by size. An unknown or
// undeclared category lands in `Other`.

export interface ExtensionSection {
    readonly id: string;
    readonly label: string;
    /** Only where the heading alone would leave the reader guessing what put a row there. */
    readonly caption?: string;
    readonly entries: readonly ExtensionEntry[];
}

const categories = (): readonly { readonly id: string; readonly label: string; readonly caption?: string }[] => [
    { id: `work`, label: t(`extensions.extensionCategories.workDelivery`) },
    { id: `workspace`, label: t(`extensions.extensionCategories.workspace`) },
    { id: `connections`, label: t(`extensions.extensionCategories.connections`) },
    { id: `knowledge`, label: t(`extensions.extensionCategories.knowledge`) },
    { id: `sandbox`, label: t(`extensions.extensionCategories.sandbox`) },
];

// Declared nothing, or a category this build doesn't know; a real section, not a silent drop.
const other = (): { readonly id: string; readonly label: string; readonly caption?: string } => ({
    id: `other`,
    label: t(`extensions.extensionCategories.other`),
});

/** Tab's sections in render order, holding their rows; empty sections are omitted so a filter doesn't leave a bare heading. */
export const sectionsOf = (entries: readonly ExtensionEntry[]): ExtensionSection[] => {
    const known = new Set(categories().map((category) => category.id));
    const buckets = new Map<string, ExtensionEntry[]>();
    for (const entry of entries) {
        const declared = entry.extension.manifest.category;
        const id = declared !== undefined && known.has(declared) ? declared : other().id;
        const bucket = buckets.get(id);
        if (bucket === undefined) {
            buckets.set(id, [entry]);
            continue;
        }
        bucket.push(entry);
    }
    // A bucket exists only if a row landed in it: presence means non-empty.
    const sections: ExtensionSection[] = [];
    for (const category of [...categories(), other()]) {
        const held = buckets.get(category.id);
        if (held !== undefined) {
            sections.push({ id: category.id, label: category.label, caption: category.caption, entries: held });
        }
    }
    return sections;
};
