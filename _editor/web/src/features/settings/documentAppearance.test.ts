import "@intentic/testing/dom";
import { receivePreferenceChange } from "@intentic/ui/preference";
import { freshImport } from "@intentic/testing/bun";

// Never imports the settings page: calls installDocumentAppearance directly, mirroring main.ts, so a preference wired
// only into that page's import graph would fail here too.
const { installDocumentAppearance } = await import("./documentAppearance");

const root = () => document.documentElement;

// The skin reads storage and paints <html> as it is evaluated, so each case gets its own evaluation of it; the newest
// one is the one a change from another window reaches, since a preference holds the last that claimed its key. The
// scheme and text size stay the one instance per window, which is what those changes reach.
const boot = async (): Promise<void> => {
    await freshImport<typeof import("../../skins/useSkin")>("../../skins/useSkin", import.meta.url);
    installDocumentAppearance();
};

beforeEach(() => {
    localStorage.clear();
    root().removeAttribute(`data-skin`);
    root().removeAttribute(`data-mode`);
    root().removeAttribute(`data-text-size`);
});

describe(`installDocumentAppearance`, () => {
    it(`applies a stored skin`, async () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        await boot();

        // beforeEach strips the attribute, so it can only be back because useSkin read storage and wrote it —
        // this is not the anti-flash markup surviving.
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`makes a skin picked in another window land here`, async () => {
        await boot();
        receivePreferenceChange({ key: `ui-skin`, raw: `sanctum` });

        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`makes the scheme and the text size land here too`, async () => {
        await boot();
        receivePreferenceChange({ key: `ui-color-scheme`, raw: `dark` });
        receivePreferenceChange({ key: `ui-text-size`, raw: `large` });

        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
        expect(root().getAttribute(`data-text-size`)).toBe(`large`);
    });

    it(`drops a skin back to none when light or dark is chosen`, async () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        await boot();
        receivePreferenceChange({ key: `ui-skin`, raw: `none` });

        expect(root().hasAttribute(`data-skin`)).toBe(false);
    });

    // Cleared is not "off": the skin goes back to following the scheme, and sanctum is what the dark one wears.
    it(`hands a cleared skin back to the scheme rather than switching it off`, async () => {
        localStorage.setItem(`ui-skin`, `none`);
        await boot();
        receivePreferenceChange({ key: `ui-color-scheme`, raw: `dark` });
        receivePreferenceChange({ key: `ui-skin`, raw: null });

        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });
});
