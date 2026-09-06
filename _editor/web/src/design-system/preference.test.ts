// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/* WHAT THIS PINS IS THE DEFECT THE PRIMITIVE EXISTS FOR: a popped-out panel is a whole other window of the app,
 * with its own modules and its own <html>, so a setting changed on /settings/appearance repainted the window the
 * reader was in and nothing else. There was no shared notion of "an account preference" at all, each composable
 * owned its own read, its own write and its own apply, and cross-window propagation had been solved once, by
 * hand, for one key.
 *
 * So the tests speak in the two things that cross a window boundary:
 *   · a note ARRIVING (`receivePreferenceChange`), which is what the popped-out window sees. The seam is the same
 *     one the channel and the browser's `storage` event both come through, so what a test hands over and what a
 *     real second window sends travel the identical path.
 *   · a CHOICE made here, which must persist and must NOT be re-persisted when it was somebody else's choice
 *     being adopted. That last one is the whole reason the two directions are told apart: `read` normalizes, so a
 *     window echoing its own reading back would overwrite the answer it was just given. */

const load = () => import("@intentic/ui/preference");

beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
});

describe(`a choice made in this window`, () => {
    it(`applies, persists, and reads back`, async () => {
        const { definePreference } = await load();
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

    it(`applies synchronously, so no frame is drawn in the old theme`, async () => {
        const { definePreference } = await load();
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

    it(`removes the key when the value writes as null`, async () => {
        const { definePreference } = await load();
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
    it(`lands on the ref and on the DOM`, async () => {
        const { definePreference, receivePreferenceChange } = await load();
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

    it(`is adopted rather than written back, so this window cannot overwrite what it was told`, async () => {
        const { definePreference, receivePreferenceChange } = await load();
        /* The clamp stands in for every `read` that NORMALIZES: a column width bounded by this window's own
         * viewport, an unknown value falling back to a default. A window that echoed its reading back would
         * ratchet the wide window's column down to fit a screen it isn't on. */
        const width = definePreference<number>({
            key: `ui-width`,
            read: (raw) => Math.min(400, Number.parseInt(raw ?? `400`, 10)),
            write: String,
        });

        receivePreferenceChange({ key: `ui-width`, raw: `2000` });

        expect(width.value).toBe(400); // this window shows what it can hold…
        expect(localStorage.getItem(`ui-width`)).toBeNull(); // …and did not write its own reading over the stored 2000
    });

    it(`ignores a key no preference here holds`, async () => {
        const { definePreference, receivePreferenceChange } = await load();
        const nesting = definePreference<boolean>({ key: `ui-file-nesting`, read: (raw) => raw !== `off`, write: (v) => (v ? `on` : `off`) });

        // A window's own view state, which windowStore.ts namespaces away from preferences precisely so that
        // syncing the one can never move the other.
        receivePreferenceChange({ key: `intentic.terminalOpen.local`, raw: `1` });

        expect(nesting.value).toBe(true);
    });

    it(`takes every preference back to what it reads with nothing stored, when the whole store went`, async () => {
        const { definePreference, receivePreferenceChange } = await load();
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
    it(`still holds the reader's choice for the life of the window`, async () => {
        const { definePreference } = await load();
        // Private mode / disabled site data, where merely touching the store throws.
        const boom = (): never => {
            throw new Error(`site data is off`);
        };
        vi.spyOn(Storage.prototype, `getItem`).mockImplementation(boom);
        vi.spyOn(Storage.prototype, `setItem`).mockImplementation(boom);

        const size = definePreference<string>({ key: `ui-size`, read: (raw) => raw ?? `compact`, write: (value) => value });
        size.value = `large`;

        expect(size.value).toBe(`large`);
        vi.restoreAllMocks();
    });
});
