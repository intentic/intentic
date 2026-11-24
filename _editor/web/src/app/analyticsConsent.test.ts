import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { asksFirstIn, choiceWithNothingStored, refusesTracking } from "./analyticsConsent";

// Who is asked before anything is recorded: the EEA, the UK and Switzerland by their browser's time zone, erring
// towards asking.
describe(`asksFirstIn`, () => {
    it(`asks a browser in a European zone, including the EEA's zones outside Europe/`, () => {
        for (const zone of [`Europe/Warsaw`, `Europe/London`, `Europe/Zurich`, `Asia/Nicosia`, `Atlantic/Canary`, `Indian/Reunion`]) {
            expect(asksFirstIn(zone)).toBe(true);
        }
    });

    it(`does not ask a browser elsewhere`, () => {
        for (const zone of [`America/New_York`, `Asia/Tokyo`, `UTC`, `Australia/Sydney`]) {
            expect(asksFirstIn(zone)).toBe(false);
        }
    });

    it(`does not ask when there is no zone to read here (the caller treats that as asking)`, () => {
        expect(asksFirstIn(undefined)).toBe(false);
    });
});

// A browser that says no before it is asked (Global Privacy Control, Do Not Track) is a no wherever it is.
describe(`refusesTracking`, () => {
    it(`hears Global Privacy Control and Do Not Track, and nothing weaker`, () => {
        expect(refusesTracking({ globalPrivacyControl: true })).toBe(true);
        expect(refusesTracking({ doNotTrack: `1` })).toBe(true);
        expect(refusesTracking({ globalPrivacyControl: false, doNotTrack: `0` })).toBe(false);
        expect(refusesTracking({ doNotTrack: `unspecified` })).toBe(false);
        expect(refusesTracking({ doNotTrack: null })).toBe(false);
        expect(refusesTracking({})).toBe(false);
        expect(refusesTracking(undefined)).toBe(false);
    });
});

describe(`choiceWithNothingStored`, () => {
    it(`reads a refusing browser as a no, in Europe and elsewhere alike`, () => {
        expect(choiceWithNothingStored(`Europe/Berlin`, true)).toBe(`deny`);
        expect(choiceWithNothingStored(`America/Los_Angeles`, true)).toBe(`deny`);
        expect(choiceWithNothingStored(undefined, true)).toBe(`deny`);
    });

    it(`asks in the EEA, the UK, Switzerland and where no zone can be read, and allows elsewhere`, () => {
        expect(choiceWithNothingStored(`Europe/Berlin`, false)).toBe(`unasked`);
        expect(choiceWithNothingStored(`Atlantic/Madeira`, false)).toBe(`unasked`);
        expect(choiceWithNothingStored(undefined, false)).toBe(`unasked`);
        expect(choiceWithNothingStored(`America/Los_Angeles`, false)).toBe(`allow`);
    });
});

// The same rule as the page reads it at load: the browser's own signal, and what this browser stored before.
describe(`analyticsChoice`, () => {
    const KEY = `intentic-product-analytics-consent`;
    const storage = (items: Record<string, string>) => {
        const held = new Map(Object.entries(items));
        stubGlobal(`localStorage`, {
            getItem: (key: string) => held.get(key) ?? null,
            setItem: (key: string, value: string) => held.set(key, value),
            removeItem: (key: string) => held.delete(key),
        });
    };
    const load = async (signals: { globalPrivacyControl?: boolean; doNotTrack?: string | null }, stored: Record<string, string> = {}) => {
        stubGlobal(`navigator`, signals);
        storage(stored);
        return (await freshImport<typeof import("./analyticsConsent")>(`./analyticsConsent`, import.meta.url)).analyticsChoice.value;
    };

    afterEach(() => {
        unstubAllGlobals();
    });

    it(`starts switched off, without asking, in a browser with Global Privacy Control or Do Not Track on`, async () => {
        expect(await load({ globalPrivacyControl: true })).toBe(`deny`);
        expect(await load({ doNotTrack: `1` })).toBe(`deny`);
    });

    it(`starts on in a browser that sends neither, outside Europe`, async () => {
        expect(await load({ globalPrivacyControl: false, doNotTrack: null })).toBe(`allow`);
    });

    // Switching it on under Settings, Data is the person's own later answer for this site, and outranks the signal.
    it(`keeps an allow this browser stored, whatever the browser signals`, async () => {
        expect(await load({ globalPrivacyControl: true }, { [KEY]: `allow` })).toBe(`allow`);
        expect(await load({ globalPrivacyControl: false }, { [KEY]: `deny` })).toBe(`deny`);
    });
});
