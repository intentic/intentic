import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, type CapabilityGuide } from "@intentic/capability-catalog";
import { t } from "@intentic/ui/i18n";

// The built-in catalog's words in the reader's language. @intentic/capability-catalog keeps them in English, since the
// daemon and the agents read the same data; the web's catalogs carry a copy under `capabilities.catalog.<id>` and
// `capabilities.categories.<id>`, which catalogCopy.test.ts holds equal to the package. Anything without a key (a tile
// an extension contributes, an id the package gains later) keeps the package's or the manifest's own English.

// An id vue-i18n reads as one path segment. A dot, a bracket or a space would make it a different path, so an id
// outside this shape has no key, whatever the catalogs hold.
const KEYABLE = /^[\w-]+$/;

const BUILT_IN: ReadonlyMap<string, CapabilityCatalogEntry> = new Map(CAPABILITY_CATALOG.map((entry) => [entry.id, entry]));

// vue-i18n answers a key no catalog holds with the key itself. Only a tile still saying what the package says for
// that part is looked up: a contributed tile reusing a built-in id speaks its manifest's words, not the built-in's.
const entryWords = (entry: CapabilityCatalogEntry, part: string, english: string, own: string | undefined): string => {
    if (own !== english || !KEYABLE.test(entry.id)) {
        return english;
    }
    const words = t(`capabilities.catalog.${entry.id}.${part}`);
    return words === `capabilities.catalog.${entry.id}.${part}` ? english : words;
};

/** The tile's name as the reader's language says it; a proper name ("Docker", "SSH") has no key and stays. */
export const entryName = (entry: CapabilityCatalogEntry): string => entryWords(entry, `name`, entry.name, BUILT_IN.get(entry.id)?.name);

/** The tile's one line under its name. */
export const entryDescription = (entry: CapabilityCatalogEntry): string =>
    entryWords(entry, `description`, entry.description, BUILT_IN.get(entry.id)?.description);

/** The paragraph beside the add-form. */
export const entryHint = (entry: CapabilityCatalogEntry): string | undefined =>
    entry.hint === undefined ? undefined : entryWords(entry, `hint`, entry.hint, BUILT_IN.get(entry.id)?.hint);

/** The credential guide with its prose translated; the link it builds is the package's, untouched. */
export const entryGuide = (entry: CapabilityCatalogEntry): CapabilityGuide | undefined => {
    const guide = entry.guide;
    if (guide === undefined) {
        return undefined;
    }
    const own = BUILT_IN.get(entry.id)?.guide;
    return {
        ...guide,
        linkLabel: guide.linkLabel === undefined ? undefined : entryWords(entry, `guide.linkLabel`, guide.linkLabel, own?.linkLabel),
        scopes: guide.scopes === undefined ? undefined : entryWords(entry, `guide.scopes`, guide.scopes, own?.scopes),
        steps: guide.steps?.map((step, index) => entryWords(entry, `guide.steps.${index}`, step, own?.steps?.[index])),
    };
};

/** One of the rail's categories, as CAPABILITY_CATEGORIES spells it; an id with no key keeps these words. */
export interface CategoryCopy {
    readonly id: string;
    readonly label: string;
    readonly hint: string;
}

const categoryWords = (id: string, part: `label` | `hint`, english: string): string => {
    if (!KEYABLE.test(id)) {
        return english;
    }
    const words = t(`capabilities.categories.${id}.${part}`);
    return words === `capabilities.categories.${id}.${part}` ? english : words;
};

/** The category's heading in the rail and above its tiles. */
export const categoryLabel = (category: CategoryCopy): string => categoryWords(category.id, `label`, category.label);

/** The category's sentence, the page description while the rail points at it. */
export const categoryHint = (category: CategoryCopy): string => categoryWords(category.id, `hint`, category.hint);
