import { CAPABILITY_CATALOG, CAPABILITY_CATEGORIES, type CapabilityCatalogEntry, coreFields } from "@intentic/capability-catalog";
import type { CapabilityKind } from "@intentic/sandbox-contract";
import { type MessageTree, setLocale, t } from "@intentic/ui/i18n";
import en from "../../../app/i18n/locales/en.json";
import pl from "../../../app/i18n/locales/pl.json";
import { categoryHint, categoryLabel, entryDescription, entryFields, entryGuide, entryHint, entryName, fieldSlot, optionSlot } from "./catalogCopy";
import { sliceDescription } from "./slices";
import { entryHaystack } from "./tiles";

// The built-in catalog's words live in @intentic/capability-catalog, in English, and en.json carries a copy the
// Polish is translated from. These hold the copy to the package, so a sentence changed there cannot go on being shown
// in its old translation, and hold the helpers to the copy, so a key they spell wrong cannot quietly fall back.

const leaves = (tree: MessageTree, prefix = ``): [string, string][] =>
    Object.entries(tree).flatMap<[string, string]>(([name, value]) =>
        typeof value === `string` ? [[`${prefix}${name}`, value]] : leaves(value, `${prefix}${name}.`),
    );

type Words = Pick<CapabilityCatalogEntry, `name` | `description` | `hint` | `guide` | `fields`>;
type Field = CapabilityCatalogEntry[`fields`][number];

// Every sentence of a set of fields under the key path its copy takes, `<slot>.label`, `<slot>.options.<value>`.
const fieldSentences = (prefix: string, fields: readonly Field[], slotOf: (index: number) => string | undefined): [string, string][] =>
    fields.flatMap((field, index): [string, string][] => {
        const slot = slotOf(index);
        if (slot === undefined || field.label === ``) {
            return [];
        }
        return [
            [`${prefix}${slot}.label`, field.label],
            ...(field.hint === undefined ? [] : [[`${prefix}${slot}.hint`, field.hint] satisfies [string, string]]),
            ...(field.placeholder === undefined ? [] : [[`${prefix}${slot}.placeholder`, field.placeholder] satisfies [string, string]]),
            ...(field.options ?? []).map((option): [string, string] => [`${prefix}${slot}.options.${optionSlot(option.value)}`, option.label]),
        ];
    });

// Every sentence of a tile under the key path its copy takes, `<id>.guide.steps.<index>`, `<id>.fields.<slot>.label`
// and so on.
const sentences = (id: string, words: Words): [string, string][] => [
    [`${id}.name`, words.name],
    [`${id}.description`, words.description],
    ...(words.hint === undefined ? [] : [[`${id}.hint`, words.hint] satisfies [string, string]]),
    ...(words.guide?.linkLabel === undefined ? [] : [[`${id}.guide.linkLabel`, words.guide.linkLabel] satisfies [string, string]]),
    ...(words.guide?.scopes === undefined ? [] : [[`${id}.guide.scopes`, words.guide.scopes] satisfies [string, string]]),
    ...(words.guide?.steps ?? []).map((step, index): [string, string] => [`${id}.guide.steps.${index}`, step]),
    ...fieldSentences(`${id}.fields.`, words.fields, (index) => fieldSlot(words.fields, index)),
];

const PACKAGE_ENTRIES = new Map(CAPABILITY_CATALOG.flatMap((entry) => sentences(entry.id, entry)));

// The fields the core adds to every device, phone and browser tile, under `<kind>.<key>`.
const CORE_KINDS: readonly CapabilityKind[] = [`device`, `phone`, `browser`];
const coreSentences = (kind: CapabilityKind, fields: readonly Field[]): [string, string][] =>
    fieldSentences(`${kind}.`, fields, (index) => fields[index]?.key);
const PACKAGE_CORE = new Map(CORE_KINDS.flatMap((kind) => coreSentences(kind, coreFields(kind))));
// A contributed tile of each kind, carrying only the core's fields.
const coreTile = (kind: CapabilityKind): CapabilityCatalogEntry => ({
    id: `contributed-${kind}`,
    name: kind,
    kind,
    category: `devices`,
    description: ``,
    fields: coreFields(kind),
});
const PACKAGE_CATEGORIES = new Map(
    CAPABILITY_CATEGORIES.flatMap((category): [string, string][] => [
        [`${category.id}.label`, category.label],
        [`${category.id}.hint`, category.hint],
    ]),
);

// What the helpers put on screen for every built-in tile, in whichever language is active.
const shownEntries = (): Map<string, string> =>
    new Map(
        CAPABILITY_CATALOG.flatMap((entry) =>
            sentences(entry.id, {
                name: entryName(entry),
                description: entryDescription(entry),
                hint: entryHint(entry),
                guide: entryGuide(entry),
                fields: entryFields(entry),
            }),
        ),
    );
const shownCore = (): Map<string, string> => new Map(CORE_KINDS.flatMap((kind) => coreSentences(kind, entryFields(coreTile(kind)))));
const shownCategories = (): Map<string, string> =>
    new Map(
        CAPABILITY_CATEGORIES.flatMap((category): [string, string][] => [
            [`${category.id}.label`, categoryLabel(category)],
            [`${category.id}.hint`, categoryHint(category)],
        ]),
    );

const builtIn = (id: string): CapabilityCatalogEntry => {
    const entry = CAPABILITY_CATALOG.find((candidate) => candidate.id === id);
    if (entry === undefined) {
        throw new Error(`no built-in tile ${id}`);
    }
    return entry;
};

const servers = CAPABILITY_CATEGORIES.find((category) => category.id === `servers`)!;

// A tile an enabled extension contributes: its manifest's words, never a key of ours.
const contributed: CapabilityCatalogEntry = {
    id: `reddit`,
    name: `Reddit`,
    kind: `browser`,
    category: `communication`,
    description: `Read, post and vote as you.`,
    hint: `Signs in with your own account.`,
    guide: { steps: [`Log in once.`] },
    fields: [],
};

// Rendered, not raw: en.json holds the package's English as a vue-i18n message, so a `\` is doubled and a `<` is
// written `{'<'}` there, and what has to match the package is what a reader is shown.
test(`every tile sentence en.json holds is the package's current English`, () => {
    const drifted = leaves(en.capabilities.catalog)
        .map(([key]) => [key, t(`capabilities.catalog.${key}`), PACKAGE_ENTRIES.get(key)] as const)
        .filter(([, copy, english]) => copy !== english)
        .map(([key, copy, english]) => `${key}: en.json says ${JSON.stringify(copy)}, the package ${JSON.stringify(english)}`);

    expect(drifted).toEqual([]);
});

test(`every core field sentence en.json holds is the package's current English`, () => {
    const drifted = leaves(en.capabilities.coreFields)
        .map(([key]) => [key, t(`capabilities.coreFields.${key}`), PACKAGE_CORE.get(key)] as const)
        .filter(([, copy, english]) => copy !== english)
        .map(([key, copy, english]) => `${key}: en.json says ${JSON.stringify(copy)}, the package ${JSON.stringify(english)}`);

    expect(drifted).toEqual([]);
});

// Two fields of one tile, or two options of one field, under one key would show one's words for the other.
test(`no two fields of a tile, and no two options of a field, share a key`, () => {
    const clashes = [
        ...CAPABILITY_CATALOG.map((entry) => [entry.id, entry.fields] as const),
        ...CORE_KINDS.map((kind) => [kind, coreFields(kind)] as const),
    ].flatMap(([id, fields]) => {
        const slots = fields.map((_, index) => fieldSlot(fields, index)).filter((slot) => slot !== undefined);
        const options = fields.flatMap((field, index) => {
            const values = (field.options ?? []).map((option) => optionSlot(option.value));
            return values.length === new Set(values).size ? [] : [`${id}.${fieldSlot(fields, index)} options`];
        });
        return [...(slots.length === new Set(slots).size ? [] : [`${id} fields`]), ...options];
    });

    expect(clashes).toEqual([]);
});

test(`every category sentence en.json holds is the package's current English`, () => {
    const drifted = leaves(en.capabilities.categories)
        .map(([key]) => [key, t(`capabilities.categories.${key}`), PACKAGE_CATEGORIES.get(key)] as const)
        .filter(([, copy, english]) => copy !== english)
        .map(([key, copy, english]) => `${key}: en.json says ${JSON.stringify(copy)}, the package ${JSON.stringify(english)}`);

    expect(drifted).toEqual([]);
});

// A step appended to a translated guide, or a field added to a translated form, would otherwise be the one English
// line in a Polish page. A proper name ("Docker", "SSH") is the one part a translated tile may leave without a key, and
// a placeholder or an option may be one too ("root", "IKEv2", a figure the package computes).
const exempt = (key: string): boolean => key.endsWith(`.name`) || key.endsWith(`.placeholder`) || key.includes(`.options.`);

test(`a tile or category with a copy has one for each of its sentences`, () => {
    const keyed = new Set([...leaves(en.capabilities.catalog), ...leaves(en.capabilities.categories)].map(([key]) => key));
    const ids = new Set([...keyed].map((key) => key.split(`.`)[0]));
    const missing = [...PACKAGE_ENTRIES.keys(), ...PACKAGE_CATEGORIES.keys()].filter(
        (key) => ids.has(key.split(`.`)[0]) && !exempt(key) && !keyed.has(key),
    );

    expect(missing).toEqual([]);
});

test(`every core field has a copy of its label and hint`, () => {
    const keyed = new Set(leaves(en.capabilities.coreFields).map(([key]) => key));

    expect([...PACKAGE_CORE.keys()].filter((key) => !exempt(key) && !keyed.has(key))).toEqual([]);
});

test(`in English every built-in tile, core field and category reads exactly as the package spells it`, () => {
    expect(shownEntries()).toEqual(PACKAGE_ENTRIES);
    expect(shownCore()).toEqual(PACKAGE_CORE);
    expect(shownCategories()).toEqual(PACKAGE_CATEGORIES);
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    test(`the helpers reach every tile, core field and category sentence pl.json translates`, () => {
        const entries = shownEntries();
        const core = shownCore();
        const categories = shownCategories();
        const unreached = [
            ...leaves(pl.capabilities.catalog).filter(([key]) => entries.get(key) !== t(`capabilities.catalog.${key}`)),
            ...leaves(pl.capabilities.coreFields).filter(([key]) => core.get(key) !== t(`capabilities.coreFields.${key}`)),
            ...leaves(pl.capabilities.categories).filter(([key]) => categories.get(key) !== t(`capabilities.categories.${key}`)),
        ].map(([key]) => key);

        expect(unreached).toEqual([]);
    });

    test(`a form's fields read in Polish, what the form submits and gates on as it was`, () => {
        const ssh = builtIn(`ssh`);
        const fields = entryFields(ssh);
        const auth = fields.find((field) => field.key === `auth`);

        expect(auth?.label).toBe(`Uwierzytelnianie`);
        expect(auth?.options).toEqual([
            { value: `generated`, label: `Wygeneruj klucz za mnie` },
            { value: `key`, label: `Wklej własny klucz` },
            { value: `password`, label: `Hasło` },
        ]);
        // The two `privateKey` fields, one per arm, each with its own words.
        expect(fields.filter((field) => field.key === `privateKey`).map((field) => [field.label, field.when])).toEqual([
            [`Klucz`, `auth == 'generated'`],
            [`Klucz prywatny`, `auth == 'key'`],
        ]);
        expect(fields.map((field) => [field.key, field.when, field.secret, field.default])).toEqual(
            ssh.fields.map((field) => [field.key, field.when, field.secret, field.default]),
        );
        // An option value that is no key-safe word still finds its words.
        expect(entryFields(builtIn(`wallet`))[0]?.options?.map((option) => option.label)).toEqual([
            `Base, prawdziwe USDC`,
            `Base Sepolia, pieniądze testowe`,
        ]);
    });

    test(`a country and a model, built from the contract's figures, read in Polish`, () => {
        const tor = entryFields(builtIn(`exit`)).find((field) => field.key === `country` && field.when === `provider == 'tor'`);
        const model = entryFields(builtIn(`localmodel`)).find((field) => field.key === `model`);

        expect(tor?.options?.slice(0, 2).map((option) => option.label)).toEqual([`Gdziekolwiek (najszybciej)`, `Holandia — 30% przepustowości`]);
        expect(tor?.options?.find((option) => option.value === `PL`)?.label).toBe(`Polska — <1% przepustowości`);
        expect(model?.options?.[0]?.label).toMatch(/^Qwen3\.5 2B, wagi [\d.]+ GB · pobiera się w minutę, tylko do szybkich zadań$/);
    });

    test(`a contributed device tile's own fields keep their English, the core's read in Polish`, () => {
        const device: CapabilityCatalogEntry = {
            ...coreTile(`device`),
            fields: [{ key: `platform`, label: `Platform`, value: `linux` }, { key: `gpu`, label: `GPU` }, ...coreFields(`device`)],
        };

        expect(
            entryFields(device)
                .map((field) => field.label)
                .slice(0, 3),
        ).toEqual([`Platform`, `GPU`, `Uruchamianie poleceń`]);
    });

    test(`a built-in tile and category read in Polish, a proper name as it is`, () => {
        const netdisk = builtIn(`netdisk`);

        expect(entryName(netdisk)).toBe(`Dysk sieciowy`);
        expect(entryDescription(netdisk)).toBe(`Udział na NAS-ie lub serwerze plików, montowany tylko do odczytu albo z zapisem.`);
        // The two characters vue-i18n reads as syntax come through as written.
        expect(entryGuide(netdisk)?.steps?.[0]).toBe(`Pola Serwer i Udział to dwie części ścieżki \`\\\\server\\share\`.`);
        expect(entryHint(builtIn(`ssh`))).toBe(`Nazwa to alias, którego używa agent (ssh <nazwa> "…").`);
        expect(entryName(builtIn(`docker`))).toBe(`Docker`);
        expect([categoryLabel(servers), sliceDescription(`servers`)]).toEqual([
            `Serwery`,
            `Daj agentowi zdalne maszyny przez SSH, prywatne sieci przez VPN i dyski, które w nich są.`,
        ]);
    });

    test(`anything without a key keeps the English it came with`, () => {
        // Under a built-in id, but saying something of its own: an extension's tile, not ours.
        const namesake: CapabilityCatalogEntry = { ...contributed, id: `ssh`, kind: `ssh` };
        const later = { id: `robots`, label: `Robots`, hint: `Let the agent drive a robot.` };

        expect([entryName(contributed), entryDescription(contributed), entryHint(contributed), entryGuide(contributed)?.steps]).toEqual([
            `Reddit`,
            `Read, post and vote as you.`,
            `Signs in with your own account.`,
            [`Log in once.`],
        ]);
        expect([entryName(namesake), entryDescription(namesake), entryHint(namesake)]).toEqual([
            `Reddit`,
            `Read, post and vote as you.`,
            `Signs in with your own account.`,
        ]);
        expect([categoryLabel(later), categoryHint(later)]).toEqual([`Robots`, `Let the agent drive a robot.`]);
    });

    test(`search finds a built-in tile by its Polish words and by its English ones`, () => {
        const haystack = entryHaystack(builtIn(`netdisk`));

        expect([haystack.includes(`dysk sieciowy`), haystack.includes(`network disk`), haystack.includes(`netdisk`)]).toEqual([true, true, true]);
    });
});
