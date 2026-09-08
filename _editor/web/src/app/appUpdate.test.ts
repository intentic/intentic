// @vitest-environment jsdom
// DOM: the desktop app's update event, the visibility-change re-ask, and the `window` marker it injects at load are
// all meaningless in a bare node context.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

// Two failure modes: never appearing defeats the point (a stale workspace nobody reloads); appearing wrongly is
// worse, since the button it draws reloads the page. Every "no banner" case below is one a naive implementation
// gets wrong (a dev id, a missing build.json, an unexpected body, an offline origin).

/** A fresh module graph per test: the offer is module state (there is one app, so there is one offer). */
const load = async (options: {
    readonly running: string;
    readonly deployed?: unknown;
    readonly ok?: boolean;
    readonly desktopUpdate?: string | null;
}) => {
    vi.resetModules();
    vi.stubGlobal(`fetch`, () =>
        Promise.resolve({
            ok: options.ok ?? true,
            json: () => Promise.resolve(options.deployed),
        }),
    );
    // Assigned on the real `window`, not stubbed over: replacing the object would also drop vitest.setup.ts's
    // `window.env`, which every module in the import graph reads at load.
    window.__INTENTIC_DESKTOP__ =
        options.desktopUpdate === undefined ? undefined : { version: `1.0.0`, installId: `id`, update: options.desktopUpdate };
    vi.doMock(`./buildEpoch`, () => ({ buildId: () => options.running, dropOutdatedMirrors: () => undefined }));
    return await import(`./appUpdate`);
};

/** The poll is fired from `useAppUpdate`; give the fetch and its two awaits a turn to settle. */
const settled = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
};

beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe(`isStaleBuild`, () => {
    it(`says nothing at all when the two ids match`, async () => {
        // The common case; must stay cheap.
        const { isStaleBuild } = await import(`./appUpdate`);
        expect(isStaleBuild(`1730000000000`, `1730000000000`)).toBe(false);
    });

    it(`treats a rollback as staleness, not just a newer build`, async () => {
        const { isStaleBuild } = await import(`./appUpdate`);
        // Ids are build stamps; "different" is the correct comparison; a rollback is exactly as stale as a newer build,
        // and `>` would miss it.
        expect(isStaleBuild(`1730000000000`, `1720000000000`)).toBe(true);
        expect(isStaleBuild(`1720000000000`, `1730000000000`)).toBe(true);
    });

    it(`never fires against a dev build on either side`, async () => {
        const { isStaleBuild } = await import(`./appUpdate`);
        // A dev server reports `dev` for every session; plain inequality would show a permanent reload banner to every
        // developer.
        expect(isStaleBuild(`dev`, `1730000000000`)).toBe(false);
        expect(isStaleBuild(`1730000000000`, `dev`)).toBe(false);
        expect(isStaleBuild(`dev`, `dev`)).toBe(false);
    });

    it(`says nothing when the origin could not answer`, async () => {
        const { isStaleBuild } = await import(`./appUpdate`);
        // Offline, mid-deploy, or a build that predates the stamp: absence of an answer is not evidence.
        expect(isStaleBuild(`1730000000000`, undefined)).toBe(false);
    });
});

describe(`the offer`, () => {
    it(`offers a reload when the deploy has moved under this tab`, async () => {
        const { useAppUpdate } = await load({ running: `1720000000000`, deployed: { buildId: `1730000000000` } });
        const { offer } = useAppUpdate();
        await settled();
        expect(offer.value).toEqual({ kind: `web` });
    });

    it(`stays silent on a build.json that is missing or malformed`, async () => {
        const missing = await load({ running: `1720000000000`, deployed: undefined, ok: false });
        missing.useAppUpdate();
        await settled();
        expect(missing.useAppUpdate().offer.value).toBeUndefined();

        // A body that parsed but is not what this asked for — an index.html served by the SPA fallback, say.
        const wrong = await load({ running: `1720000000000`, deployed: { nothing: true } });
        wrong.useAppUpdate();
        await settled();
        expect(wrong.useAppUpdate().offer.value).toBeUndefined();
    });

    // The app finished downloading before this page loaded, so there's no event, only the marker it injects at load.
    // Without reading it, the banner would appear on a reload, the one screen that's never reloaded.
    it(`reads an update the app had already downloaded before this page loaded`, async () => {
        const { useAppUpdate } = await load({ running: `1730000000000`, deployed: { buildId: `1730000000000` }, desktopUpdate: `1.214.0` });
        const { offer } = useAppUpdate();
        await settled();
        expect(offer.value).toEqual({ kind: `app`, version: `1.214.0` });
    });

    it(`hears an update that finished while this page was open`, async () => {
        const { useAppUpdate } = await load({ running: `1730000000000`, deployed: { buildId: `1730000000000` }, desktopUpdate: null });
        const { offer } = useAppUpdate();
        await settled();
        expect(offer.value).toBeUndefined();

        window.dispatchEvent(new CustomEvent(`intentic-desktop-update`, { detail: { version: `1.214.0` } }));
        await nextTick();
        expect(offer.value).toEqual({ kind: `app`, version: `1.214.0` });
    });

    // One offer per restart: restarting the app also reloads this page onto whatever's deployed, so a stale page and a
    // stale app are one problem, not two banners.
    it(`lets an app restart stand in for a page reload rather than offering both`, async () => {
        const { useAppUpdate } = await load({ running: `1720000000000`, deployed: { buildId: `1730000000000` }, desktopUpdate: `1.214.0` });
        const { offer } = useAppUpdate();
        await settled();
        expect(offer.value).toEqual({ kind: `app`, version: `1.214.0` });
    });

    // A dismissal covers only the offer on screen; the next build is a different thing to decide about, so it must not
    // silently disable the banner for the rest of the session.
    it(`forgets a dismissal as soon as a newer build is on the table`, async () => {
        const { useAppUpdate } = await load({ running: `1730000000000`, deployed: { buildId: `1730000000000` }, desktopUpdate: null });
        const { offer, dismiss } = useAppUpdate();
        window.dispatchEvent(new CustomEvent(`intentic-desktop-update`, { detail: { version: `1.214.0` } }));
        await nextTick();
        dismiss();
        await nextTick();
        expect(offer.value).toBeUndefined();

        window.dispatchEvent(new CustomEvent(`intentic-desktop-update`, { detail: { version: `1.215.0` } }));
        await nextTick();
        expect(offer.value).toEqual({ kind: `app`, version: `1.215.0` });
    });
});
