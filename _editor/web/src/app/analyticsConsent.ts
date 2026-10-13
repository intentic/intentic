import { deviceKey, storedValue, storeValue } from "@intentic/ui/storage";
import { ref } from "vue";
import { desktopApp, openDesktopLink } from "./environments/desktop";
import { environment } from "./environments/environment";

// Whether this browser sends product analytics, kept per browser (device scope): it is about this browser sending,
// so signing out or switching accounts does not forget that it was switched off. Nobody is asked: analytics is on
// unless the person turns it off under Settings, Data, so nothing stored means `allow`.
const KEY = deviceKey(`intentic-product-analytics-consent`);
export type AnalyticsChoice = `allow` | `deny`;
const stored = (): AnalyticsChoice => (storedValue(KEY) === `deny` ? `deny` : `allow`);

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
export const chooseAnalytics = (choice: AnalyticsChoice): void => {
    // A private browser can refuse the write (storeValue swallows that); the choice still governs this page.
    analyticsChoice.value = choice;
    storeValue(KEY, choice);
    if (desktopApp() !== undefined) {
        // App windows cannot share this origin's localStorage. The app keeps the same decision for its own
        // events and the Rust launch reporter; older app versions ignore this link.
        openDesktopLink(`intentic://analytics?choice=${choice}`);
    }
};
