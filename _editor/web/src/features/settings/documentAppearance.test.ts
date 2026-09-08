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
    document.getElementById(`ui-skin-font`)?.remove();
    vi.resetModules();
});

describe(`installDocumentAppearance`, () => {
    it(`applies a stored skin, and the face that skin asks for`, async () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { installDocumentAppearance } = await boot();

        installDocumentAppearance();

        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
        // Only useSkin fetches the webfont; its presence proves useSkin ran, not just the anti-flash markup.
        expect(document.getElementById(`ui-skin-font`)).not.toBeNull();
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
        expect(document.getElementById(`ui-skin-font`)).toBeNull();
    });

    it(`falls back to the default skin when storage is cleared`, async () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { installDocumentAppearance } = await boot();
        const { receivePreferenceChange } = await seam();

        installDocumentAppearance();
        receivePreferenceChange({ key: `ui-skin`, raw: null });

        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
        expect(document.getElementById(`ui-skin-font`)).not.toBeNull();
    });
});
