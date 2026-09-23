// Pins the audience preference's reading of storage: unset and unknown both read as developer, and only an answer
// marks the question as asked. jsdom: definePreference writes to localStorage.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

// Re-imported fresh per test, since the subject is a module-scope singleton.
const load = () => freshImport<typeof import("./useAudience")>("./useAudience", import.meta.url);

beforeEach(() => {
    localStorage.clear();
});

describe(`useAudience`, () => {
    it(`reads as developer and unanswered with nothing stored`, async () => {
        const { useAudience } = await load();

        expect(useAudience().audience.value).toBe(`developer`);
        expect(useAudience().maker.value).toBe(false);
        expect(useAudience().chosen.value).toBe(false);
    });

    it(`restores a stored answer as answered`, async () => {
        localStorage.setItem(`ui-audience`, `maker`);
        const { useAudience } = await load();

        expect(useAudience().audience.value).toBe(`maker`);
        expect(useAudience().maker.value).toBe(true);
        expect(useAudience().chosen.value).toBe(true);
    });

    it(`treats a stored value that is not an audience as unanswered`, async () => {
        localStorage.setItem(`ui-audience`, `wizard`);
        const { useAudience } = await load();

        expect(useAudience().audience.value).toBe(`developer`);
        expect(useAudience().chosen.value).toBe(false);
    });

    it(`answering stores the value and marks the question asked`, async () => {
        const { useAudience } = await load();

        useAudience().setAudience(`maker`);

        expect(localStorage.getItem(`ui-audience`)).toBe(`maker`);
        expect(useAudience().maker.value).toBe(true);
        expect(useAudience().chosen.value).toBe(true);
    });
});
