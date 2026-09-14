import type { Router } from "vue-router";
import { inNativeShell, pushPlugin } from "../window/capacitor.js";

/* The native half of "a notification is a pointer back into the workspace". */

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
