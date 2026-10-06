import "@intentic/testing/dom";
import { boolPreference, definePreference, enumPreference, numberPreference, receivePreferenceChange, textPreference } from "@intentic/ui/preference";

// Pins the defect this primitive exists for: a popped-out panel is a whole other window with its own modules and
// `<html>`, so a setting change on one window used to repaint only that window. There was no shared "account
// preference": each composable owned its own read, write and apply, and cross-window propagation had been solved once,
// by hand, for one key.
//
// Tests speak in the two things that cross a window boundary: a note arriving (`receivePreferenceChange`, the same seam
// the channel and the browser's `storage` event both use), and a choice made here, which must persist but must not be
// re-persisted when it was somebody else's choice being adopted (since `read` normalizes, and echoing a reading back
// would overwrite the value a window was just given).

beforeEach(() => {
    localStorage.clear();
});

describe(`a choice made in this window`, () => {
    it(`applies, persists, and reads back`, () => {
        const applied: string[] = [];
        const size = definePreference<string>({
            key: `ui-size`,
            read: (raw) => raw ?? `compact`,
            write: (value) => value,
            apply: (v) => applied.push(v),
        });

        size.value = `large`;

        expect(size.value).toBe(`large`);
        expect(localStorage.getItem(`ui-size`)).toBe(`large`);
        // Once for the stored value at load, once for the change: the DOM side runs for both.
        expect(applied).toEqual([`compact`, `large`]);
    });

    it(`applies synchronously, so no frame is drawn in the old theme`, () => {
        let attribute: string | undefined;
        const scheme = definePreference<string>({
            key: `ui-scheme`,
            read: (raw) => raw ?? `light`,
            write: (value) => value,
            apply: (value) => {
                attribute = value;
            },
        });

        scheme.value = `dark`;

        // No `await nextTick()`: an attribute on <html> arriving a render late is a frame of the old look.
        expect(attribute).toBe(`dark`);
    });

    it(`removes the key when the value writes as null`, () => {
        localStorage.setItem(`ui-imported`, `something`);
        const imported = definePreference<string | undefined>({
            key: `ui-imported`,
            read: (raw) => raw ?? undefined,
            write: (value) => value ?? null,
        });

        imported.value = undefined;

        expect(localStorage.getItem(`ui-imported`)).toBeNull();
    });
});

describe(`a change made in another window`, () => {
    it(`lands on the ref and on the DOM`, () => {
        const applied: string[] = [];
        const skin = definePreference<string>({
            key: `ui-skin`,
            read: (raw) => raw ?? `none`,
            write: (value) => value,
            apply: (v) => applied.push(v),
        });

        receivePreferenceChange({ key: `ui-skin`, raw: `sanctum` });

        expect(skin.value).toBe(`sanctum`);
        expect(applied).toEqual([`none`, `sanctum`]);
    });

    it(`is adopted rather than written back, so this window cannot overwrite what it was told`, () => {
        // The clamp stands in for every `read` that normalizes, such as a column width bounded by this window's own
        // viewport. A window that echoed its reading back would ratchet a wide window's column down to fit a screen it
        // isn't on.
        const width = definePreference<number>({
            key: `ui-width`,
            read: (raw) => Math.min(400, Number.parseInt(raw ?? `400`, 10)),
            write: String,
        });

        receivePreferenceChange({ key: `ui-width`, raw: `2000` });

        expect(width.value).toBe(400); // This window shows what it can hold…
        expect(localStorage.getItem(`ui-width`)).toBeNull(); // …and did not write its own reading over the stored value.
    });

    it(`ignores a key no preference here holds`, () => {
        const nesting = definePreference<boolean>({ key: `ui-file-nesting`, read: (raw) => raw !== `off`, write: (v) => (v ? `on` : `off`) });

        // A window's own view state, namespaced away from preferences (windowStore.ts) precisely so that syncing one
        // can never move the other.
        receivePreferenceChange({ key: `intentic.terminalOpen.local`, raw: `1` });

        expect(nesting.value).toBe(true);
    });

    it(`takes every preference back to what it reads with nothing stored, when the whole store went`, () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        localStorage.setItem(`ui-text-size`, `large`);
        const skin = definePreference<string>({ key: `ui-skin`, read: (raw) => raw ?? `none`, write: (value) => value });
        const textSize = definePreference<string>({ key: `ui-text-size`, read: (raw) => raw ?? `compact`, write: (value) => value });

        // What `localStorage.clear()` reports, and what the self-heal path produces.
        receivePreferenceChange({ key: null, raw: null });

        expect(skin.value).toBe(`none`);
        expect(textSize.value).toBe(`compact`);
    });
});

describe(`storage that is not there at all`, () => {
    it(`still holds the reader's choice for the life of the window`, () => {
        // Private mode / disabled site data, where merely touching the store throws.
        const boom = (): never => {
            throw new Error(`site data is off`);
        };
        jest.spyOn(Storage.prototype, `getItem`).mockImplementation(boom);
        jest.spyOn(Storage.prototype, `setItem`).mockImplementation(boom);

        const size = definePreference<string>({ key: `ui-size`, read: (raw) => raw ?? `compact`, write: (value) => value });
        size.value = `large`;

        expect(size.value).toBe(`large`);
        jest.restoreAllMocks();
    });
});

// The shapes nearly every preference takes: what a stored string means, said once in the kit instead of per caller.
describe(`the shaped preferences`, () => {
    it(`an on/off reads its fallback only while unset, and only the exact 1 it writes as on`, () => {
        expect([boolPreference(`ui-b-unset`).value, boolPreference(`ui-b-unset-on`, true).value]).toEqual([false, true]);
        localStorage.setItem(`ui-b-off`, `0`);
        localStorage.setItem(`ui-b-junk`, `yes`);
        expect([boolPreference(`ui-b-off`, true).value, boolPreference(`ui-b-junk`, true).value]).toEqual([false, false]);
        const on = boolPreference(`ui-b-write`);
        on.value = true;
        expect(localStorage.getItem(`ui-b-write`)).toBe(`1`);
    });

    it(`a choice reads anything it does not list as its fallback`, () => {
        localStorage.setItem(`ui-e`, `middle`);
        expect(enumPreference(`ui-e`, [`left`, `right`] as const, `left`).value).toBe(`left`);
        localStorage.setItem(`ui-e`, `right`);
        expect(enumPreference(`ui-e`, [`left`, `right`] as const, `left`).value).toBe(`right`);
    });

    it(`a number is clamped on reading, falls back when unreadable, and is not written back clamped`, () => {
        const clamp = (px: number): number => Math.min(px, 500);
        localStorage.setItem(`ui-n`, `900`);
        expect(numberPreference(`ui-n`, clamp, () => 300).value).toBe(500);
        expect(localStorage.getItem(`ui-n`)).toBe(`900`);
        localStorage.setItem(`ui-n`, `wide`);
        expect(numberPreference(`ui-n`, clamp, () => 300).value).toBe(300);
    });

    it(`text reads unset as empty`, () => {
        expect(textPreference(`ui-t`).value).toBe(``);
    });

    it(`each follows a change made in another window`, () => {
        const width = numberPreference(`ui-n-shared`, (px) => px, () => 300);
        receivePreferenceChange({ key: `ui-n-shared`, raw: `420` });
        expect(width.value).toBe(420);
    });
});
