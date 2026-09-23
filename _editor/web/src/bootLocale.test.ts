import "@intentic/testing/dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCALE_CODES, LOCALE_KEY, negotiate } from "@intentic/ui/locales";

// index.html's pre-paint script picks the language before any module loads, so it cannot import `negotiate` — it
// spells the rule out in ES5. This runs the real script and fails if its answer ever parts from the module's.
//
// Drift here is invisible in a diff and loud on screen: the page paints with `lang="en"`, the app boots a module
// later and decides the reader wanted Polish, and every line of text reflows under a different fallback face.

const html = readFileSync(resolve(import.meta.dirname, `../index.html`), `utf8`);

/** The whole inline pre-paint script, run against this jsdom document. */
const bootScript = (): string => {
    const source = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(source, `index.html has no inline pre-paint script`).toEqual(expect.any(String));
    return source as string;
};

/** Evaluates one literal out of the inline script; `new Function` so trailing commas and bare keys parse as written. */
const literal = <T>(name: string): T => {
    const source = new RegExp(`var ${name} = ([\\s\\S]*?);\\n`, `u`).exec(html)?.[1];
    expect(source, `index.html declares no ${name}`).toEqual(expect.any(String));
    // oxlint-disable-next-line no-new-func -- reading our own checked-in literal, not input
    return new Function(`return (${source})`)() as T;
};

/** Runs the pre-paint script with a browser that offers `languages` and a store holding `stored`. */
const paintedLang = (languages: readonly string[], stored?: string): string => {
    localStorage.clear();
    if (stored !== undefined) {
        localStorage.setItem(LOCALE_KEY, stored);
    }
    Object.defineProperty(globalThis.navigator, `languages`, { value: languages, configurable: true });
    document.documentElement.removeAttribute(`lang`);
    // oxlint-disable-next-line no-new-func -- running our own checked-in script, not input
    new Function(bootScript())();
    return document.documentElement.getAttribute(`lang`) ?? ``;
};

describe(`the pre-paint language script`, () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it(`offers exactly the languages the app ships`, () => {
        expect(literal<string[]>(`UI_LOCALES`)).toEqual([...LOCALE_CODES]);
    });

    it(`reads the choice from the key the preference writes it to`, () => {
        expect(html).toContain(`localStorage.getItem("${LOCALE_KEY}")`);
    });

    // The rule itself, case by case, against the module that the app runs a moment later.
    it.each([
        { languages: [`pl-PL`, `pl`, `en-US`], as: `a region tag matching on its primary subtag` },
        { languages: [`en-GB`], as: `the source language` },
        { languages: [`cs-CZ`, `sk`, `de-AT`], as: `the first shipped language in the reader's order, not the first offered` },
        { languages: [`ja`, `ko`], as: `nothing we ship, which falls back to English` },
        { languages: [`FR-ca`], as: `a tag whose case does not match ours` },
        { languages: [], as: `a browser that offers no preference at all` },
    ])(`agrees with negotiate() on $as`, ({ languages }) => {
        expect(paintedLang(languages)).toBe(negotiate(languages));
    });

    it(`prefers a stored choice over anything the browser offers`, () => {
        expect(paintedLang([`de-DE`, `de`], `pl`)).toBe(`pl`);
    });

    // A language dropped from LOCALES leaves its code behind in readers' browsers; the stored value has to lose to
    // the negotiated one, or those readers boot into a pack that no longer exists and see keys instead of words.
    it(`ignores a stored language the app no longer ships`, () => {
        expect(paintedLang([`de-DE`, `de`], `sv`)).toBe(`de`);
    });
});
