import { describe, expect, it } from "vitest";
import { githubRepoOf, isShaPinned, resolveSource } from "./source.js";

const SHA = "9f2c1ab0d4e5f60718293a4b5c6d7e8f90a1b2c3";
const REGISTRY = "https://github.com/intentic/registry";

describe(`resolveSource`, () => {
    it(`reads a bare string as a path inside the registry repo, with pluginRoot prepended`, () => {
        expect(resolveSource(`./incidents`, REGISTRY, undefined)).toEqual({ url: REGISTRY, path: `incidents` });
        expect(resolveSource(`incidents`, REGISTRY, `./plugins/`)).toEqual({ url: REGISTRY, path: `plugins/incidents` });
    });

    it(`points a github source at the repo, preferring sha over ref`, () => {
        expect(resolveSource({ source: `github`, repo: `acme/incidents`, sha: SHA, ref: `main` }, REGISTRY, undefined)).toEqual({
            url: `https://github.com/acme/incidents.git`,
            ref: SHA,
        });
    });

    it(`carries url and git-subdir sources through`, () => {
        expect(resolveSource({ source: `url`, url: `https://gitlab.com/acme/x.git`, ref: SHA }, REGISTRY, undefined)).toEqual({
            url: `https://gitlab.com/acme/x.git`,
            ref: SHA,
        });
        expect(resolveSource({ source: `git-subdir`, url: `https://github.com/acme/tools.git`, path: `ext/a`, sha: SHA }, REGISTRY, undefined)).toEqual({
            url: `https://github.com/acme/tools.git`,
            path: `ext/a`,
            ref: SHA,
        });
    });

    // An unclonable source is a row we still show — undefined here becomes "not installable", not a dropped entry.
    it(`gives up on shapes it cannot clone rather than throwing`, () => {
        expect(resolveSource({ source: `npm`, package: `@acme/incidents` }, REGISTRY, undefined)).toBeUndefined();
        expect(resolveSource({ source: `github` }, REGISTRY, undefined)).toBeUndefined();
        expect(resolveSource(undefined, REGISTRY, undefined)).toBeUndefined();
        expect(resolveSource(null, REGISTRY, undefined)).toBeUndefined();
        expect(resolveSource(42, REGISTRY, undefined)).toBeUndefined();
    });
});

describe(`isShaPinned`, () => {
    it(`accepts only a full 40-character sha`, () => {
        expect(isShaPinned({ url: `x`, ref: SHA })).toBe(true);
        expect(isShaPinned({ url: `x`, ref: SHA.slice(0, 7) })).toBe(false);
        expect(isShaPinned({ url: `x`, ref: `main` })).toBe(false);
        expect(isShaPinned({ url: `x`, ref: SHA.toUpperCase() })).toBe(false);
        expect(isShaPinned({ url: `x` })).toBe(false);
        expect(isShaPinned(undefined)).toBe(false);
    });
});

describe(`githubRepoOf`, () => {
    it(`extracts owner/repo with or without the .git suffix, and only for github`, () => {
        expect(githubRepoOf({ url: `https://github.com/acme/incidents.git` })).toBe(`acme/incidents`);
        expect(githubRepoOf({ url: `https://github.com/acme/incidents` })).toBe(`acme/incidents`);
        expect(githubRepoOf({ url: `https://gitlab.com/acme/incidents.git` })).toBeUndefined();
        expect(githubRepoOf(undefined)).toBeUndefined();
    });
});
