import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

// The account's preferences on both faces of the desktop app (desktopPreferences.ts): the workspace says its whole set to
// the app whenever any of it changes, This computer wears what the app hands it and says back each choice made there,
// and the workspace takes such a choice as its own. Before this, This computer kept its own storage's rail and text size,
// and every switch between it and a sandbox resized the rail's logos.

const DESKTOP = { version: `1.400.0`, installId: `i`, update: null };

interface Page {
    readonly sent: unknown[];
    readonly preference: typeof import("@intentic/ui/preference");
}

// A page of the app: its marks set as the app sets them, its links caught where the app would hear them.
// The page started last, stopped after its test: a page's listeners outlive a fresh import of the module.
let stopPage: (() => void) | undefined;

const page = async (marks: Record<string, unknown>): Promise<Page> => {
    const sent: unknown[] = [];
    for (const key of [`__INTENTIC_DESKTOP__`, `__INTENTIC_LOCAL__`, `__INTENTIC_PREFS__`, `__INTENTIC_PREFS_IN__`] as const) {
        Reflect.deleteProperty(window, key);
    }
    Object.assign(window, { __INTENTIC_DESKTOP__: DESKTOP, ...marks });
    // Where the page's links go (desktop.ts `openDesktopLink`): each one the app would hear, as the values it carries.
    Object.defineProperty(globalThis, `location`, {
        configurable: true,
        value: {
            set href(link: string) {
                sent.push(JSON.parse(new URL(link).searchParams.get(`values`) ?? `null`));
            },
        },
    });
    const module = await freshImport<typeof import("./desktopPreferences")>(`./desktopPreferences`, import.meta.url);
    const preference = await import(`@intentic/ui/preference`);
    stopPage = module.startDesktopPreferences();
    return { sent, preference };
};

const LOCAL = { daemonUrl: `http://127.0.0.1:1`, token: `t`, id: `f`, name: `files`, path: `/f`, home: true };

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

beforeEach(() => {
    localStorage.clear();
});

const realLocation = Object.getOwnPropertyDescriptor(globalThis, `location`);
afterEach(() => {
    stopPage?.();
    stopPage = undefined;
    if (realLocation !== undefined) {
        Object.defineProperty(globalThis, `location`, realLocation);
    }
});

test(`the workspace says its whole set, and again when the account's copy changes it`, async () => {
    localStorage.setItem(`ui-text-size`, `default`);
    const { sent, preference } = await page({});
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ "ui-text-size": `default`, "ui-icon-rail-size": null });

    preference.adoptPreference(`ui-icon-rail-size`, `comfortable`);
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ "ui-icon-rail-size": `comfortable` });

    // Not one of the account's: nothing to say.
    preference.adoptPreference(`ui-chat-width`, `400`);
    await settle();
    expect(sent).toHaveLength(2);
});

test(`the workspace takes a choice made on This computer as its own`, async () => {
    const { preference } = await page({ __INTENTIC_PREFS__: { version: 5, values: { "ui-text-size": `large` } } });
    const heard: string[] = [];
    preference.onPreferenceWrite((key, raw) => heard.push(`${key}=${raw}`));
    expect(localStorage.getItem(`ui-text-size`)).toBe(`large`);

    window.__INTENTIC_PREFS_IN__?.({ version: 6, values: { "ui-icon-rail-size": `comfortable` } });
    expect(localStorage.getItem(`ui-icon-rail-size`)).toBe(`comfortable`);
    // Heard as a choice: what the account sync sends.
    expect(heard).toEqual([`ui-icon-rail-size=comfortable`]);
    expect(localStorage.getItem(`intentic.prefs-version`)).toBe(`6`);
});

test(`a handover this origin has taken already, or one older, is not taken again`, async () => {
    localStorage.setItem(`intentic.prefs-version`, `9`);
    localStorage.setItem(`ui-text-size`, `default`);
    await page({ __INTENTIC_LOCAL__: LOCAL, __INTENTIC_PREFS__: { version: 7, values: { "ui-text-size": `large` } } });
    expect(localStorage.getItem(`ui-text-size`)).toBe(`default`);
});

test(`This computer wears the workspace's word and says back only what is chosen there`, async () => {
    localStorage.setItem(`ui-icon-rail-size`, `comfortable`);
    const { sent, preference } = await page({
        __INTENTIC_LOCAL__: LOCAL,
        __INTENTIC_PREFS__: { version: 3, values: { "ui-icon-rail-size": null, "ui-text-size": `default` } },
    });
    expect(localStorage.getItem(`ui-icon-rail-size`)).toBeNull();
    expect(localStorage.getItem(`ui-text-size`)).toBe(`default`);

    // A change from the workspace: worn, not said back.
    window.__INTENTIC_PREFS_IN__?.({ version: 4, values: { "ui-text-size": `large` } });
    expect(localStorage.getItem(`ui-text-size`)).toBe(`large`);
    await settle();
    expect(sent).toEqual([]);

    // A choice made here: said to the app.
    const rail = preference.enumPreference(`ui-icon-rail-size`, [`compact`, `comfortable`], `compact`);
    rail.value = `comfortable`;
    await settle();
    expect(sent).toEqual([{ "ui-icon-rail-size": `comfortable` }]);
});

test(`outside the app nothing is said and nothing is taken`, async () => {
    Reflect.deleteProperty(window, `__INTENTIC_DESKTOP__`);
    const { sent } = await page({ __INTENTIC_DESKTOP__: undefined, __INTENTIC_PREFS__: { version: 1, values: { "ui-text-size": `large` } } });
    await settle();
    expect(sent).toEqual([]);
    expect(localStorage.getItem(`ui-text-size`)).toBeNull();
});
