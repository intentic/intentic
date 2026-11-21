import { deviceKey, removeStoredValue, storedValue, storeValue } from "@intentic/ui/storage";
import { ref } from "vue";
import { desktopApp, openDesktopLink } from "./environments/desktop";
import { environment } from "./environments/environment";

// Whether this browser sends product analytics, kept per browser (device scope): it is about this browser sending,
// so signing out or switching accounts does not forget that it was switched off.
//
// WHO IS ASKED (2026-10-15). A browser whose clock is set to a time zone of the EEA, the UK or Switzerland is asked
// first (`unasked`) and sends nothing until it answers; everywhere else analytics is on unless switched off under
// Settings, Data, so nothing stored means `allow` there. The time zone, not the platform's country header, decides:
// it needs no request before the first screen, it works on a self-hosted platform with no Cloudflare in front, and it
// errs towards asking (a European zone outside the EEA is asked too), which is the safe side. Chosen over asking
// everyone, which would have cost the analytics of every visitor no law asks us to ask.
const KEY = deviceKey(`intentic-product-analytics-consent`);
export type AnalyticsChoice = `allow` | `deny` | `unasked`;

// Zones of the EEA, the UK and Switzerland that do not start with `Europe/`: Cyprus is `Asia/Nicosia`, the Atlantic
// islands and the outermost regions of France, Portugal and Spain have zones of their own.
const EUROPEAN_OUTLIERS = new Set([
    `Asia/Nicosia`,
    `Asia/Famagusta`,
    `Atlantic/Azores`,
    `Atlantic/Canary`,
    `Atlantic/Faroe`,
    `Atlantic/Madeira`,
    `Atlantic/Reykjavik`,
    `Arctic/Longyearbyen`,
    `America/Cayenne`,
    `America/Guadeloupe`,
    `America/Martinique`,
    `Indian/Mayotte`,
    `Indian/Reunion`,
]);

/** Whether a browser in this IANA time zone is asked before anything is recorded. */
export const asksFirstIn = (timeZone: string | undefined): boolean =>
    timeZone !== undefined && (timeZone.startsWith(`Europe/`) || EUROPEAN_OUTLIERS.has(timeZone));

const browserTimeZone = (): string | undefined => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
        // allow(silent-catch): a runtime with no Intl time zone is treated as one that is asked, below.
        return undefined;
    }
};

// No time zone to read is asked too: the same safe side as a European one.
const asksFirstHere = (): boolean => {
    const zone = browserTimeZone();
    return zone === undefined || asksFirstIn(zone);
};

const stored = (): AnalyticsChoice => {
    const value = storedValue(KEY);
    if (value === `deny` || value === `allow`) {
        return value;
    }
    return asksFirstHere() ? `unasked` : `allow`;
};

// allow(module-state): this browser's analytics setting (device scope), the same whichever sandbox is open
export const analyticsChoice = ref<AnalyticsChoice>(stored());
if (`addEventListener` in globalThis) {
    globalThis.addEventListener(`storage`, (event: StorageEvent) => {
        if (event.key === KEY) {analyticsChoice.value = stored();}
    });
}
export const analyticsAvailable = (): boolean => {
    const key = environment.analytics.posthogKey;
    return key !== `` && !key.startsWith(`$`);
};
export const chooseAnalytics = (choice: Exclude<AnalyticsChoice, `unasked`>): void => {
    // A private browser can refuse the write (storeValue swallows that); the choice still governs this page.
    analyticsChoice.value = choice;
    storeValue(KEY, choice);
    if (desktopApp() !== undefined) {
        // App windows cannot share this origin's localStorage. The app keeps the same decision for its own
        // events and the Rust launch reporter; older app versions ignore this link.
        openDesktopLink(`intentic://analytics?choice=${choice}`);
    }
};

// THE TEAM'S OWN BROWSERS AND INSTALLS (2026-11-21). Every event of a page the team marked carries `internal: true`, so
// its test machines can be told from real users' whatever network they report from. In the desktop app the app says so
// (`internal` on `__INTENTIC_DESKTOP__`, from the install's INTENTIC_TELEMETRY_INTERNAL or its config folder's
// telemetry-internal file: the desktop app's launch.rs). A browser is marked once by opening any address of the app
// with `?internal=1`, and unmarked with `?internal=0`; the mark is this browser's (device scope), so signing out keeps
// it. Chosen over a switch under Settings, Data, which every reader would see and wonder about for a flag only the
// team ever sets.
const INTERNAL_KEY = deviceKey(`intentic-telemetry-internal`);
const INTERNAL_PARAM = `internal`;

/** Keep what an address's `?internal=` says for this browser: `1` marks it, `0` unmarks it, anything else is ignored. */
export const noteInternalSwitch = (search: string): void => {
    const said = new URLSearchParams(search).get(INTERNAL_PARAM);
    if (said === `1`) {
        storeValue(INTERNAL_KEY, `1`);
    } else if (said === `0`) {
        removeStoredValue(INTERNAL_KEY);
    }
};

/** Whether this page's events are the team's own: a marked desktop install, or a marked browser. */
export const internalHere = (): boolean => desktopApp()?.internal === true || storedValue(INTERNAL_KEY) === `1`;
