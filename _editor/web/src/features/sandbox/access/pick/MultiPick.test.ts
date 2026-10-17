// jsdom: what the long picker draws and what a press sends. A short list keeps a tick per row (the Access tab's own
// tests read that); past the limit the panel holds only what is picked, and the rest is found in the list it opens.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { allOptions, chipsOf, filterSections, isFamily, type PickSection, rowsOf, stateOf, withValues } from "./multiPick";

const { default: MultiPick } = await import("./MultiPick.vue");

/* THE RULES, read off data: what a search keeps, which picks read as one chip, and what a header picks. */

const reddit = {
    family: `Reddit`,
    label: `Reddit`,
    lead: `c:reddit-a`,
    options: [
        { value: `c:reddit-a`, label: `reddit-a`, note: `Reddit` },
        { value: `c:reddit-b`, label: `reddit-b`, note: `Reddit` },
    ],
};
const reachList: PickSection[] = [
    { key: `connections`, label: `Connections`, entries: [{ value: `c:github`, label: `github` }, reddit, { value: `c:npmjs`, label: `npmjs`, note: `npmjs.com` }] },
    { key: `secrets`, label: `Stored secrets`, entries: [{ value: `s:DATABASE_URL`, label: `DATABASE_URL`, mono: true }] },
];

const labelsOf = (kept: readonly PickSection[]): string[] => allOptions(kept).map((option) => option.label);

describe(`filterSections`, () => {
    it(`keeps a whole family when its name matches, though no member's own name says it`, () => {
        const named = reachList.map((section) => ({ ...section, entries: section.entries.map((entry) => (isFamily(entry) ? { ...entry, label: `Social` } : entry)) }));
        expect(labelsOf(filterSections(named, `social`))).toEqual([`reddit-a`, `reddit-b`]);
    });

    it(`matches an option by its note, and drops sections left empty`, () => {
        const kept = filterSections(reachList, `npmjs.com`);
        expect(kept.map((section) => section.key)).toEqual([`connections`]);
        expect(labelsOf(kept)).toEqual([`npmjs`]);
    });

    it(`narrows a family to the members that match, and keeps it a family`, () => {
        const [entry] = filterSections(reachList, `reddit-b`)[0]?.entries ?? [];
        expect(entry !== undefined && isFamily(entry) ? entry.options.map((option) => option.label) : entry).toEqual([`reddit-b`]);
    });

    it(`keeps nothing for a section's name alone, which is too broad a word to search by`, () => {
        expect(filterSections(reachList, `stored`)).toEqual([]);
    });

    it(`keeps everything for an empty or blank query`, () => {
        expect(filterSections(reachList, `  `)).toBe(reachList);
    });
});

describe(`chipsOf`, () => {
    it(`says a whole family once, with how many it holds`, () => {
        const chips = chipsOf(reachList, new Set([`c:reddit-a`, `c:reddit-b`, `s:DATABASE_URL`]));
        expect(chips.map((chip) => [chip.label, chip.count])).toEqual([
            [`Reddit`, 2],
            [`DATABASE_URL`, undefined],
        ]);
        expect(chips[0]?.values).toEqual([`c:reddit-a`, `c:reddit-b`]);
    });

    it(`says a whole section once, over the families inside it`, () => {
        const every = new Set([`c:github`, `c:reddit-a`, `c:reddit-b`, `c:npmjs`]);
        expect(chipsOf(reachList, every).map((chip) => chip.label)).toEqual([`Connections`]);
    });

    it(`draws each pick of a family picked in part, in the order the list draws them`, () => {
        expect(chipsOf(reachList, new Set([`c:npmjs`, `c:reddit-b`])).map((chip) => chip.label)).toEqual([`reddit-b`, `npmjs`]);
    });

    it(`never collapses a one-item section into a section chip`, () => {
        expect(chipsOf(reachList, new Set([`s:DATABASE_URL`]))[0]).toMatchObject({ label: `DATABASE_URL`, mono: true });
    });
});

describe(`rowsOf`, () => {
    it(`makes a named section with several a header that picks it, and one with a single option a bare label`, () => {
        expect(rowsOf(reachList).map((row) => `${row.kind}:${row.key}`)).toEqual([
            `section:s:connections`,
            `option:o:c:github`,
            `family:f:connections:Reddit`,
            `option:o:c:reddit-a`,
            `option:o:c:reddit-b`,
            `option:o:c:npmjs`,
            `label:l:secrets`,
            `option:o:s:DATABASE_URL`,
        ]);
    });
});

describe(`picking a set`, () => {
    it(`reads none, some or all`, () => {
        expect(stateOf([`a`, `b`], new Set())).toBe(`none`);
        expect(stateOf([`a`, `b`], new Set([`b`]))).toBe(`some`);
        expect(stateOf([`a`, `b`], new Set([`a`, `b`, `c`]))).toBe(`all`);
    });

    it(`adds a set once, after what was already picked, and takes it off leaving the rest`, () => {
        expect(withValues([`x`, `a`], [`a`, `b`], true)).toEqual([`x`, `a`, `b`]);
        expect(withValues([`x`, `a`, `b`], [`a`, `b`], false)).toEqual([`x`]);
    });
});

/* THE COMPONENT. */

// Nine identities and three loose connections: past the limit, and with a family worth picking whole.
const identities = Array.from({ length: 9 }, (_, index) => ({ value: `id-${index + 1}`, label: `radarsuspam${index + 1}`, note: `Identity` }));
const sections: PickSection[] = [
    {
        key: `connections`,
        label: `Connections`,
        entries: [
            { value: `npmjs`, label: `npmjs`, note: `npmjs.com` },
            { family: `Identity`, label: `Identity`, lead: `id-1`, options: identities },
            { value: `discord`, label: `discord` },
            { value: `github`, label: `github` },
        ],
    },
];

const picked = ref<string[]>([]);
const sent: string[][] = [];
let app: App | undefined;

// The overlay measures its anchor and closes on one of no size, which is every element jsdom lays out.
const realRect = HTMLElement.prototype.getBoundingClientRect;
beforeAll(() => {
    HTMLElement.prototype.getBoundingClientRect = function rect(): DOMRect {
        return { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 32, width: 320, height: 32, toJSON: () => ({}) };
    };
});
afterAll(() => {
    HTMLElement.prototype.getBoundingClientRect = realRect;
});

const mount = (): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        render: () =>
            h(MultiPick, {
                sections,
                picked: picked.value,
                searchLabel: `Find a connection or secret`,
                onChange: (next: string[]) => {
                    sent.push(next);
                    picked.value = next;
                },
            }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    picked.value = [];
    sent.length = 0;
    document.body.innerHTML = ``;
});

const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 4; tick += 1) {
        await nextTick();
    }
};
const trigger = (): HTMLButtonElement | null => document.body.querySelector(`button[aria-haspopup=listbox]`);
const options = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>(`[role=option]`)];
const option = (text: string): HTMLButtonElement | undefined => options().find((row) => row.textContent?.includes(text));
const chipTexts = (): string[] => [...document.body.querySelectorAll(`ul li`)].map((chip) => chip.textContent?.trim() ?? ``);

it(`draws no row per option once the list is long, only the count and a search`, async () => {
    mount();
    await settle();
    expect(document.body.querySelectorAll(`input[type=checkbox]`)).toHaveLength(0);
    expect(trigger()?.textContent).toContain(`Find a connection or secret`);
    expect(document.body.textContent).toContain(`0 of 12 picked`);
});

it(`picks a whole family from its header, and shows it as one chip`, async () => {
    mount();
    await settle();
    trigger()?.click();
    await settle();
    option(`Identity`)?.click();
    await settle();

    expect(sent.at(-1)).toEqual(identities.map((identity) => identity.value));
    expect(chipTexts()).toEqual([`Identityall 9`]);
    expect(document.body.textContent).toContain(`9 of 12 picked`);
});

it(`finds by what was typed, and picks only what the search shows`, async () => {
    mount();
    await settle();
    trigger()?.click();
    await settle();
    const field = document.body.querySelector<HTMLInputElement>(`[role=dialog] input`);
    if (field === null) {
        throw new Error(`no search field in the open list`);
    }
    field.value = `git`;
    field.dispatchEvent(new Event(`input`));
    await settle();

    expect(options().map((row) => row.textContent?.trim())).toEqual([`github`]);
    [...document.body.querySelectorAll<HTMLButtonElement>(`[role=dialog] button`)].find((button) => button.textContent?.includes(`Pick the 1 shown`))?.click();
    await settle();
    expect(sent.at(-1)).toEqual([`github`]);
});

it(`takes a pick back from its chip, and leaves the rest`, async () => {
    picked.value = [`npmjs`, `github`];
    mount();
    await settle();
    expect(chipTexts()).toEqual([`npmjs`, `github`]);
    document.body.querySelector<HTMLButtonElement>(`button[aria-label="Remove npmjs"]`)?.click();
    await settle();
    expect(sent.at(-1)).toEqual([`github`]);
});

it(`folds chips past a dozen behind a count, and opens them on a press`, async () => {
    const many: PickSection[] = [{ key: `secrets`, entries: Array.from({ length: 15 }, (_, index) => ({ value: `S${index}`, label: `S${index}`, mono: true })) }];
    picked.value = many[0]?.entries.map((entry) => (`value` in entry ? entry.value : ``)) ?? [];
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(MultiPick, { sections: many, picked: picked.value, searchLabel: `Find a secret` }) });
    app.component(`Icon`, IconStub);
    app.use(PrimeVue);
    app.mount(el);
    await settle();

    expect(chipTexts()).toHaveLength(13);
    expect(chipTexts().at(-1)).toBe(`+3 more`);
    [...document.body.querySelectorAll<HTMLButtonElement>(`ul button`)].find((button) => button.textContent?.trim() === `+3 more`)?.click();
    await settle();
    expect(chipTexts()).toHaveLength(16);
    expect(chipTexts().at(-1)).toBe(`Show fewer`);
});
