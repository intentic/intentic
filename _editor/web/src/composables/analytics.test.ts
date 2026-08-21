import type { User } from "@intentic-app/api-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

// Plain refs stand in for useAuth's module singletons; the mock factory closes over them so re-imported
// analytics modules (vi.resetModules per test) keep watching the same instances.
const user = ref<User | null>(null);
vi.mock("./useAuth", () => ({ useAuth: () => ({ user }) }));
vi.mock("posthog-js", () => ({
    default: { init: vi.fn(), identify: vi.fn(), reset: vi.fn(), capture: vi.fn(), register: vi.fn() },
}));

// `desktop` stands in for the app's initialization script (windows.rs), which is the only thing that tells this
// SPA it is running inside the desktop app rather than a browser tab.
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
        // The proxied api_host is what keeps replay alive past an ad blocker, and sessionStorage is what keeps
        // one visit in one recording across reloads: both are load-bearing enough to pin here.
        expect(posthog.init).toHaveBeenCalledWith(
            `phc_test`,
            expect.objectContaining({ api_host: `https://app.intentic.dev/wire`, persistence: `sessionStorage` }),
        );

        user.value = { id: `u1`, email: `a@b.c`, name: `A`, image: null };
        await nextTick();
        expect(posthog.identify).toHaveBeenCalledWith(`u1`, { email: `a@b.c`, name: `A` });

        user.value = null;
        await nextTick();
        expect(posthog.reset).toHaveBeenCalled();
    });

    /* The desktop app loads THIS SPA, so without a client tag on every event an app user and a browser user are
     * the same row, and PostHog's own breakdown would call the app "Safari" on Linux and "Edge" on Windows.
     * The install id is the join to what the app's own screens report about the same install. */
    it(`tags every event with the client, and names the app when it is running inside one`, async () => {
        const { posthog: browser } = await bootAnalytics(`phc_test`);
        expect(browser.register).toHaveBeenCalledWith({ client: `browser` });

        const { posthog: app } = await bootAnalytics(`phc_test`, { version: `1.15.1`, installId: `install-abc`, update: null });
        expect(app.register).toHaveBeenCalledWith({ client: `desktop`, desktop_version: `1.15.1`, desktop_install_id: `install-abc` });
    });

    // reset() empties the store super properties live in, so a sign-out would otherwise strip the client tag off
    // every event that follows it: on the desktop app, off exactly the sessions this exists to count.
    it(`says which client it is again after a sign-out has cleared it`, async () => {
        const { posthog } = await bootAnalytics(`phc_test`, { version: `1.15.1`, installId: `install-abc`, update: null });
        user.value = { id: `u1`, email: `a@b.c`, name: `A`, image: null };
        await nextTick();
        // Counted rather than asserted outright: `user` is a module singleton, so every boot in this file leaves
        // a live watcher on it and a sign-out here runs all of them. What matters is that this one said it again.
        const said = vi.mocked(posthog.register).mock.calls.length;

        user.value = null;
        await nextTick();

        expect(vi.mocked(posthog.register).mock.calls.length).toBeGreaterThan(said);
        expect(vi.mocked(posthog.register).mock.calls.at(-1)).toEqual([
            { client: `desktop`, desktop_version: `1.15.1`, desktop_install_id: `install-abc` },
        ]);
    });

    // EasyPrivacy carries bare `/posthog-recorder.js` and `/dead-clicks-autocapture.js` rules that match on
    // any host, so proxying alone still loses replay behind Brave/uBlock: the prefix is what misses them,
    // and nginx.conf's `rewrite ^/wire/(.*/)sdk\.([^/]+)$` is what puts the name back.
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
