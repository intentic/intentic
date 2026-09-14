import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROFILE_KEYS, PROFILE_PARAM, PROFILE_STORAGE_KEY, PROFILES, type Profile, type ProfileLook } from "@intentic/constants";
import { describe, expect, it } from "vitest";

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
        expect(applied).toEqual(expected);
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

    // The tag must already be what the `default` profile asks for, or a fresh browser paints one look and the script
    // corrects it a frame later. Both attributes spell their off state by being absent, which is why these compare a
    // presence rather than a value.
    it(`ships the default profile's own look in the tag, so a fresh browser needs no script at all`, () => {
        const tag = /<html[^>]*>/u.exec(html)?.[0] ?? ``;
        expect(tag.includes(`data-mode="dark"`)).toBe(PROFILES.default.scheme === `dark`);
        expect(tag.includes(`data-skin="${PROFILES.default.skin}"`)).toBe(PROFILES.default.skin !== `none`);
    });
});

// The script itself, run against a fake browser. Everything below exercises the shipped source rather than a copy of
// its rules, which is the only way a pre-paint script can be covered at all: it is a string in an HTML file, it runs
// before any module the app could test through, and its whole job is to be right on the first frame.

const SCRIPT = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1] ?? ``).find((body) => body.includes(`PROFILES`)) ?? ``;

/** The attributes the served markup starts with; the script corrects these, it does not write them from nothing. */
const tagAttributes = (): Map<string, string> =>
    new Map([...(/<html([^>]*)>/u.exec(html)?.[1] ?? ``).matchAll(/([\w-]+)="([^"]*)"/gu)].map((attribute) => [attribute[1] ?? ``, attribute[2] ?? ``]));

interface BootResult {
    readonly stored: Record<string, string>;
    readonly attributes: Map<string, string>;
    /** What replaceState was given, or undefined when the script left the URL alone. */
    readonly url: string | undefined;
}

const boot = (href: string, stored: Record<string, string> = {}): BootResult => {
    const store = { ...stored };
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
    };
    const window = { location: { href }, history: { replaceState: (_state: null, _title: string, next: string): void => void (url = next) } };
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

    it(`does nothing at all without one, so the served markup is what paints`, () => {
        const { stored, attributes, url } = boot(`https://app.intentic.dev/login`);
        expect(stored).toEqual({});
        expect(attributes.get(`data-mode`)).toBe(`dark`);
        expect(attributes.get(`data-skin`)).toBe(`sanctum`);
        expect(url).toBeUndefined();
    });

    it(`ignores a profile it does not ship rather than remembering one`, () => {
        const { stored, url } = boot(`https://app.intentic.dev/login?profile=constructor`);
        expect(stored).toEqual({});
        expect(url).toBeUndefined();
    });

    // The way back. Every key desk set is still desk's, so default may take them all — including releasing the one it
    // does not answer, which is what puts the audience question back on the table.
    it(`hands an untouched browser back to the app's own look`, () => {
        const desk = boot(`https://app.intentic.dev/login?profile=desk`).stored;
        const { stored, attributes } = boot(`https://app.intentic.dev/login?profile=default`, desk);
        expect(stored).toEqual({ [PROFILE_KEYS.scheme]: `dark`, [PROFILE_KEYS.skin]: `sanctum`, [PROFILE_STORAGE_KEY]: `default` });
        expect(attributes.get(`data-mode`)).toBe(`dark`);
        expect(attributes.get(`data-skin`)).toBe(`sanctum`);
    });

    // The rule that makes the link safe to click twice: what someone chose in Settings is theirs, not the link's.
    it(`leaves a look the reader chose for themselves, however they got here`, () => {
        const chosen = { ...boot(`https://app.intentic.dev/login?profile=desk`).stored, [PROFILE_KEYS.skin]: `sanctum`, [PROFILE_KEYS.scheme]: `dark` };
        const { stored, attributes } = boot(`https://app.intentic.dev/login?profile=desk`, chosen);
        expect(stored[PROFILE_KEYS.skin]).toBe(`sanctum`);
        expect(stored[PROFILE_KEYS.scheme]).toBe(`dark`);
        expect(attributes.get(`data-skin`)).toBe(`sanctum`);
    });
});
