import type { CaptureResult, PostHog } from "posthog-js";
import type { User } from "@intentic/api-contract";
import { type Ref, watch } from "vue";
import { takeReloadReason } from "@intentic/ui/reload-reason";
import { deviceKey, storedValue, storeValue } from "@intentic/ui/storage";
import { analyticsAvailable, analyticsChoice } from "./analyticsConsent";
import { desktopApp, desktopLaunchId } from "./environments/desktop";
import { environment } from "./environments/environment";
import { addressRedactor, eventPrivacy, type RoutePatternOf } from "./eventPrivacy";
import { replayPrivacy } from "./replayPrivacy";

// PostHog instrumentation: autocapture, session replay, SPA pageviews, plus funnel milestones via `track()`.
// `api_host` proxies through this origin's /wire (nginx.conf) since privacy blockers match PostHog's own hostnames.
// In a browser `sessionStorage` scopes the session id to the tab so a reload doesn't fragment one visit into unrelated
// recordings. The desktop app's window is not a tab: every relaunch emptied its sessionStorage, so each one began a new
// session and a new anonymous person, and a person who opens the app daily looked like a stream of strangers. There the
// ids live in `localStorage` and survive a relaunch; PostHog still ends a session after half an hour idle, and
// `desktop_launch_id` (below) tells one run of the app from the next.
//
// What this captures is what the privacy policy and sub-processor list (_site/site-content/src/legal.ts) say it
// captures; a change here that alters what leaves the browser must move LEGAL_VERSION and both documents together.
//
// Neither the replay nor an event carries the workspace: replayPrivacy.ts (with replayText.ts) masks every piece of text
// that is not the interface's own wording, a number or a setup's own diagnostics, and blocks the editor, terminals and
// media, and eventPrivacy.ts gives the same treatment to the addresses and clicked text of the events. Widen either
// there, not here, and only together with the policy.
//
// LOADED AT THE PAGE'S FIRST IDLE MOMENT, not with the app: posthog-js is ~290 KB of JS that a phone downloaded and ran
// before its first screen, and its recorder then started serialising a page still being built. Milestones raised
// before the SDK is there wait in `early` and go out only while capture is allowed.
//
// A browser in the EEA, the UK or Switzerland is asked first and sends nothing until it allows it; elsewhere analytics is
// on unless this browser was switched off under Settings, Data (analyticsConsent.ts). A sandbox's own switch can
// withhold it for everyone in that sandbox (the gate below).
let enabled = false;
let allowed = false;
let client: PostHog | undefined;
// What a milestone carries, in PostHog's own terms.
type Milestone = Parameters<PostHog[`capture`]>[1];
const early: [event: string, properties: Milestone][] = [];

// After the page's first idle moment, or at once where there is no idle callback to ask (a test's window).
const firstIdle = (): Promise<void> =>
    new Promise((resolve) => {
        if (`requestIdleCallback` in globalThis) {
            globalThis.requestIdleCallback(() => resolve(), { timeout: 4_000 });
            return;
        }
        resolve();
    });

// A touch-first screen (a phone, a tablet), asked once at init: its replay leaves the conversation out whole
// (replayPrivacy.ts), since recording a transcript's DOM as it mounts and streams cost a phone about a third more main
// thread to open a chat.
const touchScreen = (): boolean => `matchMedia` in globalThis && globalThis.matchMedia(`(hover: none) and (pointer: coarse)`).matches;

// Whether the place the person is in now may be recorded at all, beyond this browser's own setting, and a way to hear
// when that may have changed. The sandbox's own switch (`productAnalytics`) is read by the gate beside that switch
// (features/sandbox/analytics/analyticsGate.ts), handed in from main.ts, since the sandbox's client sits
// above this module. `asking` says this browser is not switched off, so the gate may go and find out what it does not
// know yet.
export interface AnalyticsGate {
    readonly permitted: (asking: boolean) => boolean;
    readonly watch: (onChange: () => void) => void;
}

// No sandbox to ask about: a test, or a page with no sandbox client. Only the person's own choice counts.
const OPEN_GATE: AnalyticsGate = { permitted: () => true, watch: () => undefined };

// `routePatternOf` is the router's table as a question, so an address is reported as its route (`/workspace/:path*`).
// `user` is the signed-in account (useAuth's), handed in since the account's client sits above this module.
export const initAnalytics = async (routePatternOf: RoutePatternOf, user: Readonly<Ref<User | null>>, gate: AnalyticsGate = OPEN_GATE): Promise<void> => {
    const { posthogKey, posthogHost, posthogUiHost } = environment.analytics;
    // Empty in dev; a literal `$POSTHOG_KEY` when the deploy container's envsubst had no key to substitute.
    if (!analyticsAvailable()) {
        return;
    }
    enabled = true;
    const permittedHere = (): boolean => gate.permitted(analyticsChoice.value === `allow`);
    const sync = (): void => {
        const next = analyticsChoice.value === `allow` && permittedHere();
        if (next === allowed) {return;}
        allowed = next;
        if (client === undefined) {return;}
        if (next) {
            client.opt_in_capturing();
            client.startSessionRecording();
            registerClient(client);
            if (user.value) {
                identify(client, user.value);
            }
        } else {
            client.stopSessionRecording();
            client.opt_out_capturing();
            early.length = 0;
        }
    };
    watch(analyticsChoice, sync, { immediate: true, flush: `sync` });
    gate.watch(sync);
    const waitForAllow = async (): Promise<void> => {
        if (analyticsChoice.value === `allow`) {return;}
        await new Promise<void>((resolve) => {
            const stop = watch(analyticsChoice, (choice) => {
                if (choice === `allow`) { stop(); resolve(); }
            });
        });
    };
    await waitForAllow();
    const redactAddress = addressRedactor(routePatternOf);
    await firstIdle();
    await waitForAllow();
    const { posthog } = await import(`posthog-js`);
    posthog.init(posthogKey, {
        api_host: posthogHost,
        // Proxying makes `api_host` a host posthog-js can't map to a cloud region, so `ui_host` must be named outright
        // or
        // replay deep-links won't resolve.
        // POSTHOG_UI_HOST names an EU project's (https://eu.posthog.com); a literal `$…` is a container that had none.
        ui_host: posthogUiHost === undefined || posthogUiHost.startsWith(`$`) ? `https://us.posthog.com` : posthogUiHost,
        opt_out_capturing_by_default: true,
        // No cookieless counts on refusal: the promise made by switching it off is that this client sends no events.
        defaults: `2026-06-25`,
        persistence: desktopApp() === undefined ? `sessionStorage` : `localStorage`,
        ...replayPrivacy(redactAddress, { touch: touchScreen() }),
        before_send: (event) => (allowed ? eventPrivacy(redactAddress)(stampLoadReason(event)) : null),
        // Serving the SDK from our own origin isn't enough: blocker lists also match a bare filename on any host
        // (posthog-recorder.js, dead-clicks-autocapture.js). Prefixing every SDK script, not just those two, breaks the
        // match; nginx.conf strips the prefix back off.
        prepare_external_dependency_script: (script) => {
            const url = new URL(script.src);
            url.pathname = url.pathname.replace(/[^/]+$/, (file) => `sdk.${file}`);
            script.src = url.toString();
            return script;
        },
    });

    client = posthog;
    if (allowed) {
        posthog.opt_in_capturing();
        posthog.startSessionRecording();
        registerClient(posthog);
        for (const [event, properties] of early.splice(0)) {
            posthog.capture(event, properties);
        }
    } else {
        posthog.opt_out_capturing();
        early.length = 0;
    }

    // Session resolves (sign-in or reload) → stable identity; sign-out / account deletion → drop it. Immediate, since a
    // session that resolved while the SDK was still loading has no change left to announce it.
    watch(
        user,
        (current, previous) => {
            account = current?.id;
            if (!allowed) {return;}
            if (current) {
                identify(posthog, current);
                return;
            }
            if (previous) {
                posthog.reset();
                posthog.opt_in_capturing();
                posthog.startSessionRecording();
                // `reset()` clears super properties too, so the client tag must be re-registered or later events report
                // from nowhere in particular.
                registerClient(posthog);
            }
        },
        { immediate: true },
    );
};

// WHY THIS PAGE LOADED, on the load's first pageview: the navigation type the browser reports (navigate, reload,
// back_forward), unless the app itself reloaded the page and left a note (update, stale-chunk, self-heal, opener-fallback,
// sign-out), which is the truer answer. Without it a reload the app forced looks like the reader's own, and a burst of
// "reloads" cannot be told from an update rolling out. Read once at import: the note is cleared as it is read.
const loadReason = ((): string => {
    const nav = globalThis.performance?.getEntriesByType?.(`navigation`)[0];
    const type = nav !== undefined && `type` in nav ? String(nav.type) : `navigate`;
    return takeReloadReason() ?? type;
})();
let loadReasonStamped = false;
const stampLoadReason = (event: CaptureResult | null): CaptureResult | null => {
    if (event === null || event.event !== `$pageview` || loadReasonStamped) {
        return event;
    }
    loadReasonStamped = true;
    event.properties = { ...event.properties, load_reason: loadReason };
    return event;
};

// Which client sent this event, as a super property (not a per-call field) so it also tags autocapture and
// pageviews. The install id joins this to what the app's own screens report (desktop.ts).
const registerClient = (posthog: PostHog): void => {
    const app = desktopApp();
    const launchId = desktopLaunchId();
    posthog.register(
        app === undefined ? { client: `browser`, ...landingCampaign } : { client: `desktop`, desktop_version: app.version, desktop_install_id: app.installId, ...landingCampaign },
    );
    // Persistence outlives a relaunch (see the top of this file); this is what tells one run of the app from the next.
    if (launchId !== undefined) {
        posthog.register({ desktop_launch_id: launchId });
    }
};

// THE APP'S OWN EVENTS ON THIS PERSON. The desktop app's screens report under its install id (desktop-app's
// analytics.ts), which on its own is a nameless person beside this one: its install, Docker and requirement events never
// showed on the account's timeline. An alias folds that id into the account signed in here. Nothing new leaves: every
// event from the app's window already carries the install id (`registerClient`). PostHog only merges an id that belongs
// to no identified person yet, so a second account signed in on the same install keeps its own, and the first the app's.
let linked: string | undefined;
const linkInstall = (posthog: PostHog, userId: string): void => {
    const installId = desktopApp()?.installId;
    if (installId === undefined || installId === `` || installId === userId || linked === `${userId}|${installId}`) {
        return;
    }
    linked = `${userId}|${installId}`;
    posthog.alias(installId);
};

// PostHog's session id, the key its replay is found by, from the SDK itself: undefined where analytics is off or until
// the SDK has loaded at the page's first idle moment. Never throws, since an error report asks it.
export const replaySessionId = (): string | undefined => {
    try {
        return allowed ? client?.get_session_id() : undefined;
    } catch {
        // allow(silent-catch): an error report asks for this id; a throw here would lose the report it was meant to annotate.
        return undefined;
    }
};

// THE CAMPAIGN A VISIT ARRIVED WITH (2026-10-15), read as this module loads: before the router can redirect the
// address it came in on (to /login, to /setup) and before the SDK loads at the first idle moment, when PostHog would
// otherwise look for it. The site hands it over in the sign-in link (_site/site/src/lib/visit.ts). Registered on every
// event of the tab, so `signed_up` carries it, and set once on the person as where they first came from.
const CAMPAIGN_KEYS = [`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`] as const;
interface Campaign {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
}
const arrivedWith = (search: string): Campaign => {
    const params = new URLSearchParams(search);
    const campaign: Campaign = {};
    for (const key of CAMPAIGN_KEYS) {
        const value = params.get(key)?.trim().slice(0, 150);
        if (value !== undefined && value !== ``) {
            campaign[key] = value;
        }
    }
    return campaign;
};
const landingCampaign = arrivedWith(globalThis.location?.search ?? ``);
// The person's first-touch fields; an absent tag is left out when the SDK serialises the call.
const firstTouch = () => ({
    initial_utm_source: landingCampaign.utm_source,
    initial_utm_medium: landingCampaign.utm_medium,
    initial_utm_campaign: landingCampaign.utm_campaign,
    initial_utm_term: landingCampaign.utm_term,
    initial_utm_content: landingCampaign.utm_content,
});

const identify = (posthog: PostHog, current: User): void => {
    if (Object.keys(landingCampaign).length === 0) {
        posthog.identify(current.id, { email: current.email, name: current.name });
    } else {
        posthog.identify(current.id, { email: current.email, name: current.name }, firstTouch());
    }
    linkInstall(posthog, current.id);
    noteSignUp(current);
};

// Funnel milestone events from call sites. No-op until `initAnalytics` has run (no key in dev); otherwise
// uninitialized `posthog.capture` logs a console error per call.
export const track = (event: string, properties?: Milestone): void => {
    if (!enabled || analyticsChoice.value !== `allow`) {
        return;
    }
    if (!allowed) {return;}
    if (client === undefined) {
        early.push([event, properties]);
        return;
    }
    client.capture(event, properties);
};

// THE FUNNEL'S TWO MILESTONES THE SDK CANNOT SEE (2026-10-15). `signed_up` is an account's first arrival: the platform
// says when the account was made (User.createdAt), and an account made within SIGN_UP_WINDOW_MS of being seen here is a
// sign-up rather than a return. `first_turn_completed` is the first agent turn this browser saw finish on its own (not
// stopped, not failed). Each is sent once per account per browser (a device-scoped flag), and carries `$set_once` so the
// person keeps the first moment whichever browser said it first. A browser that has not allowed analytics sends neither
// and sets no flag, so allowing it later inside the window still counts the sign-up.
const SIGN_UP_WINDOW_MS = 30 * 60_000;
// The account signed in on this page, for the once-per-account flags.
let account: string | undefined;
const onceKey = (milestone: string, userId: string): string => deviceKey(`intentic-milestone-${milestone}-${userId}`);

const once = (milestone: string, userId: string, properties: Milestone): void => {
    if (!enabled || !allowed || storedValue(onceKey(milestone, userId)) !== undefined) {
        return;
    }
    storeValue(onceKey(milestone, userId), new Date().toISOString());
    track(milestone, properties);
};

const noteSignUp = (current: User): void => {
    account = current.id;
    const createdAt = current.createdAt === undefined ? Number.NaN : Date.parse(current.createdAt);
    if (Number.isNaN(createdAt) || Date.now() - createdAt > SIGN_UP_WINDOW_MS) {
        return;
    }
    const method = current.signInMethods?.includes(`google`) === true ? `google` : `email`;
    once(`signed_up`, current.id, { method, $set_once: { signed_up_at: current.createdAt } });
};

/** An agent turn this window followed settled on its own, neither stopped nor failed. */
export const noteTurnCompleted = (agent: string): void => {
    if (account === undefined) {
        return;
    }
    once(`first_turn_completed`, account, { agent, $set_once: { first_turn_completed_at: new Date().toISOString() } });
};
