import { CAPABILITY_CATALOG, CAPABILITY_CATEGORIES, type CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { type MessageTree, setLocale, t } from "@intentic/ui/i18n";
import en from "../../../app/i18n/locales/en.json";
import pl from "../../../app/i18n/locales/pl.json";
import { categoryHint, categoryLabel, entryDescription, entryGuide, entryHint, entryName } from "./catalogCopy";
import { sliceDescription } from "./slices";
import { entryHaystack } from "./tiles";

// The built-in catalog's words live in @intentic/capability-catalog, in English, and en.json carries a copy the
// Polish is translated from. These hold the copy to the package, so a sentence changed there cannot go on being shown
// in its old translation, and hold the helpers to the copy, so a key they spell wrong cannot quietly fall back.

const leaves = (tree: MessageTree, prefix = ``): [string, string][] =>
    Object.entries(tree).flatMap<[string, string]>(([name, value]) =>
        typeof value === `string` ? [[`${prefix}${name}`, value]] : leaves(value, `${prefix}${name}.`),
    );

type Words = Pick<CapabilityCatalogEntry, `name` | `description` | `hint` | `guide`>;

// Every sentence of a tile under the key path its copy takes, `<id>.guide.steps.<index>` and so on.
const sentences = (id: string, words: Words): [string, string][] => [
    [`${id}.name`, words.name],
    [`${id}.description`, words.description],
    ...(words.hint === undefined ? [] : [[`${id}.hint`, words.hint] satisfies [string, string]]),
    ...(words.guide?.linkLabel === undefined ? [] : [[`${id}.guide.linkLabel`, words.guide.linkLabel] satisfies [string, string]]),
    ...(words.guide?.scopes === undefined ? [] : [[`${id}.guide.scopes`, words.guide.scopes] satisfies [string, string]]),
    ...(words.guide?.steps ?? []).map((step, index): [string, string] => [`${id}.guide.steps.${index}`, step]),
];

const PACKAGE_ENTRIES = new Map(CAPABILITY_CATALOG.flatMap((entry) => sentences(entry.id, entry)));
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
            sentences(entry.id, { name: entryName(entry), description: entryDescription(entry), hint: entryHint(entry), guide: entryGuide(entry) }),
        ),
    );
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

test(`every category sentence en.json holds is the package's current English`, () => {
    const drifted = leaves(en.capabilities.categories)
        .map(([key]) => [key, t(`capabilities.categories.${key}`), PACKAGE_CATEGORIES.get(key)] as const)
        .filter(([, copy, english]) => copy !== english)
        .map(([key, copy, english]) => `${key}: en.json says ${JSON.stringify(copy)}, the package ${JSON.stringify(english)}`);

    expect(drifted).toEqual([]);
});

// A step appended to a translated guide would otherwise be the one English line in a Polish list. A proper name
// ("Docker", "SSH") is the one part a translated tile may leave without a key.
test(`a tile or category with a copy has one for each of its sentences`, () => {
    const keyed = new Set([...leaves(en.capabilities.catalog), ...leaves(en.capabilities.categories)].map(([key]) => key));
    const ids = new Set([...keyed].map((key) => key.split(`.`)[0]));
    const missing = [...PACKAGE_ENTRIES.keys(), ...PACKAGE_CATEGORIES.keys()].filter(
        (key) => ids.has(key.split(`.`)[0]) && !key.endsWith(`.name`) && !keyed.has(key),
    );

    expect(missing).toEqual([]);
});

test(`in English every built-in tile and category reads exactly as the package spells it`, () => {
    expect(shownEntries()).toEqual(PACKAGE_ENTRIES);
    expect(shownCategories()).toEqual(PACKAGE_CATEGORIES);
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    test(`the helpers reach every tile and category sentence pl.json translates`, () => {
        const entries = shownEntries();
        const categories = shownCategories();
        const unreached = [
            ...leaves(pl.capabilities.catalog).filter(([key]) => entries.get(key) !== t(`capabilities.catalog.${key}`)),
            ...leaves(pl.capabilities.categories).filter(([key]) => categories.get(key) !== t(`capabilities.categories.${key}`)),
        ].map(([key]) => key);

        expect(unreached).toEqual([]);
    });

    test(`a built-in tile and category read in Polish, a proper name as it is`, () => {
        const netdisk = builtIn(`netdisk`);

        expect(entryName(netdisk)).toBe(`Dysk sieciowy`);
        expect(entryDescription(netdisk)).toBe(`Udział na NAS-ie lub serwerze plików, montowany tylko do odczytu albo z zapisem.`);
        // The two characters vue-i18n reads as syntax come through as written.
        expect(entryGuide(netdisk)?.steps?.[0]).toBe(`Pola Server i Share to dwie części ścieżki \`\\\\server\\share\`.`);
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
