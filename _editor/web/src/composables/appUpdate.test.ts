// @vitest-environment jsdom
//
// A DOM, because everything under test is about a document that has been open too long: the event the desktop
// app dispatches into the page, the visibility change that re-asks, and the `window` marker the app injects at
// load. None of the three has a meaning in a bare node context.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

/* THE BANNER'S TWO FAILURE MODES, and they are opposites.
 *
 * Never appearing is what this whole thing exists to fix: a workspace nobody reloads, running a build from
 * Monday on Friday, saying nothing about it.
 *
 * Appearing when it should not is worse, because the button it draws reloads a page. Every case below where
 * the answer is "no banner" is one where a naive implementation shows one anyway: a dev server whose id is the
 * string `dev`, a `build.json` that 404s on a build predating it, a body that is not what we expect, an origin
 * that is offline. */

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
    // Assigned on the real `window` rather than stubbed over it: this is exactly what the app's own
    // initialization script does (desktop-app windows.rs), and replacing the whole object would take
    // vitest.setup.ts's `window.env` with it — which every module in the import graph reads at load.
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
        // The overwhelmingly common answer, and the one that must cost nothing.
        const { isStaleBuild } = await import(`./appUpdate`);
        expect(isStaleBuild(`1730000000000`, `1730000000000`)).toBe(false);
    });

    it(`treats a rollback as staleness, not just a newer build`, async () => {
        const { isStaleBuild } = await import(`./appUpdate`);
        // Ids are build stamps, and "different" is the honest comparison: a tab running the version that was
        // just PULLED is exactly as wrong as one running a version that is too old, and a `>` here would leave
        // everybody on the bad build with nothing on screen.
        expect(isStaleBuild(`1730000000000`, `1720000000000`)).toBe(true);
        expect(isStaleBuild(`1720000000000`, `1730000000000`)).toBe(true);
    });

    it(`never fires against a dev build on either side`, async () => {
        const { isStaleBuild } = await import(`./appUpdate`);
        // A dev server reports `dev` for every session, so a plain inequality would put a permanent "reload"
        // banner in front of everybody working on this app.
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

    /* THE DESKTOP HALF, in the ordering that used to be impossible to serve: the app finished downloading
     * BEFORE this page loaded, so there is no event coming and the only evidence is the marker the app injects
     * at load. Without reading it the banner would appear on a reload — on the one screen that is never
     * reloaded. */
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

    /* ONE OFFER FOR ONE RESTART. Restarting the app reloads this webview onto whatever is deployed, so a stale
     * page inside an app that is itself stale is one problem. Drawn as two, the user would take the restart
     * and come back to a banner about the thing the restart just fixed. */
    it(`lets an app restart stand in for a page reload rather than offering both`, async () => {
        const { useAppUpdate } = await load({ running: `1720000000000`, deployed: { buildId: `1730000000000` }, desktopUpdate: `1.214.0` });
        const { offer } = useAppUpdate();
        await settled();
        expect(offer.value).toEqual({ kind: `app`, version: `1.214.0` });
    });

    /* "NOT NOW" MEANS NOT NOW. It covers the offer that was on screen and nothing else — the next build is a
     * different thing to decide about, and a dismissal that outlived it would silently turn the banner off for
     * the rest of the session. */
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
