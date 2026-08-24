// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/* THE WINDOW THAT NEVER OPENED THE SETTINGS PAGE.
 *
 * A popped-out panel is a whole other window of the app (composables/floating.ts), and its route mounts one
 * panel: it has no reason to import the settings page, and so it used to have no reason to import `useSkin` or
 * `useImportedTheme` either, since those were reachable from there and (for the theme) from `useMonaco`. The
 * result was not a setting that lagged, it was a setting that did not exist in that window: nothing applied the
 * stored value and nothing was registered to hear it change. The skin still LOOKED right, because index.html's
 * anti-flash script writes `data-skin` from storage on every load, which is what made this read as "themes don't
 * sync" rather than as "the skin was never installed here".
 *
 * So these tests never import the settings page. They do what main.ts does, and nothing else. */

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
        localStorage.setItem(`ui-skin`, `hud`);
        const { installDocumentAppearance } = await boot();

        installDocumentAppearance();

        expect(root().getAttribute(`data-skin`)).toBe(`hud`);
        // The webfont is part of the look and only `useSkin` fetches it, so a window that never loaded it drew
        // the skin in the app's own stack. This is the half the anti-flash script cannot do.
        expect(document.getElementById(`ui-skin-font`)).not.toBeNull();
    });

    it(`makes a skin picked in another window land here`, async () => {
        const { installDocumentAppearance } = await boot();
        const { receivePreferenceChange } = await seam();

        installDocumentAppearance();
        // What the settings page's Theme row writes, arriving from the window it was pressed in.
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

    it(`drops a skin back to none, attribute and face together`, async () => {
        localStorage.setItem(`ui-skin`, `hud`);
        const { installDocumentAppearance } = await boot();
        const { receivePreferenceChange } = await seam();

        installDocumentAppearance();
        // Picking Light or Dark in the Theme row is `setSkin('none')`, which stores nothing for this key.
        receivePreferenceChange({ key: `ui-skin`, raw: null });

        expect(root().hasAttribute(`data-skin`)).toBe(false);
        expect(document.getElementById(`ui-skin-font`)).toBeNull();
    });

    it(`lands an imported VSCode theme's chrome tokens`, async () => {
        const { installDocumentAppearance } = await boot();
        const { receivePreferenceChange } = await seam();

        installDocumentAppearance();
        const theme = { name: `Night`, mode: `dark`, tokens: { "--color-canvas": `#101014` }, raw: {}, shikiName: `imported-1` };
        receivePreferenceChange({ key: `ui-imported-theme`, raw: JSON.stringify(theme) });

        expect(root().style.getPropertyValue(`--color-canvas`)).toBe(`#101014`);
    });
});
