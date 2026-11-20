import { engineOf, parseKeyword, searchUrl } from "./engines";

describe("keywords", () => {
    test("a keyword, a space and words searches that site", () => {
        expect(parseKeyword(`yt lofi beats`)).toMatchObject({ query: `lofi beats`, url: `https://www.youtube.com/results?search_query=lofi%20beats` });
        expect(parseKeyword(`gh vue router`)?.url).toBe(`https://github.com/search?q=vue%20router`);
        expect(parseKeyword(`w Gdańsk`)?.url).toBe(`https://en.wikipedia.org/wiki/Special:Search?search=Gda%C5%84sk`);
        expect(parseKeyword(`npm zod`)?.url).toBe(`https://www.npmjs.com/search?q=zod`);
        expect(parseKeyword(`mdn flexbox`)?.url).toBe(`https://developer.mozilla.org/en-US/search?q=flexbox`);
    });

    test("each engine has a short name of its own, whichever is the default", () => {
        expect(parseKeyword(`g intentic`)?.url).toBe(`https://www.google.com/search?q=intentic`);
        expect(parseKeyword(`ddg intentic`)?.url).toBe(`https://duckduckgo.com/?q=intentic`);
        expect(parseKeyword(`bing intentic`)?.url).toBe(`https://www.bing.com/search?q=intentic`);
        expect(parseKeyword(`k intentic`)?.url).toBe(`https://kagi.com/search?q=intentic`);
        expect(parseKeyword(`brave intentic`)?.url).toBe(`https://search.brave.com/search?q=intentic`);
    });

    test("the keyword is read whatever its case, the query as typed", () => {
        expect(parseKeyword(`  YT Lofi `)).toMatchObject({ query: `Lofi`, site: { keyword: `yt` } });
    });

    test("a keyword alone, an unknown word, or nothing after it is no keyword search", () => {
        expect(parseKeyword(`yt`)).toBeUndefined();
        expect(parseKeyword(`yt   `)).toBeUndefined();
        expect(parseKeyword(`ytx lofi`)).toBeUndefined();
        expect(parseKeyword(`how to yt`)).toBeUndefined();
        expect(parseKeyword(``)).toBeUndefined();
    });
});

describe("engines", () => {
    test("a search's address is the engine's, the query encoded", () => {
        expect(searchUrl(`brave`, `a&b c`)).toBe(`https://search.brave.com/search?q=a%26b%20c`);
    });

    test("a setting this build does not know falls back to Brave", () => {
        expect(engineOf(`kagi`)).toBe(`kagi`);
        expect(engineOf(`yandex`)).toBe(`brave`);
        expect(engineOf(undefined)).toBe(`brave`);
    });
});
