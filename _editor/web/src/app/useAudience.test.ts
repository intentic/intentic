// Pins the words preference: the browser's copy only paints until the sandbox answers, the sandbox's answer is taken
// whole and never sent back, and a choice made here is worn at once and handed to the keeper. jsdom: definePreference
// writes to localStorage.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

// Re-imported fresh per test, since the subject is a module-scope singleton.
const load = () => freshImport<typeof import("./useAudience")>("./useAudience", import.meta.url);

beforeEach(() => {
    localStorage.clear();
});

describe(`useAudience`, () => {
    it(`reads as developer with nothing stored, following no sandbox yet`, async () => {
        const { useAudience } = await load();

        expect(useAudience().audience.value).toBe(`developer`);
        expect(useAudience().maker.value).toBe(false);
        expect(useAudience().mode.value).toBeUndefined();
        expect(useAudience().override.value).toBeUndefined();
    });

    it(`paints the words it was last told before any sandbox answers`, async () => {
        localStorage.setItem(`ui-audience`, `maker`);
        const { useAudience } = await load();

        expect(useAudience().maker.value).toBe(true);
    });

    it(`treats a stored value that is not an audience as developer`, async () => {
        localStorage.setItem(`ui-audience`, `wizard`);
        const { useAudience } = await load();

        expect(useAudience().audience.value).toBe(`developer`);
    });

    it(`takes the sandbox's answer whole and never sends it back`, async () => {
        const { adoptSandboxWords, keepAudienceWith, useAudience } = await load();
        const kept: (string | null)[] = [];
        keepAudienceWith((value) => kept.push(value));

        adoptSandboxWords({ audience: `maker`, mode: `hands-off` });

        expect(useAudience().audience.value).toBe(`maker`);
        expect(useAudience().mode.value).toBe(`hands-off`);
        expect(useAudience().override.value).toBeUndefined();
        expect(localStorage.getItem(`ui-audience`)).toBe(`maker`);
        expect(kept).toEqual([]);
    });

    it(`a choice made here is worn at once and reaches the keeper`, async () => {
        const { adoptSandboxWords, keepAudienceWith, useAudience } = await load();
        const kept: (string | null)[] = [];
        keepAudienceWith((value) => kept.push(value));
        adoptSandboxWords({ audience: `maker`, mode: `hands-off` });

        useAudience().setAudience(`developer`);

        expect(useAudience().audience.value).toBe(`developer`);
        expect(useAudience().override.value).toBe(`developer`);
        expect(kept).toEqual([`developer`]);
    });

    it(`following the sandbox again wears the words its mode speaks`, async () => {
        const { adoptSandboxWords, keepAudienceWith, useAudience } = await load();
        const kept: (string | null)[] = [];
        keepAudienceWith((value) => kept.push(value));
        adoptSandboxWords({ audience: `developer`, override: `developer`, mode: `hands-off` });

        useAudience().setAudience(null);

        expect(useAudience().audience.value).toBe(`maker`);
        expect(useAudience().override.value).toBeUndefined();
        expect(kept).toEqual([null]);
    });
});
