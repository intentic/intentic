import { readFileSync } from "node:fs";
import { LOCAL_PLATFORM_ORIGIN, PLATFORM_ORIGIN_SLOT, withPlatformOrigin } from "./origin";

// The page as written, before vite.local.config.ts serves or builds it.
const PAGE = readFileSync(new URL(`../local.html`, import.meta.url), `utf8`);

// The platform address the page's window.env hands the editor (src/app/environments/environment.ts reads `api.url`).
const apiUrlsOf = (html: string): string[] => [...html.matchAll(/api:\s*\{\s*url:\s*"([^"]*)"\s*\}/g)].map(([, url = ``]) => url);

describe(`the platform stand-in's origin`, () => {
    it(`is an origin alone, as platform.ts compares it with a URL's, and one no resolver knows`, () => {
        const url = new URL(LOCAL_PLATFORM_ORIGIN);
        expect([url.origin, url.hostname.split(`.`).at(-1)]).toEqual([LOCAL_PLATFORM_ORIGIN, `invalid`]);
    });

    it(`is named in local.html by its slot, and nowhere spelled out`, () => {
        expect(apiUrlsOf(PAGE)).toEqual([PLATFORM_ORIGIN_SLOT]);
        expect(PAGE.split(LOCAL_PLATFORM_ORIGIN)).toHaveLength(1);
    });

    it(`fills the slot, leaving the rest of the page as it was`, () => {
        const served = withPlatformOrigin(PAGE);
        expect(apiUrlsOf(served)).toEqual([LOCAL_PLATFORM_ORIGIN]);
        expect(served.split(PLATFORM_ORIGIN_SLOT)).toHaveLength(1);
        expect(served.replace(LOCAL_PLATFORM_ORIGIN, PLATFORM_ORIGIN_SLOT)).toBe(PAGE);
    });
});
