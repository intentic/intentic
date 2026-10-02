/* The app's service worker, registered for ONE purpose: web push. */

// Take over as soon as installed rather than waiting for every tab to close: a user who just enabled
// notifications expects the next turn to reach them, not the one after their next full browser restart.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
    // A push with no readable payload still means SOMETHING happened; showing a bare notice beats silence.
    // (Some browsers also deliver a payloadless wake-up to verify the subscription.)
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = {};
    }
    const title = payload.title || "intentic";
    event.waitUntil(
        self.registration.showNotification(title, {
            body: payload.body || "",
            icon: "/assets/intentic-logo-sized.png",
            badge: "/assets/intentic-logo-sized.png",
            // Collapses a replacement onto its predecessor. The daemon's notifications.ts picks the grain: one
            // per waiting card or need, so two waiting at once both stay on screen; one per conversation for a
            // finished turn.
            tag: payload.tag,
            requireInteraction: payload.requireInteraction === true,
            // The replacement for an ask that stopped waiting (push.ts `withdraw`) takes its place without a buzz.
            silent: payload.silent === true,
            // Read back by the click handler; `data` is the only channel from here to there.
            data: { url: payload.url || "/" },
        }),
    );
});

// Asks an open window to route itself to `path`; true once it says it will. A phone resuming a frozen page takes a
// moment to answer, so the wait is generous; past it, the caller falls back to navigating.
const ROUTE_ANSWER_MS = 2000;
const routedInPlace = (client, path) =>
    new Promise((resolve) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => resolve(false), ROUTE_ANSWER_MS);
        channel.port1.addEventListener(
            "message",
            () => {
                clearTimeout(timeout);
                resolve(true);
            },
            { once: true },
        );
        channel.port1.start();
        try {
            client.postMessage({ type: "intentic-notification-tap", url: path }, [channel.port2]);
        } catch {
            clearTimeout(timeout);
            resolve(false);
        }
    });

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    // An in-app route, passed whole: the router reads `?conversation=` and ignores what it does not know (a
    // need's `&need=`). Anything off this origin is not ours to open, as for the native shell's taps.
    const asked = new URL(event.notification.data?.url || "/", self.location.origin);
    const target = asked.origin === self.location.origin ? asked : new URL("/", self.location.origin);
    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            // Prefer an existing tab on this origin: the app is a single-page shell holding live streams and
            // open editors, so opening a second copy would be strictly worse than routing the one that already
            // exists.
            for (const client of windows) {
                const url = new URL(client.url);
                if (url.origin !== self.location.origin) {
                    continue;
                }
                // NEVER the pop-out. A popped-out panel's page is a window client on this origin too, and the
                // most recently focused one whenever the user works in it, so matchAll lists it FIRST. Navigating
                // it replaces the panel with a second full copy of the app in a popup-sized window (which, under
                // the mobile breakpoint, looks exactly like the chat panel it displaced): a realm of its own
                // that nothing in the real app window drives ever again.
                if (url.pathname === "/popout.html") {
                    continue;
                }
                // allow(silent-catch): A browser may refuse focus; still route the notification to the existing client.
                await client.focus().catch(() => undefined);
                // The open app routes there itself (shell/notifications/notificationTaps.ts), keeping its streams and
                // what it has painted; a navigation reloads the whole app. A window that does not answer (a page
                // from before this worker) still gets the navigation, where the browser has `navigate`; where it
                // does not, focusing is still the win.
                const routed = await routedInPlace(client, `${target.pathname}${target.search}${target.hash}`);
                if (!routed && typeof client.navigate === "function") {
                    // allow(silent-catch): The client may close during navigation; notification handling has already found its window.
                    await client.navigate(target.href).catch(() => undefined);
                }
                return;
            }
            await self.clients.openWindow(target.href);
        })(),
    );
});
