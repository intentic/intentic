import type { Router } from "vue-router";
import { inAppPath, sameOriginPath } from "../../lib/routes/inAppPath";
import { inNativeShell, pushPlugin } from "../window/capacitor.js";

/* "A notification is a pointer back into the workspace", followed inside the page that is already open. Only a route
   on this origin is followed (inAppPath): a message, a launch or a tap that names anything else is not ours. */

interface LaunchQueue {
    setConsumer(consumer: (params: { readonly targetURL?: string }) => void): void;
}

export const installNotificationTaps = (router: Router): void => {
    // A web push tap: the service worker (public/sw.js) asks the open window to route there rather than reloading it,
    // and falls back to navigating when no window answers.
    navigator.serviceWorker?.addEventListener(`message`, (event: MessageEvent) => {
        const data = event.data as { type?: unknown; url?: unknown } | null;
        const path = data?.type === `intentic-notification-tap` && typeof data.url === `string` ? inAppPath(data.url) : undefined;
        if (path === undefined) {
            return;
        }
        event.ports[0]?.postMessage(`received`);
        void router.push(path);
    });
    // The installed app's icon or a shortcut, with the manifest's `focus-existing`: the running page is brought forward
    // as it is, and told where the launch pointed. The bare start URL means "the app", so the page stays where it was.
    const launchQueue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
    launchQueue?.setConsumer(({ targetURL }) => {
        const path = targetURL === undefined ? undefined : sameOriginPath(new URL(targetURL, location.origin));
        if (path !== undefined && path !== `/`) {
            void router.push(path);
        }
    });
    if (!inNativeShell()) {
        return;
    }
    void pushPlugin()?.addListener(`pushNotificationActionPerformed`, (tap) => {
        const url = tap.notification.data?.url;
        // The daemon's urls are in-app routes ("/?conversation=…"); anything else is not ours to follow.
        const path = typeof url === `string` ? inAppPath(url) : undefined;
        if (path !== undefined) {
            void router.push(path);
        }
    });
};
