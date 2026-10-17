import type { User } from "@intentic/api-contract";
import { freshImport, mocked, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { nextTick, ref } from "vue";

// Plain ref stands in for useAuth's module singleton, handed to every boot as main.ts hands in the real one, so
// re-imported analytics modules (one evaluation per test) watch the same instance.
const user = ref<User | null>(null);
jest.mock("posthog-js", () => ({
    posthog: { init: jest.fn(), identify: jest.fn(), reset: jest.fn(), capture: jest.fn(), opt_in_capturing: jest.fn(), opt_out_capturing: jest.fn(), startSessionRecording: jest.fn(), stopSessionRecording: jest.fn(), register: jest.fn(), alias: jest.fn() },
}));

// environment.ts reads `window.env` once, at import; this is the same object under the same name, mutated per case,
// since the module under test reads the key through it on every call.
const environment = {
    production: false,
    api: { url: `` },
    auth: { googleClientId: `` },
    analytics: { posthogKey: ``, posthogHost: `https://app.intentic.dev/wire`, posthogUiHost: `https://eu.posthog.com` },
    afterSignOut: ``,
};
jest.mock("./environments/environment", () => ({ environment }));

// What the router answers, as main.ts hands it over: the workspace route, and nothing else.
const routePatternOf = (path: string): string | undefined => (path.startsWith(`/workspace`) ? `/workspace/:path*` : undefined);

// `desktop` stands in for the app's init script (windows.rs), the only signal that tells this SPA it's running in
// the desktop app rather than a browser tab.
const bootAnalytics = async (posthogKey: string, desktop?: { version: string; installId: string; update: string | null }, launchId?: string) => {
    environment.analytics.posthogKey = posthogKey;
    const stubbed: { env: typeof environment } & Pick<Window, `__INTENTIC_DESKTOP__` | `__INTENTIC_LAUNCH_ID__`> = { env: environment };
    if (desktop !== undefined) {
        stubbed.__INTENTIC_DESKTOP__ = desktop;
    }
    if (launchId !== undefined) {
        stubbed.__INTENTIC_LAUNCH_ID__ = launchId;
    }
    stubGlobal(`window`, stubbed);
    const { posthog } = await import(`posthog-js`);
    const { analyticsChoice } = await import("./analyticsConsent");
    analyticsChoice.value = `allow`;
    const analytics = await freshImport<typeof import("./analytics")>("./analytics", import.meta.url);
    await analytics.initAnalytics(routePatternOf, user);
    return { posthog, analytics };
};

beforeEach(() => {
    // The posthog-js mock instance is shared across boots: drop the previous test's calls.
    jest.clearAllMocks();
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

    // Canvas, console, request bodies and network timing follow the PostHog project's own settings unless the client says
    // no by name, so a recording of the workspace is one dashboard toggle away if this call ever loses them.
    it(`hands posthog the replay privacy options, whatever the project's own recording settings say`, async () => {
        const { posthog } = await bootAnalytics(`phc_test`);
        expect(posthog.init).toHaveBeenCalledWith(
            `phc_test`,
            expect.objectContaining({
                session_recording: expect.objectContaining({
                    maskAllInputs: true,
                    maskTextSelector: `*`,
                    blockSelector: expect.stringContaining(`.monaco-editor`),
                    captureCanvas: { recordCanvas: false },
                    recordBody: false,
                    recordHeaders: false,
                }),
                enable_recording_console_log: false,
                capture_performance: { network_timing: false, web_vitals_attribution: false },
            }),
        );
    });

    // The router's answer is the only thing between a file path and PostHog, so both places an address leaves through
    // (an event, and the page a replay records) have to be wired to it.
    it(`reports an address as the route the router matched, in events and in the replay`, async () => {
        const { posthog } = await bootAnalytics(`phc_test`);
        stubGlobal(`location`, { host: `app.intentic.dev` });
        const config = mocked(posthog.init).mock.calls[0]![1]!;

        const [beforeSend] = [config.before_send].flat();
        const sent = beforeSend!({ uuid: `u1`, event: `$pageview`, properties: { $current_url: `https://app.intentic.dev/workspace/web/src/a.ts`, $pathname: `/workspace/web/src/a.ts` } });
        expect(sent?.properties).toEqual({ $current_url: `https://app.intentic.dev/workspace/:path*`, $pathname: `/workspace/:path*`, load_reason: `navigate` });

        const recorded = config.session_recording!.maskCapturedNetworkRequestFn!({ name: `https://app.intentic.dev/workspace/web/src/a.ts`, entryType: `navigation`, startTime: 0, duration: 0 });
        expect(recorded?.name).toBe(`https://app.intentic.dev/workspace/:path*`);
    });

    // A reload the app forced must not read as the reader's own: the first pageview of a load names why it happened, from
    // the note the reloading code left (or the navigation type), and the pageviews of in-page navigation after it do not.
    describe(`load_reason`, () => {
        const pageview = { uuid: `u`, event: `$pageview`, properties: {} };
        const beforeSend = async () => [mocked((await bootAnalytics(`phc_test`)).posthog.init).mock.calls[0]![1]!.before_send].flat()[0]!;
        const fakeStorage = (note?: string) => {
            const items = new Map<string, string>(note === undefined ? [] : [[`intentic.reloadReason`, note]]);
            stubGlobal(`sessionStorage`, { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value), removeItem: (key: string) => items.delete(key) });
        };

        it(`rides the load's first pageview only, and falls back to the navigation type`, async () => {
            fakeStorage();
            const send = await beforeSend();

            expect(send({ ...pageview, properties: {} })?.properties).toMatchObject({ load_reason: `navigate` });
            expect(send({ ...pageview, properties: {} })?.properties).not.toHaveProperty(`load_reason`);
            expect(send({ uuid: `c`, event: `$autocapture`, properties: {} })?.properties).not.toHaveProperty(`load_reason`);
        });

        it(`names the reload the app started, from the note it left, and clears the note`, async () => {
            fakeStorage(`stale-chunk|${Date.now()}`);
            const send = await beforeSend();

            expect(send({ ...pageview, properties: {} })?.properties).toMatchObject({ load_reason: `stale-chunk` });
            expect(sessionStorage.getItem(`intentic.reloadReason`)).toBeNull();
        });

        it(`ignores a note from a reload that never came`, async () => {
            fakeStorage(`update|${Date.now() - 120_000}`);
            const send = await beforeSend();

            expect(send({ ...pageview, properties: {} })?.properties).toMatchObject({ load_reason: `navigate` });
        });
    });

    // The privacy policy (legal.ts) says the identifier lives in session storage, ends with the tab and does not recognise
    // the reader coming back; the desktop app's workspace window is the same workspace app and keeps the same promise.
    it(`keeps the ids to session storage in a browser tab and in the desktop window alike`, async () => {
        const { posthog: browser } = await bootAnalytics(`phc_test`);
        const { posthog: app } = await bootAnalytics(`phc_test`, { version: `1.15.1`, installId: `install-abc`, update: null });

        expect(mocked(browser.init).mock.calls[0]![1]).toMatchObject({ persistence: `sessionStorage` });
        expect(mocked(app.init).mock.calls.at(-1)![1]).toMatchObject({ persistence: `sessionStorage` });
    });

    it(`tells one run of the desktop app from the next by the launch id its webview carries`, async () => {
        const { posthog } = await bootAnalytics(`phc_test`, { version: `1.15.1`, installId: `install-abc`, update: null }, `launch-7`);
        expect(posthog.register).toHaveBeenCalledWith({ desktop_launch_id: `launch-7` });

        jest.clearAllMocks();
        const { posthog: without } = await bootAnalytics(`phc_test`, { version: `1.15.1`, installId: `install-abc`, update: null });
        expect(without.register).not.toHaveBeenCalledWith(expect.objectContaining({ desktop_launch_id: expect.anything() }));
    });

    // Without a client tag, the desktop app (which loads this SPA) and a browser tab look like the same row, broken
    // down by user agent instead. The install id joins this to what the app's own screens report.
    it(`tags every event with the client, and names the app when it is running inside one`, async () => {
        const { posthog: browser } = await bootAnalytics(`phc_test`);
        expect(browser.register).toHaveBeenCalledWith({ client: `browser` });

        const { posthog: app } = await bootAnalytics(`phc_test`, { version: `1.15.1`, installId: `install-abc`, update: null });
        expect(app.register).toHaveBeenCalledWith({ client: `desktop`, desktop_version: `1.15.1`, desktop_install_id: `install-abc` });
    });

    // The app's own screens report under its install id: folded into the account signed in here, its events land on the
    // same person. A browser tab has no install to fold in.
    it(`folds the desktop app's install into the account that signs in inside it, and only there`, async () => {
        const { posthog: browser } = await bootAnalytics(`phc_test`);
        user.value = { id: `u1`, email: `a@b.c`, name: `A`, image: null };
        await nextTick();
        expect(browser.alias).not.toHaveBeenCalled();

        user.value = null;
        await nextTick();
        jest.clearAllMocks();
        const { posthog: app } = await bootAnalytics(`phc_test`, { version: `1.15.1`, installId: `install-abc`, update: null });
        user.value = { id: `u2`, email: `a@b.c`, name: `A`, image: null };
        await nextTick();
        expect(app.alias).toHaveBeenCalledWith(`install-abc`);
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
        const said = mocked(posthog.register).mock.calls.length;

        user.value = null;
        await nextTick();

        expect(mocked(posthog.register).mock.calls.length).toBeGreaterThan(said);
        expect(mocked(posthog.register).mock.calls.at(-1)).toEqual([
            { client: `desktop`, desktop_version: `1.15.1`, desktop_install_id: `install-abc` },
        ]);
    });

    // EasyPrivacy blocks bare `/posthog-recorder.js` and `/dead-clicks-autocapture.js` on any host, so proxying alone
    // still loses replay to Brave/uBlock; the `sdk.` prefix misses those rules, and nginx.conf strips it back off.
    it(`prefixes SDK script filenames so filename-anchored blocker rules miss them`, async () => {
        const { posthog } = await bootAnalytics(`phc_test`);
        const { prepare_external_dependency_script: prepare } = mocked(posthog.init).mock.calls[0]![1]!;

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

// The SDK arrives at the page's first idle moment, not with the app: a milestone tracked before it has loaded waits,
// and goes out once it has, in the order it happened.
describe(`the SDK loading after the first screen`, () => {
    it(`holds milestones tracked before it has loaded and sends them once it has`, async () => {
        environment.analytics.posthogKey = `phc_test`;
        stubGlobal(`window`, { env: environment });
        const { posthog } = await import(`posthog-js`);
        const { analyticsChoice } = await import("./analyticsConsent");
        analyticsChoice.value = `allow`;
        const analytics = await freshImport<typeof import("./analytics")>("./analytics", import.meta.url);
        const loading = analytics.initAnalytics(routePatternOf, user);
        analytics.track(`sandbox_connected`, { first: true });
        expect(posthog.capture).not.toHaveBeenCalled();

        await loading;
        expect(mocked(posthog.capture).mock.calls).toEqual([[`sandbox_connected`, { first: true }]]);
    });

    // A phone's replay leaves the conversation out whole: every word of it is asterisks anyway, and recording its DOM
    // cost a phone a third more main thread to open a chat. A desktop's replay keeps its masked layout.
    it(`blocks the conversation in a touch screen's replay, and only there`, async () => {
        const touch = (query: string) => ({ matches: query.includes(`pointer: coarse`) });
        environment.analytics.posthogKey = `phc_test`;
        stubGlobal(`window`, { env: environment });
        stubGlobal(`matchMedia`, touch);
        const { posthog } = await import(`posthog-js`);
        const { analyticsChoice } = await import("./analyticsConsent");
        analyticsChoice.value = `allow`;
        await (await freshImport<typeof import("./analytics")>("./analytics", import.meta.url)).initAnalytics(routePatternOf, user);
        expect(mocked(posthog.init).mock.calls.at(-1)![1]!.session_recording!.blockSelector).toContain(`.chat-turns`);

        unstubAllGlobals();
        const { posthog: desk } = await bootAnalytics(`phc_test`);
        expect(mocked(desk.init).mock.calls.at(-1)![1]!.session_recording!.blockSelector).not.toContain(`.chat-turns`);
    });
});


describe(`the Settings switch`, () => {
    it(`keeps the SDK and milestones silent while switched off, and loads it once switched back on`, async () => {
        environment.analytics.posthogKey = `phc_test`;
        stubGlobal(`window`, { env: environment });
        const { analyticsChoice } = await import(`./analyticsConsent`);
        analyticsChoice.value = `deny`;
        const { posthog } = await import(`posthog-js`);
        const analytics = await freshImport<typeof import("./analytics")>("./analytics", import.meta.url);
        const loading = analytics.initAnalytics(routePatternOf, user);
        analytics.track(`denied`);
        await nextTick();
        expect(posthog.init).not.toHaveBeenCalled();
        analyticsChoice.value = `allow`;
        await loading;
        expect(posthog.init).toHaveBeenCalledTimes(1);
        expect(posthog.capture).not.toHaveBeenCalledWith(`denied`);
    });

    it(`starts on when nobody has switched it off`, async () => {
        environment.analytics.posthogKey = `phc_test`;
        stubGlobal(`window`, { env: environment });
        const consent = await freshImport<typeof import("./analyticsConsent")>(`./analyticsConsent`, import.meta.url);
        expect(consent.analyticsChoice.value).toBe(`allow`);
    });
});


describe(`sandbox switch`, () => {
    it(`stops capture while settings are unknown or off and resumes outside that sandbox`, async () => {
        environment.analytics.posthogKey = `phc_test`;
        stubGlobal(`window`, { env: environment });
        const { analyticsChoice } = await import(`./analyticsConsent`);
        const { activeSandboxId } = await import(`./storage/activeSandbox`);
        const { queryClient } = await import(`../lib/queryPersistence`);
        const { rpcKey } = await import(`../lib/queryKeys`);
        analyticsChoice.value = `allow`;
        activeSandboxId.value = `analytics-test`;
        const route = ref(`chat`);
        const { posthog } = await import(`posthog-js`);
        const analytics = await freshImport<typeof import("./analytics")>("./analytics", import.meta.url);
        const { sandboxAnalyticsGate } = await import(`../features/sandbox/analytics/analyticsGate`);
        await analytics.initAnalytics(routePatternOf, user, sandboxAnalyticsGate(route));
        analytics.track(`unknown`);
        expect(posthog.capture).not.toHaveBeenCalled();
        queryClient.setQueryData(rpcKey(`settings.get`), { productAnalytics: false });
        analytics.track(`off`);
        expect(posthog.capture).not.toHaveBeenCalled();
        route.value = `settings`;
        await nextTick();
        analytics.track(`outside`);
        expect(posthog.capture).toHaveBeenCalledWith(`outside`, undefined);
        route.value = `chat`;
        await nextTick();
        analytics.track(`back-inside`);
        expect(posthog.capture).not.toHaveBeenCalledWith(`back-inside`, undefined);
        queryClient.removeQueries({ queryKey: rpcKey(`settings.get`) });
        activeSandboxId.value = undefined;
    });

    it(`allows a sandbox whose daemon predates the switch, and records nothing about a sandbox until it answered`, async () => {
        environment.analytics.posthogKey = `phc_test`;
        stubGlobal(`window`, { env: environment });
        const { analyticsChoice } = await import(`./analyticsConsent`);
        const { activeSandboxId } = await import(`./storage/activeSandbox`);
        const { queryClient } = await import(`../lib/queryPersistence`);
        const { rpcKey } = await import(`../lib/queryKeys`);
        analyticsChoice.value = `allow`;
        activeSandboxId.value = `older-daemon`;
        const { posthog } = await import(`posthog-js`);
        const analytics = await freshImport<typeof import("./analytics")>("./analytics", import.meta.url);
        const { sandboxAnalyticsGate } = await import(`../features/sandbox/analytics/analyticsGate`);
        await analytics.initAnalytics(routePatternOf, user, sandboxAnalyticsGate(ref(`chat`)));
        analytics.track(`before-answer`);
        expect(posthog.capture).not.toHaveBeenCalledWith(`before-answer`, undefined);
        queryClient.setQueryData(rpcKey(`settings.get`), { timezone: `` });
        analytics.track(`after-answer`);
        expect(posthog.capture).toHaveBeenCalledWith(`after-answer`, undefined);
        queryClient.removeQueries({ queryKey: rpcKey(`settings.get`) });
        activeSandboxId.value = undefined;
    });
});

describe(`funnel milestones`, () => {
    beforeEach(() => {
        globalThis.localStorage?.clear();
    });

    // A sign-up is an account made moments ago; the same account coming back next week is a return, not a sign-up.
    it(`counts an account made moments ago as a sign-up, once per account, and an older one not at all`, async () => {
        const { posthog } = await bootAnalytics(`phc_test`);
        user.value = { id: `new-1`, email: `a@b.c`, name: `A`, image: null, signInMethods: [`google`], createdAt: new Date().toISOString() };
        await nextTick();
        expect(posthog.capture).toHaveBeenCalledWith(`signed_up`, expect.objectContaining({ method: `google` }));

        jest.clearAllMocks();
        user.value = null;
        await nextTick();
        user.value = { id: `new-1`, email: `a@b.c`, name: `A`, image: null, signInMethods: [`google`], createdAt: new Date().toISOString() };
        await nextTick();
        expect(posthog.capture).not.toHaveBeenCalledWith(`signed_up`, expect.anything());

        user.value = null;
        await nextTick();
        user.value = { id: `old-1`, email: `a@b.c`, name: `A`, image: null, createdAt: new Date(Date.now() - 86_400_000).toISOString() };
        await nextTick();
        expect(posthog.capture).not.toHaveBeenCalledWith(`signed_up`, expect.anything());
    });

    it(`reports the first finished turn of an account once, and nothing before anyone has signed in`, async () => {
        const { posthog, analytics } = await bootAnalytics(`phc_test`);
        analytics.noteTurnCompleted(`claude`);
        expect(posthog.capture).not.toHaveBeenCalledWith(`first_turn_completed`, expect.anything());

        user.value = { id: `u-turn`, email: `a@b.c`, name: `A`, image: null };
        await nextTick();
        analytics.noteTurnCompleted(`claude`);
        analytics.noteTurnCompleted(`codex`);
        const sent = mocked(posthog.capture).mock.calls.filter(([event]) => event === `first_turn_completed`);
        expect(sent).toHaveLength(1);
        expect(sent[0]![1]).toEqual(expect.objectContaining({ agent: `claude` }));
    });
});
