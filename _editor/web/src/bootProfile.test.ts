import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROFILE_COOKIE, PROFILE_IDS, PROFILE_PARAM, PROFILE_STORAGE_KEY } from "@intentic/constants";
import { THEME_ROW, type ThemeRow, themeRowLook } from "./skins/themeRow";

// index.html's pre-paint script remembers an arriving profile before any module loads, so it cannot import the names
// it knows: it spells them out. This reads them back and fails if they have parted from @intentic/constants, then runs
// the script itself. A drift here is silent: the reader who came from intentic.dev/desk finds their first sandbox
// preselected to run hands-on, with nothing in any diff to show why.

const html = readFileSync(resolve(import.meta.dirname, `../index.html`), `utf8`);

/** Evaluates one literal out of the inline script; `new Function` so trailing commas and bare keys parse as written. */
const literal = <T>(name: string): T => {
    const source = new RegExp(`var ${name} = ([\\s\\S]*?);\\n`, `u`).exec(html)?.[1];
    expect(source, `index.html declares no ${name}`).toEqual(expect.any(String));
    // reading our own checked-in literal, not input
    return new Function(`return (${source})`)() as T;
};

// Where the look and the words are stored, each key owned by the composable named beside it. A link writes none of
// them any more: they are here to show that it does not, and for the paint that reads them.
const SCHEME = `ui-color-scheme`; // _editor/ui/src/composables/useTheme.ts
const SKIN = `ui-skin`; // src/skins/useSkin.ts
const AUDIENCE = `ui-audience`; // src/app/useAudience.ts

describe(`the pre-paint profile script`, () => {
    it(`knows exactly the profiles the rest of the product ships`, () => {
        expect(literal<string[]>(`PROFILE_IDS`)).toEqual([...PROFILE_IDS]);
    });

    // The tag cannot spell the default look: it is the reader's OS's answer, and markup served from a CDN does not
    // know it. So the tag must carry NEITHER attribute — both spell their off state by being absent, which makes a
    // bare tag the fallback the script only has to correct upward.
    it(`ships no look in the tag, since the default one is the OS's to name`, () => {
        const tag = /<html[^>]*>/u.exec(html)?.[0] ?? ``;
        expect(tag).not.toContain(`data-mode`);
        expect(tag).not.toContain(`data-skin`);
    });
});

// The script itself, run against a fake browser. Everything below exercises the shipped source rather than a copy of
// its rules, which is the only way a pre-paint script can be covered at all: it is a string in an HTML file, it runs
// before any module the app could test through, and its whole job is to be right on the first frame.

const SCRIPT = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/giu)].map((match) => match[1] ?? ``).find((body) => body.includes(`var PROFILE_IDS = `)) ?? ``;

/** The attributes the served markup starts with; the script corrects these, it does not write them from nothing. */
const tagAttributes = (): Map<string, string> =>
    new Map(
        [...(/<html([^>]*)>/u.exec(html)?.[1] ?? ``).matchAll(/([\w-]+)="([^"]*)"/gu)].map((attribute) => [attribute[1] ?? ``, attribute[2] ?? ``]),
    );

interface BootResult {
    readonly stored: Record<string, string>;
    readonly attributes: Map<string, string>;
    /** What replaceState was given, or undefined when the script left the URL alone. */
    readonly url: string | undefined;
}

/** What the reader's OS says. `silent` is a browser with no `matchMedia` at all, the far end of "will not say". */
type Os = "light" | "dark" | "silent";

/** What the browser holds for this origin: what the app stored, and what the site's cookie says, if anything. */
interface Browser {
    readonly stored?: Record<string, string>;
    readonly cookie?: string;
    /** This tab's session storage, where the Android app's WebView is remembered (app/environments/nativeApp.ts). */
    readonly tab?: Record<string, string>;
    /** The Android app's own object, as it injects it before any script runs. */
    readonly app?: { readonly look: () => string };
    /** The look the desktop app hands every page it builds before any script runs (windows/mode.rs `look_init_script`). */
    readonly desktopLook?: string;
}

const boot = (href: string, browser: Browser = {}, os: Os = `light`): BootResult => {
    const store = { ...browser.stored };
    const attributes = tagAttributes();
    let url: string | undefined;
    const storageOver = (held: Record<string, string>) => ({
        getItem: (key: string): string | null => held[key] ?? null,
        setItem: (key: string, value: string): void => void (held[key] = value),
        removeItem: (key: string): void => void delete held[key],
    });
    const localStorage = storageOver(store);
    const document = {
        documentElement: {
            setAttribute: (name: string, value: string): void => void attributes.set(name, value),
            removeAttribute: (name: string): void => void attributes.delete(name),
        },
        // The theme-color tag the script repoints; nothing here reads it back, so a miss is the whole stub.
        querySelector: (): null => null,
        cookie: browser.cookie ?? ``,
    };
    const window = {
        location: { href },
        history: { replaceState: (_state: null, _title: string, next: string): void => void (url = next) },
        sessionStorage: storageOver({ ...browser.tab }),
        intenticNative: browser.app,
        __INTENTIC_LOOK__: browser.desktopLook,
        // `no-preference` matches neither query, which is what `light` models here: the dark one simply misses.
        ...(os === `silent` ? {} : { matchMedia: (query: string): { matches: boolean } => ({ matches: os === `dark` && query.includes(`dark`) }) }),
    };
    // running our own checked-in script, with its globals shadowed by arguments
    new Function(`localStorage`, `document`, `window`, SCRIPT)(localStorage, document, window);
    return { stored: store, attributes, url };
};

/** What the first frame wears: the two attributes useTheme and useSkin keep in step a module later. */
interface Frame {
    readonly mode: string | undefined;
    readonly skin: string | undefined;
}

const looks = (result: BootResult): Frame => ({
    mode: result.attributes.get(`data-mode`),
    skin: result.attributes.get(`data-skin`),
});

/** What a Theme row look resolves to on a screen, under an OS in `os`: useTheme's and useSkin's own rule. */
const worn = (row: ThemeRow, os: `light` | `dark`): Frame => {
    const { scheme, skin } = themeRowLook(row);
    const dark = scheme === `system` ? os === `dark` : scheme === `dark`;
    const wornSkin = skin === `system` ? (dark ? `sanctum` : `none`) : skin;
    return { mode: dark ? `dark` : undefined, skin: wornSkin === `none` ? undefined : wornSkin };
};

/** A link into the app as the site writes one (_site/site/src/lib/variant.ts), naming a profile. */
const link = (path: string, profile: string): string => `https://app.intentic.dev${path}${path.includes(`?`) ? `&` : `?`}${PROFILE_PARAM}=${profile}`;

// What a desk link left in a browser until 2026-11: daylight, unskinned and a maker's words, under the profile's name.
const DESK_SEEDED = { [SCHEME]: `light`, [SKIN]: `none`, [AUDIENCE]: `maker`, [PROFILE_STORAGE_KEY]: `desk` };

describe(`arriving with a profile`, () => {
    it(`remembers every profile a link names, and takes the name off the address`, () => {
        for (const profile of PROFILE_IDS) {
            const { stored, url } = boot(link(`/login`, profile));
            expect({ profile, stored, url }).toEqual({ profile, stored: { [PROFILE_STORAGE_KEY]: profile }, url: `/login` });
        }
    });

    it(`keeps a query the app was given for itself`, () => {
        expect(boot(link(`/setup?machine=hosted`, `desk`)).url).toBe(`/setup?machine=hosted`);
    });

    it(`stores nothing without one, and leaves the URL alone`, () => {
        const { stored, url } = boot(`https://app.intentic.dev/login`);
        expect(stored).toEqual({});
        expect(url).toBeUndefined();
    });

    it(`ignores a profile it does not ship rather than remembering one`, () => {
        const { stored, url } = boot(link(`/login`, `constructor`));
        expect(stored).toEqual({});
        expect(url).toBeUndefined();
    });

    // The way back: the site's way out of the desk puts `default` on every link into the app, and a link is the newer
    // opinion, so it replaces the preselect the desk left.
    it(`takes a later link's profile over the one it remembered`, () => {
        expect(boot(link(`/login`, `default`), { stored: { [PROFILE_STORAGE_KEY]: `desk` } }).stored).toEqual({ [PROFILE_STORAGE_KEY]: `default` });
    });

    // The look is the reader's own and the words follow the sandbox, so a link names neither: not into a browser that
    // holds nothing, not over what the reader chose, and not to take back what an older desk link wrote, which is
    // the reader's to change in Appearance now like any other look.
    it(`writes no look and no words, whatever the browser holds`, () => {
        const browsers = {
            empty: {},
            chosen: { [SCHEME]: `dark`, [SKIN]: `sanctum`, [AUDIENCE]: `developer` },
            "seeded by a desk link": DESK_SEEDED,
        };
        for (const [browser, held] of Object.entries(browsers)) {
            for (const profile of PROFILE_IDS) {
                const { stored } = boot(link(`/login`, profile), { stored: held });
                expect({ browser, profile, stored }).toEqual({ browser, profile, stored: { ...held, [PROFILE_STORAGE_KEY]: profile } });
            }
        }
    });

    // A desk link used to paint the app in the site's daylight. The reader's OS answers now, as it does for anyone
    // who has not chosen.
    it(`paints a reader from /desk in their own light, not the site's`, () => {
        expect(looks(boot(link(`/login`, `desk`), {}, `dark`))).toEqual({ mode: `dark`, skin: `sanctum` });
        expect(looks(boot(link(`/login`, `desk`), {}, `light`))).toEqual({ mode: undefined, skin: undefined });
    });
});

// THE SITE'S COOKIE IS THE SITE'S. It sits on the domain both origins share, so this origin can read it, but it is the
// site's memory of its own skin, and the app stopped taking a profile from it in 2026-11 (@intentic/constants
// profile.ts): only a link the reader followed preselects how their sandbox runs.
describe(`the site's cookie`, () => {
    const cookie = (value: string): string => `_ga=GA1.1.1; ${PROFILE_COOKIE}=${value}; other=1`;

    it(`names no profile and paints nothing without a link, whatever it says`, () => {
        for (const value of [`desk`, `default`]) {
            const result = boot(`https://app.intentic.dev/desktop-auth?state=n&challenge=c`, { cookie: cookie(value) }, `dark`);
            expect({ value, stored: result.stored, url: result.url, ...looks(result) }).toEqual({ value, stored: {}, url: undefined, mode: `dark`, skin: `sanctum` });
        }
    });

    it(`changes neither a profile already remembered nor the one a link names`, () => {
        expect(boot(`https://app.intentic.dev/login`, { stored: { [PROFILE_STORAGE_KEY]: `default` }, cookie: cookie(`desk`) }).stored).toEqual({
            [PROFILE_STORAGE_KEY]: `default`,
        });
        expect(boot(link(`/login`, `default`), { cookie: cookie(`desk`) }).stored).toEqual({ [PROFILE_STORAGE_KEY]: `default` });
    });
});

// The half of the script that runs on EVERY load, profile or no profile: which light the first frame is drawn in.
// useTheme and useSkin run the same rule a module later, so a disagreement here is a repaint on the second frame.
describe(`the light the first frame is painted in`, () => {
    it(`follows a reader whose system is dark, skin and all`, () => {
        expect(looks(boot(`https://app.intentic.dev/login`, {}, `dark`))).toEqual({ mode: `dark`, skin: `sanctum` });
    });

    it(`leaves a reader whose system is light in daylight, with no skin over it`, () => {
        expect(looks(boot(`https://app.intentic.dev/login`, {}, `light`))).toEqual({ mode: undefined, skin: undefined });
    });

    // The whole of the default: light is what a browser that cannot be asked gets, never dark.
    it(`falls to daylight when the browser cannot be asked at all`, () => {
        expect(looks(boot(`https://app.intentic.dev/login`, {}, `silent`))).toEqual({ mode: undefined, skin: undefined });
    });

    it(`obeys a pinned scheme over the system's`, () => {
        expect(looks(boot(`https://app.intentic.dev/login`, { stored: { [SCHEME]: `light` } }, `dark`))).toEqual({ mode: undefined, skin: undefined });
        expect(looks(boot(`https://app.intentic.dev/login`, { stored: { [SCHEME]: `dark` } }, `light`))).toEqual({ mode: `dark`, skin: `sanctum` });
    });

    // Sanctum is the app's DARK look and has no daylight dress, so a pinned skin and a pinned scheme are one choice
    // made twice; a pinned `none` is the way to have the dark scheme without the stone.
    it(`obeys a pinned skin over what the scheme would have asked for`, () => {
        expect(looks(boot(`https://app.intentic.dev/login`, { stored: { [SKIN]: `none` } }, `dark`))).toEqual({ mode: `dark`, skin: undefined });
        expect(looks(boot(`https://app.intentic.dev/login`, { stored: { [SKIN]: `sanctum` } }, `light`))).toEqual({ mode: undefined, skin: `sanctum` });
    });
});

// THE ANDROID APP'S WEBVIEW wears the app's look over the one stored here, from the first frame, and writes nothing. The
// script spells each look as the pair the Theme row stores for it; this runs every look through both and fails if the
// script and the row (skins/themeRow.ts) ever part.
describe(`the first frame inside the Android app`, () => {
    const chosen = { [SCHEME]: `light`, [SKIN]: `none` };

    it(`wears every look the address names, over the reader's own choice`, () => {
        for (const row of THEME_ROW) {
            for (const os of [`light`, `dark`] as const) {
                const result = boot(`https://app.intentic.dev/settings?embed=native&look=${row}`, { stored: chosen }, os);
                expect({ row, os, ...looks(result) }).toEqual({ row, os, ...worn(row, os) });
                expect(result.stored).toEqual(chosen);
            }
        }
    });

    it(`takes the app's object at its word over the address, and the tab's memory after a reload`, () => {
        expect(looks(boot(`https://app.intentic.dev/settings?embed=native&look=light`, { app: { look: () => `sanctum` } }))).toEqual(worn(`sanctum`, `light`));
        expect(looks(boot(`https://app.intentic.dev/settings`, { tab: { "intentic.embed": `native`, "intentic.embed.look": `dark` } }))).toEqual(
            worn(`dark`, `light`),
        );
    });

    it(`leaves a browser to its own choice, whatever look an address names`, () => {
        expect(looks(boot(`https://app.intentic.dev/settings?look=dark`, { stored: chosen }))).toEqual({ mode: undefined, skin: undefined });
        expect(looks(boot(`https://app.intentic.dev/settings`, { stored: chosen, tab: { "intentic.embed.look": `dark` } }))).toEqual({
            mode: undefined,
            skin: undefined,
        });
    });
});

// THE DESKTOP APP'S PAGES are origins with a storage each: the workspace on the platform's, every local window on the
// app's own bundle. The app hands each the look the reader was last seen in, which a page adopts while its origin holds
// no look the reader chose, so a first sandbox opens in the look the app was just showing.
describe(`the first frame of a page the desktop app built`, () => {
    const SIGN_IN = link(`/desktop-auth/complete?handoff=h&verifier=v`, `desk`);

    it(`adopts every look the app hands an origin that holds none, and stores it as the Theme row would`, () => {
        for (const row of THEME_ROW) {
            for (const os of [`light`, `dark`] as const) {
                const result = boot(`https://app.intentic.dev/`, { desktopLook: row }, os);
                expect({ row, os, ...looks(result) }).toEqual({ row, os, ...worn(row, os) });
                const { scheme, skin } = themeRowLook(row);
                expect(result.stored).toEqual({ [SCHEME]: scheme, [SKIN]: skin });
            }
        }
    });

    it(`wears the app's look on the page a desk sign-in opens, and remembers the profile beside it`, () => {
        const result = boot(SIGN_IN, { desktopLook: `sanctum` }, `light`);
        expect(looks(result)).toEqual({ mode: `dark`, skin: `sanctum` });
        expect(result.stored).toEqual({ [SCHEME]: `dark`, [SKIN]: `sanctum`, [PROFILE_STORAGE_KEY]: `desk` });
        expect(result.url).toBe(`/desktop-auth/complete?handoff=h&verifier=v`);
    });

    // The bug the adoption exists for, on the browsers that still carry it: a desk link's daylight painted the first
    // sandbox under a reader the app had just shown sanctum. That daylight was never the reader's, so the app's look
    // still replaces it; the words beside it are useAudience's to replace once the sandbox answers, so they stay.
    it(`still counts what a desk link wrote before 2026-11 as no choice of the reader's`, () => {
        for (const href of [`https://app.intentic.dev/`, SIGN_IN]) {
            const result = boot(href, { stored: DESK_SEEDED, desktopLook: `sanctum` }, `light`);
            expect({ href, ...looks(result) }).toEqual({ href, mode: `dark`, skin: `sanctum` });
            expect(result.stored).toEqual({ ...DESK_SEEDED, [SCHEME]: `dark`, [SKIN]: `sanctum` });
        }
    });

    // The same pair is the Theme row's own Light, so anywhere a desk link did not leave it, somebody picked it.
    it(`counts that same daylight as chosen where no desk link left it`, () => {
        const { scheme, skin } = themeRowLook(`light`);
        const daylight = { [SCHEME]: scheme, [SKIN]: skin };
        for (const held of [daylight, { ...daylight, [PROFILE_STORAGE_KEY]: `default` }]) {
            const result = boot(`https://app.intentic.dev/`, { stored: held, desktopLook: `sanctum` }, `dark`);
            expect(looks(result)).toEqual({ mode: undefined, skin: undefined });
            expect(result.stored).toEqual(held);
        }
    });

    it(`leaves a look the reader chose on this origin, whatever the app hands it later`, () => {
        // The second is a desk browser whose reader has since picked Dark over the half the link wrote.
        for (const chosen of [{ [SCHEME]: `light`, [SKIN]: `none` }, { ...DESK_SEEDED, [SCHEME]: `dark` }]) {
            const result = boot(`https://app.intentic.dev/`, { stored: chosen, desktopLook: `sanctum` }, `light`);
            expect(result.stored).toEqual(chosen);
            expect(result.attributes.get(`data-skin`)).toBeUndefined();
        }
    });

    it(`ignores a look it cannot name, and a page the Android app wears its own look in`, () => {
        expect(boot(`https://app.intentic.dev/`, { desktopLook: `neon` }).stored).toEqual({});
        const native = boot(`https://app.intentic.dev/settings?embed=native&look=light`, { desktopLook: `sanctum` });
        expect(looks(native)).toEqual(worn(`light`, `light`));
        expect(native.stored).toEqual({});
    });
});
