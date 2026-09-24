import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROFILE_COOKIE, PROFILE_KEYS, PROFILE_PARAM, PROFILE_STORAGE_KEY, PROFILES, type Profile, type ProfileLook } from "@intentic/constants";

// index.html's pre-paint script adopts an arriving profile before any module loads, so it cannot import the table it
// applies — it spells the values out. This reads them back and fails if they have parted from @intentic/constants.
// A silent drift here is the whole bug the profile exists to fix: the reader crosses from a light site and the app
// paints itself dark, with nothing in any diff to show why.

const html = readFileSync(resolve(import.meta.dirname, `../index.html`), `utf8`);

/** Evaluates one literal out of the inline script; `new Function` so trailing commas and bare keys parse as written. */
const literal = <T>(name: string): T => {
    const source = new RegExp(`var ${name} = ([\\s\\S]*?);\\n`, `u`).exec(html)?.[1];
    expect(source, `index.html declares no ${name}`).toEqual(expect.any(String));
    // oxlint-disable-next-line no-new-func -- reading our own checked-in literal, not input
    return new Function(`return (${source})`)() as T;
};

/** A profile as the script stores it: keyed by localStorage key, and silent about what the profile doesn't answer. */
const asStored = (look: ProfileLook): Record<string, string> => ({
    [PROFILE_KEYS.scheme]: look.scheme,
    [PROFILE_KEYS.skin]: look.skin,
    ...(look.audience === undefined ? {} : { [PROFILE_KEYS.audience]: look.audience }),
});

describe(`the pre-paint profile script`, () => {
    it(`applies the same profiles the rest of the product ships`, () => {
        const applied = literal<Record<Profile, Record<string, string>>>(`PROFILES`);
        const expected = Object.fromEntries(Object.entries(PROFILES).map(([id, look]) => [id, asStored(look)]));
        expect<Record<string, Record<string, string>>>(applied).toEqual(expected);
    });

    // The release half of the rule: a key the incoming profile doesn't name must be cleared, not stranded. Only a key
    // the script iterates can be released, so a key that exists in the table and not in this list leaks silently.
    it(`iterates every key any profile can write, so leaving one releases what it set`, () => {
        expect(literal<string[]>(`PROFILE_KEYS`).toSorted()).toEqual(Object.values(PROFILE_KEYS).toSorted());
    });

    it(`reads the param and writes the record under the names everything else uses`, () => {
        expect(html).toContain(`searchParams.get("${PROFILE_PARAM}")`);
        expect(html).toContain(`searchParams.delete("${PROFILE_PARAM}")`);
        expect(html).toContain(`localStorage.setItem("${PROFILE_STORAGE_KEY}", asked)`);
    });

    // The site writes this cookie (_site/site/src/lib/variant.ts) on the domain both origins share; a renamed cookie
    // on either side is a reader who took the installer from /desk and opened the app as a developer.
    it(`reads the site's edition cookie by the name the site writes it under`, () => {
        expect(html).toContain(`(?:^|; )${PROFILE_COOKIE}=([^;]*)`);
    });

    // The tag cannot spell the default look any more: it is the reader's OS's answer, and markup served from a CDN
    // does not know it. So the tag must carry NEITHER attribute — both spell their off state by being absent, which
    // makes a bare tag the fallback the script only has to correct upward.
    it(`ships no look in the tag, since the default one is the OS's to name`, () => {
        const tag = /<html[^>]*>/u.exec(html)?.[0] ?? ``;
        expect(PROFILES.default.scheme).toBe(`system`);
        expect(PROFILES.default.skin).toBe(`system`);
        expect(tag).not.toContain(`data-mode`);
        expect(tag).not.toContain(`data-skin`);
    });
});

// The script itself, run against a fake browser. Everything below exercises the shipped source rather than a copy of
// its rules, which is the only way a pre-paint script can be covered at all: it is a string in an HTML file, it runs
// before any module the app could test through, and its whole job is to be right on the first frame.

const SCRIPT = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1] ?? ``).find((body) => body.includes(`PROFILES`)) ?? ``;

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
}

const boot = (href: string, browser: Browser = {}, os: Os = `light`): BootResult => {
    const store = { ...browser.stored };
    const attributes = tagAttributes();
    let url: string | undefined;
    const localStorage = {
        getItem: (key: string): string | null => store[key] ?? null,
        setItem: (key: string, value: string): void => void (store[key] = value),
        removeItem: (key: string): void => void delete store[key],
    };
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
        // `no-preference` matches neither query, which is what `light` models here: the dark one simply misses.
        ...(os === `silent` ? {} : { matchMedia: (query: string): { matches: boolean } => ({ matches: os === `dark` && query.includes(`dark`) }) }),
    };
    // oxlint-disable-next-line no-new-func -- running our own checked-in script, with its globals shadowed by arguments
    new Function(`localStorage`, `document`, `window`, SCRIPT)(localStorage, document, window);
    return { stored: store, attributes, url };
};

describe(`arriving with a profile`, () => {
    it(`paints a reader from /desk in the light they were already reading in`, () => {
        const { stored, attributes, url } = boot(`https://app.intentic.dev/login?profile=desk`);
        expect(stored).toEqual({
            [PROFILE_KEYS.scheme]: `light`,
            [PROFILE_KEYS.skin]: `none`,
            [PROFILE_KEYS.audience]: `maker`,
            [PROFILE_STORAGE_KEY]: `desk`,
        });
        // Light and no skin are both spelled by the attribute being gone, which is what useTheme/useSkin do too. The
        // light entry screens key off exactly this absence, so there is no third attribute to write.
        expect(attributes.has(`data-mode`)).toBe(false);
        expect(attributes.has(`data-skin`)).toBe(false);
        expect(url).toBe(`/login`);
    });

    it(`keeps a query the app was given for itself`, () => {
        expect(boot(`https://app.intentic.dev/setup?machine=hosted&profile=desk`).url).toBe(`/setup?machine=hosted`);
    });

    it(`stores nothing without one, and leaves the URL alone`, () => {
        const { stored, url } = boot(`https://app.intentic.dev/login`);
        expect(stored).toEqual({});
        expect(url).toBeUndefined();
    });

    it(`ignores a profile it does not ship rather than remembering one`, () => {
        const { stored, url } = boot(`https://app.intentic.dev/login?profile=constructor`);
        expect(stored).toEqual({});
        expect(url).toBeUndefined();
    });

    // The way back. Every key desk set is still desk's, so default may take them all — including releasing the one it
    // does not answer, which is what puts the audience question back on the table. What it hands them back TO is the
    // OS, not a look of its own, so the attributes here are the reader's system setting rather than the profile's.
    it(`hands an untouched browser back to the app's own look`, () => {
        const desk = boot(`https://app.intentic.dev/login?profile=desk`).stored;
        const { stored, attributes } = boot(`https://app.intentic.dev/login?profile=default`, { stored: desk }, `dark`);
        expect(stored).toEqual({ [PROFILE_KEYS.scheme]: `system`, [PROFILE_KEYS.skin]: `system`, [PROFILE_STORAGE_KEY]: `default` });
        expect(attributes.get(`data-mode`)).toBe(`dark`);
        expect(attributes.get(`data-skin`)).toBe(`sanctum`);
    });

    // The rule that makes the link safe to click twice: what someone chose in Settings is theirs, not the link's.
    it(`leaves a look the reader chose for themselves, however they got here`, () => {
        const chosen = {
            ...boot(`https://app.intentic.dev/login?profile=desk`).stored,
            [PROFILE_KEYS.skin]: `sanctum`,
            [PROFILE_KEYS.scheme]: `dark`,
        };
        const { stored, attributes } = boot(`https://app.intentic.dev/login?profile=desk`, { stored: chosen });
        expect(stored[PROFILE_KEYS.skin]).toBe(`sanctum`);
        expect(stored[PROFILE_KEYS.scheme]).toBe(`dark`);
        expect(attributes.get(`data-skin`)).toBe(`sanctum`);
    });
});

// THE INSTALLER LEG. A reader on intentic.dev/desk who takes the desktop app never clicks a link into this origin; the
// first page of it they meet is the sign-in the app opens in their browser, with no ?profile= on it. The site's cookie
// is on the domain both origins share, and the script reads it as the link that was never followed.
describe(`arriving with the site's cookie and no link`, () => {
    const cookie = (value: string): string => `_ga=GA1.1.1; ${PROFILE_COOKIE}=${value}; other=1`;

    it(`adopts the desk profile from the cookie, and leaves the URL alone since there is nothing to consume`, () => {
        const { stored, attributes, url } = boot(`https://app.intentic.dev/desktop-auth?state=n&challenge=c`, { cookie: cookie(`desk`) });
        expect(stored).toEqual({
            [PROFILE_KEYS.scheme]: `light`,
            [PROFILE_KEYS.skin]: `none`,
            [PROFILE_KEYS.audience]: `maker`,
            [PROFILE_STORAGE_KEY]: `desk`,
        });
        expect(attributes.has(`data-mode`)).toBe(false);
        expect(url).toBeUndefined();
    });

    // The footer's way out writes any non-desk value; the site itself reads all of those as the default design.
    it(`reads any other value as the site's way out, which is the default profile`, () => {
        const desk = boot(`https://app.intentic.dev/login?profile=desk`).stored;
        const { stored } = boot(`https://app.intentic.dev/login`, { stored: desk, cookie: cookie(`default`) });
        expect(stored).toEqual({ [PROFILE_KEYS.scheme]: `system`, [PROFILE_KEYS.skin]: `system`, [PROFILE_STORAGE_KEY]: `default` });
    });

    it(`lets a link outrank the cookie, since the link is the newer opinion`, () => {
        const { stored, url } = boot(`https://app.intentic.dev/login?profile=default`, { cookie: cookie(`desk`) });
        expect(stored[PROFILE_STORAGE_KEY]).toBe(`default`);
        expect(url).toBe(`/login`);
    });

    it(`is the same non-overriding adoption a link gets: a choice made in Settings stays`, () => {
        const chosen = { ...boot(`https://app.intentic.dev/login?profile=desk`).stored, [PROFILE_KEYS.audience]: `developer` };
        const { stored } = boot(`https://app.intentic.dev/login`, { stored: chosen, cookie: cookie(`desk`) });
        expect(stored[PROFILE_KEYS.audience]).toBe(`developer`);
        expect(stored[PROFILE_KEYS.scheme]).toBe(`light`);
    });

    it(`stores nothing for a browser the site never met`, () => {
        expect(boot(`https://app.intentic.dev/login`, { cookie: `_ga=GA1.1.1` }).stored).toEqual({});
    });
});

// The half of the script that runs on EVERY load, profile or no profile: which light the first frame is drawn in.
// useTheme and useSkin run the same rule a module later, so a disagreement here is a repaint on the second frame.
describe(`the light the first frame is painted in`, () => {
    const looks = (result: BootResult): { mode: string | undefined; skin: string | undefined } => ({
        mode: result.attributes.get(`data-mode`),
        skin: result.attributes.get(`data-skin`),
    });

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
        expect(looks(boot(`https://app.intentic.dev/login`, { stored: { [PROFILE_KEYS.scheme]: `light` } }, `dark`))).toEqual({
            mode: undefined,
            skin: undefined,
        });
        expect(looks(boot(`https://app.intentic.dev/login`, { stored: { [PROFILE_KEYS.scheme]: `dark` } }, `light`))).toEqual({
            mode: `dark`,
            skin: `sanctum`,
        });
    });

    // Sanctum is the app's DARK look and has no daylight dress, so a pinned skin and a pinned scheme are one choice
    // made twice; a pinned `none` is the way to have the dark scheme without the stone.
    it(`obeys a pinned skin over what the scheme would have asked for`, () => {
        expect(looks(boot(`https://app.intentic.dev/login`, { stored: { [PROFILE_KEYS.skin]: `none` } }, `dark`))).toEqual({
            mode: `dark`,
            skin: undefined,
        });
        expect(looks(boot(`https://app.intentic.dev/login`, { stored: { [PROFILE_KEYS.skin]: `sanctum` } }, `light`))).toEqual({
            mode: undefined,
            skin: `sanctum`,
        });
    });
});
