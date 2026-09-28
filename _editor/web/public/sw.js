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
            // Read back by the click handler; `data` is the only channel from here to there.
            data: { url: payload.url || "/" },
        }),
    );
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
            // open editors, so opening a second copy would be strictly worse than navigating the one that
            // already exists. `navigate` may be unavailable in some browsers: focusing is still the win.
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
                await client.focus();
                if (typeof client.navigate === "function") {
                    await client.navigate(target.href).catch(() => undefined);
                }
                return;
            }
            await self.clients.openWindow(target.href);
        })(),
    );
});
