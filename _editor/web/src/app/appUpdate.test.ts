// DOM: the desktop app's update event, the visibility-change re-ask, and the `window` marker it injects at load are
// all meaningless in a bare node context.
import "@intentic/testing/dom";
import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
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
    stubGlobal(`fetch`, () =>
        Promise.resolve({
            ok: options.ok ?? true,
            json: () => Promise.resolve(options.deployed),
        }),
    );
    // Assigned on the real `window`, not stubbed over: replacing the object would also drop bun.setup.ts's
    // `window.env`, which every module in the import graph reads at load.
    window.__INTENTIC_DESKTOP__ =
        options.desktopUpdate === undefined ? undefined : { version: `1.0.0`, installId: `id`, update: options.desktopUpdate };
    jest.mock(`./buildEpoch`, () => ({ buildId: () => options.running, dropOutdatedMirrors: () => undefined }));
    return await freshImport<typeof import("./appUpdate")>("./appUpdate", import.meta.url);
};

/** The poll is fired from `useAppUpdate`; give the fetch and its two awaits a turn to settle. */
const settled = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
};

beforeEach(() => {
    unstubAllGlobals();
    jest.restoreAllMocks();
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

// A grammar, a viewer or a diagram that failed to fetch: the module is remembered as failed for the life of the
// document, so the file the reader has open stays plain however often they reopen it. Only a reload repairs it, and
// this is the one place that offers one.
describe(`an incomplete bundle`, () => {
    it(`offers the repair even though this page is running what is deployed`, async () => {
        const { useAppUpdate, reportIncompleteBundle } = await load({ running: `1730000000000`, deployed: { buildId: `1730000000000` } });
        const { offer } = useAppUpdate();
        await settled();
        expect(offer.value).toBeUndefined();

        reportIncompleteBundle();
        await nextTick();
        expect(offer.value).toEqual({ kind: `incomplete` });
    });

    it(`does not talk over an update, which asks for the same click with a reason behind it`, async () => {
        const { useAppUpdate, reportIncompleteBundle } = await load({ running: `1720000000000`, deployed: { buildId: `1730000000000` } });
        const { offer } = useAppUpdate();
        await settled();

        reportIncompleteBundle();
        await nextTick();
        expect(offer.value).toEqual({ kind: `web` });
    });

    // Dismissing one cause must not silence the other: they are different things to decide about.
    it(`keeps its dismissal apart from a deployed build's`, async () => {
        const { useAppUpdate, reportIncompleteBundle } = await load({ running: `1730000000000`, deployed: { buildId: `1730000000000` } });
        const { offer, dismiss } = useAppUpdate();
        await settled();
        reportIncompleteBundle();
        await nextTick();
        dismiss();
        await nextTick();
        expect(offer.value).toBeUndefined();

        window.dispatchEvent(new CustomEvent(`intentic-desktop-update`, { detail: { version: `1.214.0` } }));
        await nextTick();
        expect(offer.value).toEqual({ kind: `app`, version: `1.214.0` });
    });
});
