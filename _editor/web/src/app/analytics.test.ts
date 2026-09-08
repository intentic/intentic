import type { User } from "@intentic/api-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

// Plain ref stands in for useAuth's module singleton; the mock closure keeps re-imported analytics modules
// (vi.resetModules per test) watching the same instance.
const user = ref<User | null>(null);
vi.mock("../features/auth/useAuth", () => ({ useAuth: () => ({ user }) }));
vi.mock("posthog-js", () => ({
    default: { init: vi.fn(), identify: vi.fn(), reset: vi.fn(), capture: vi.fn(), register: vi.fn() },
}));

// `desktop` stands in for the app's init script (windows.rs), the only signal that tells this SPA it's running in
// the desktop app rather than a browser tab.
const bootAnalytics = async (posthogKey: string, desktop?: { version: string; installId: string; update: string | null }) => {
    vi.resetModules();
    vi.stubGlobal(`window`, {
        env: { analytics: { posthogKey, posthogHost: `https://app.intentic.dev/wire` } },
        ...(desktop !== undefined ? { __INTENTIC_DESKTOP__: desktop } : {}),
    });
    const posthog = (await import(`posthog-js`)).default;
    const analytics = await import(`./analytics`);
    analytics.initAnalytics();
    return { posthog, analytics };
};

beforeEach(() => {
    // The posthog-js mock instance is shared across vi.resetModules boots: drop the previous test's calls.
    vi.clearAllMocks();
    user.value = null;
});

describe(`initAnalytics`, () => {
    it(`stays inert without a key (dev) or with an unsubstituted envsubst placeholder`, async () => {
        const { posthog: empty } = await bootAnalytics(``);
        const { posthog: literal } = await bootAnalytics(`$POSTHOG_KEY`);
        expect(empty.init).not.toHaveBeenCalled();
        expect(literal.init).not.toHaveBeenCalled();
    });

    it(`identifies on session resolve and resets on sign-out`, async () => {
        const { posthog } = await bootAnalytics(`phc_test`);
        // Proxied `api_host` keeps replay alive past an ad blocker; `sessionStorage` keeps one visit as one recording
        // across reloads.
        expect(posthog.init).toHaveBeenCalledWith(
            `phc_test`,
            expect.objectContaining({ api_host: `https://app.intentic.dev/wire`, persistence: `sessionStorage` }),
        );

        user.value = { id: `u1`, email: `a@b.c`, name: `A`, image: null };
        await nextTick();
        expect(posthog.identify).toHaveBeenCalledWith(`u1`, { email: `a@b.c`, name: `A` });

        user.value = null;
        await nextTick();
        expect(posthog.reset).toHaveBeenCalledTimes(1);
    });

    // Without a client tag, the desktop app (which loads this SPA) and a browser tab look like the same row, broken
    // down by user agent instead. The install id joins this to what the app's own screens report.
    it(`tags every event with the client, and names the app when it is running inside one`, async () => {
        const { posthog: browser } = await bootAnalytics(`phc_test`);
        expect(browser.register).toHaveBeenCalledWith({ client: `browser` });

        const { posthog: app } = await bootAnalytics(`phc_test`, { version: `1.15.1`, installId: `install-abc`, update: null });
        expect(app.register).toHaveBeenCalledWith({ client: `desktop`, desktop_version: `1.15.1`, desktop_install_id: `install-abc` });
    });

    // `reset()` empties the store super properties live in, so without re-registering, every event after a sign-out
    // would lose its client tag, on desktop exactly the sessions this exists to count.
    it(`says which client it is again after a sign-out has cleared it`, async () => {
        const { posthog } = await bootAnalytics(`phc_test`, { version: `1.15.1`, installId: `install-abc`, update: null });
        user.value = { id: `u1`, email: `a@b.c`, name: `A`, image: null };
        await nextTick();
        // Counted, not asserted outright: `user` is a module singleton, so every boot in this file leaves a live
        // watcher
        // that a sign-out here also triggers.
        const said = vi.mocked(posthog.register).mock.calls.length;

        user.value = null;
        await nextTick();

        expect(vi.mocked(posthog.register).mock.calls.length).toBeGreaterThan(said);
        expect(vi.mocked(posthog.register).mock.calls.at(-1)).toEqual([
            { client: `desktop`, desktop_version: `1.15.1`, desktop_install_id: `install-abc` },
        ]);
    });

    // EasyPrivacy blocks bare `/posthog-recorder.js` and `/dead-clicks-autocapture.js` on any host, so proxying alone
    // still loses replay to Brave/uBlock; the `sdk.` prefix misses those rules, and nginx.conf strips it back off.
    it(`prefixes SDK script filenames so filename-anchored blocker rules miss them`, async () => {
        const { posthog } = await bootAnalytics(`phc_test`);
        const { prepare_external_dependency_script: prepare } = vi.mocked(posthog.init).mock.calls[0]![1]!;

        const rewrite = (src: string) => {
            const script = { src } as HTMLScriptElement;
            return prepare!(script)?.src;
        };
        expect(rewrite(`https://app.intentic.dev/wire/static/posthog-recorder.js?v=1.398.2`)).toBe(
            `https://app.intentic.dev/wire/static/sdk.posthog-recorder.js?v=1.398.2`,
        );
        expect(rewrite(`https://app.intentic.dev/wire/array/phc_test/config.js`)).toBe(`https://app.intentic.dev/wire/array/phc_test/sdk.config.js`);
    });
});

describe(`track`, () => {
    it(`captures only when analytics is enabled`, async () => {
        const { posthog: disabled, analytics: inert } = await bootAnalytics(``);
        inert.track(`message_sent`);
        expect(disabled.capture).not.toHaveBeenCalled();

        const { posthog, analytics } = await bootAnalytics(`phc_test`);
        analytics.track(`message_sent`, { agent: `claude` });
        expect(posthog.capture).toHaveBeenCalledWith(`message_sent`, { agent: `claude` });
    });
});
