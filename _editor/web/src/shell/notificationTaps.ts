import type { Router } from "vue-router";
import { inNativeShell, pushPlugin } from "./capacitor.js";

/* The native half of "a notification is a pointer back into the workspace". On the web the service worker's
 * click handler focuses a tab at the notification's `url`; inside the iOS shell there is no service worker,
 * the OS shows the notification and hands a tap to the app, and this listener finishes the journey by
 * navigating where the daemon pointed.
 *
 * Registered once at startup, before anything mounts, because the tap that LAUNCHED the app is delivered as
 * an event too. Capacitor queues it until a listener exists, so a listener registered late reads as "the
 * app opened but ignored where I asked it to go". A no-op in every ordinary browser. */

export const installNotificationTaps = (router: Router): void => {
    if (!inNativeShell()) {
        return;
    }
    void pushPlugin()?.addListener(`pushNotificationActionPerformed`, (tap) => {
        const url = tap.notification.data?.url;
        // The daemon's urls are in-app routes ("/?conversation=…"); anything else is not ours to follow.
        if (typeof url === `string` && url.startsWith(`/`)) {
            void router.push(url);
        }
    });
};
