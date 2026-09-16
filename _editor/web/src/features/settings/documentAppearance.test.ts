// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Never imports the settings page: calls installDocumentAppearance directly, mirroring main.ts, so a preference wired
// only into that page's import graph would fail here too.

const boot = () => import("./documentAppearance");
const seam = () => import("@intentic/ui/preference");

const root = () => document.documentElement;

beforeEach(() => {
    localStorage.clear();
    root().removeAttribute(`data-skin`);
    root().removeAttribute(`data-mode`);
    root().removeAttribute(`data-text-size`);
    vi.resetModules();
});

describe(`installDocumentAppearance`, () => {
    it(`applies a stored skin`, async () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { installDocumentAppearance } = await boot();

        installDocumentAppearance();

        // beforeEach strips the attribute, so it can only be back because useSkin read storage and wrote it —
        // this is not the anti-flash markup surviving.
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`makes a skin picked in another window land here`, async () => {
        const { installDocumentAppearance } = await boot();
        const { receivePreferenceChange } = await seam();

        installDocumentAppearance();
        receivePreferenceChange({ key: `ui-skin`, raw: `sanctum` });

        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`makes the scheme and the text size land here too`, async () => {
        const { installDocumentAppearance } = await boot();
        const { receivePreferenceChange } = await seam();

        installDocumentAppearance();
        receivePreferenceChange({ key: `ui-color-scheme`, raw: `dark` });
        receivePreferenceChange({ key: `ui-text-size`, raw: `large` });

        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
        expect(root().getAttribute(`data-text-size`)).toBe(`large`);
    });

    it(`drops a skin back to none when light or dark is chosen`, async () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { installDocumentAppearance } = await boot();
        const { receivePreferenceChange } = await seam();

        installDocumentAppearance();
        receivePreferenceChange({ key: `ui-skin`, raw: `none` });

        expect(root().hasAttribute(`data-skin`)).toBe(false);
    });

    // Cleared is not "off": the skin goes back to following the scheme, and sanctum is what the dark one wears.
    it(`hands a cleared skin back to the scheme rather than switching it off`, async () => {
        localStorage.setItem(`ui-skin`, `none`);
        const { installDocumentAppearance } = await boot();
        const { receivePreferenceChange } = await seam();

        installDocumentAppearance();
        receivePreferenceChange({ key: `ui-color-scheme`, raw: `dark` });
        receivePreferenceChange({ key: `ui-skin`, raw: null });

        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });
});
