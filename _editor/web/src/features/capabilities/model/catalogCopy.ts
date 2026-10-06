import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, type CapabilityGuide, coreFields, localModelGb } from "@intentic/capability-catalog";
import { type CapabilityKind, type ExitPoint, LOCAL_MODELS, TOR_EXIT_COUNTRIES, VPNGATE_EXIT_COUNTRIES } from "@intentic/sandbox-contract";
import { activeLocale, BASE_LOCALE, t } from "@intentic/ui/i18n";

// The built-in catalog's words in the reader's language. @intentic/capability-catalog keeps them in English, since the
// daemon and the agents read the same data; the web's catalogs carry a copy under `capabilities.catalog.<id>` and
// `capabilities.categories.<id>`, which catalogCopy.test.ts holds equal to the package. Anything without a key (a tile
// an extension contributes, an id the package gains later) keeps the package's or the manifest's own English.

// An id vue-i18n reads as one path segment. A dot, a bracket or a space would make it a different path, so an id
// outside this shape has no key, whatever the catalogs hold.
const KEYABLE = /^[\w-]+$/;

const BUILT_IN: ReadonlyMap<string, CapabilityCatalogEntry> = new Map(CAPABILITY_CATALOG.map((entry) => [entry.id, entry]));

// One family of keys: the full key a part sits under, and the ask for it. The ask is spelled out at each family with
// its literal prefix, which is what lets _tools/checks/i18n-keys.mjs vouch for the messages under it.
interface Copy {
    readonly key: (part: string) => string;
    readonly ask: (part: string) => string;
}

// vue-i18n answers a key no catalog holds with the key itself. Only words still saying what the package says for that
// part are looked up: a contributed tile reusing a built-in id speaks its manifest's words, not the built-in's.
const copyOf = (copy: Copy, part: string, english: string, own: string | undefined): string => {
    if (own !== english) {
        return english;
    }
    const words = copy.ask(part);
    return words === copy.key(part) ? english : words;
};

const tileCopy = (id: string): Copy => ({
    key: (part) => `capabilities.catalog.${id}.${part}`,
    ask: (part) => t(`capabilities.catalog.${id}.${part}`),
});

const entryWords = (entry: CapabilityCatalogEntry, part: string, english: string, own: string | undefined): string =>
    KEYABLE.test(entry.id) ? copyOf(tileCopy(entry.id), part, english, own) : english;

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

// --- The add-form's fields ------------------------------------------------------------------------------------------
//
// A field's words sit under `capabilities.catalog.<id>.fields.<slot>`: `label`, `hint`, `placeholder` (only where it
// is prose, not an example value) and `options.<option slot>`. The fields the core adds to every device, phone and
// browser tile (coreFields) sit under `capabilities.coreFields.<kind>.<key>` the same way. Only `label`, `hint`,
// `placeholder` and option labels change; `key`, `value`, `when` and the rest are what the form submits and gates on.

type Field = CapabilityCatalogEntry[`fields`][number];
type FieldOption = NonNullable<Field[`options`]>[number];

// The one shape of `when` an arm names: `provider == 'fortinet'`.
const ARM = /^\s*\w+\s*==\s*'([\w-]+)'\s*$/;

/**
 * Where a field's words sit under its tile: its key, or, for a key the tile declares more than once (one per arm of a
 * discriminator: SSH's two `privateKey` fields, the geo exit's three `country` ones), the key and the arm its `when`
 * names, `country-tor`; failing that, the key and which of them it is, `country-2`. Undefined for a key vue-i18n would
 * read as more than one path segment.
 */
export const fieldSlot = (fields: readonly Field[], index: number): string | undefined => {
    const field = fields[index];
    if (field === undefined || !KEYABLE.test(field.key)) {
        return undefined;
    }
    const namesakes = fields.filter((candidate) => candidate.key === field.key);
    if (namesakes.length === 1) {
        return field.key;
    }
    const arm = ARM.exec(field.when ?? ``)?.[1];
    const armed = arm !== undefined && namesakes.filter((candidate) => ARM.exec(candidate.when ?? ``)?.[1] === arm).length === 1;
    return armed ? `${field.key}-${arm}` : `${field.key}-${namesakes.indexOf(field) + 1}`;
};

/**
 * Where an option's label sits under its field. A value is free text (`eip155:8453`, `3.1.1`, the empty "anywhere"),
 * so every character vue-i18n would read as path syntax becomes `_`, and the empty value is `_`.
 */
export const optionSlot = (value: string): string => (value === `` ? `_` : value.replaceAll(/[^\w-]/g, `_`));

const slotted = (fields: readonly Field[]): ReadonlyMap<string, Field> =>
    new Map(
        fields.flatMap((field, index): [string, Field][] => {
            const slot = fieldSlot(fields, index);
            return slot === undefined ? [] : [[slot, field]];
        }),
    );

const BUILT_IN_FIELDS: ReadonlyMap<string, ReadonlyMap<string, Field>> = new Map(
    CAPABILITY_CATALOG.map((entry) => [entry.id, slotted(entry.fields)]),
);

const CORE_KINDS: readonly CapabilityKind[] = [`device`, `phone`, `browser`];
const CORE_FIELDS: ReadonlyMap<string, ReadonlyMap<string, Field>> = new Map(
    CORE_KINDS.map((kind) => [kind, new Map(coreFields(kind).map((field) => [field.key, field]))]),
);

// Two kinds of option the package builds from the contract's data, so their labels carry a figure: a geo exit's
// country with its share of capacity, a local model with the size of its weights. Their words are a template, filled
// from the same data; `english` is the package's label, matched before anything is said in its place.
const EXIT_POINTS: readonly ExitPoint[] = [...TOR_EXIT_COUNTRIES, ...VPNGATE_EXIT_COUNTRIES];

const shareOf = (point: ExitPoint): string | undefined =>
    point.share === undefined ? undefined : point.share >= 0.01 ? String(Math.round(point.share * 100)) : `<1`;

// The contract's English names are the ones the daemon and the agents print, so English keeps them; any other language
// names the country itself.
const regionNames = new Map<string, Intl.DisplayNames>();
const countryName = (point: ExitPoint): string => {
    const locale = activeLocale.value;
    if (locale === BASE_LOCALE) {
        return point.countryName;
    }
    let names = regionNames.get(locale);
    if (names === undefined) {
        names = new Intl.DisplayNames([locale], { type: `region` });
        regionNames.set(locale, names);
    }
    return names.of(point.country) ?? point.countryName;
};

const exitCountryWords = (value: string, english: string): string | undefined => {
    const point = EXIT_POINTS.find((candidate) => {
        const share = shareOf(candidate);
        return (
            candidate.country === value &&
            english === (share === undefined ? candidate.countryName : `${candidate.countryName} — ${share}% of capacity`)
        );
    });
    if (point === undefined) {
        return undefined;
    }
    const share = shareOf(point);
    return share === undefined ? countryName(point) : t(`capabilities.catalogOptions.exitCountry`, { country: countryName(point), share });
};

const localModelWords = (value: string, english: string): string | undefined => {
    const choice = LOCAL_MODELS.find((candidate) => candidate.id === value);
    if (choice === undefined) {
        return undefined;
    }
    const size = localModelGb(choice.weightsBytes);
    const instant = choice.tier === `instant`;
    if (english !== `${choice.label}, weights ${size}${instant ? ` · downloads in a minute, quick jobs only` : ``}`) {
        return undefined;
    }
    return instant
        ? t(`capabilities.catalogOptions.localModelInstant`, { model: choice.label, size })
        : t(`capabilities.catalogOptions.localModel`, { model: choice.label, size });
};

const DERIVED_OPTIONS: Readonly<Record<string, (value: string, english: string) => string | undefined>> = {
    "exit.country": exitCountryWords,
    "localmodel.model": localModelWords,
};

const optionWords = (copy: Copy, derived: string, option: FieldOption, own: Field): string => {
    const mine = own.options?.find((candidate) => candidate.value === option.value);
    if (mine === undefined || mine.label !== option.label) {
        return option.label;
    }
    const keyed = copyOf(copy, `options.${optionSlot(option.value)}`, option.label, mine.label);
    return keyed !== option.label ? keyed : (DERIVED_OPTIONS[derived]?.(option.value, option.label) ?? option.label);
};

const fieldWords = (copy: Copy, derived: string, field: Field, own: Field): Field => ({
    ...field,
    label: copyOf(copy, `label`, field.label, own.label),
    ...(field.hint === undefined ? {} : { hint: copyOf(copy, `hint`, field.hint, own.hint) }),
    ...(field.placeholder === undefined ? {} : { placeholder: copyOf(copy, `placeholder`, field.placeholder, own.placeholder) }),
    ...(field.options === undefined
        ? {}
        : { options: field.options.map((option) => ({ ...option, label: optionWords(copy, derived, option, own) })) }),
});

const coreCopy = (kind: string, key: string): Copy => ({
    key: (part) => `capabilities.coreFields.${kind}.${key}.${part}`,
    ask: (part) => t(`capabilities.coreFields.${kind}.${key}.${part}`),
});

/**
 * The tile's add-form fields with their words in the reader's language: its own fields if it is a built-in tile, and
 * the core's device, phone and browser fields on any tile that carries them. Anything else keeps its English.
 */
export const entryFields = (entry: CapabilityCatalogEntry): readonly Field[] => {
    const own = KEYABLE.test(entry.id) ? BUILT_IN_FIELDS.get(entry.id) : undefined;
    const core = CORE_FIELDS.get(entry.kind);
    return entry.fields.map((field, index) => {
        const slot = fieldSlot(entry.fields, index);
        if (slot === undefined) {
            return field;
        }
        const mine = own?.get(slot);
        if (mine !== undefined) {
            return fieldWords(tileCopy(`${entry.id}.fields.${slot}`), `${entry.id}.${field.key}`, field, mine);
        }
        const coreField = core?.get(field.key);
        return coreField === undefined ? field : fieldWords(coreCopy(entry.kind, field.key), ``, field, coreField);
    });
};

/** The tile with its add-form's words in the reader's language, for every surface that renders the form. */
export const withFieldWords = (entry: CapabilityCatalogEntry): CapabilityCatalogEntry => ({ ...entry, fields: entryFields(entry) });

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
