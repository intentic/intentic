/* The app's service worker — registered for ONE purpose: web push. The app is a live daemon client, so there
 * is deliberately no caching, no offline shell and no fetch handler here; adding one would put a stale cache
 * between the browser and a daemon whose whole value is being live.
 *
 * It is a classic (non-module) worker so it needs no build step and can be served straight from /public.
 *
 * Note the subscription lives on THIS origin (the web app), while the sender is the sandbox daemon on its own
 * tunnel. That works because a push endpoint is an absolute URL minted by the browser's push service — the
 * daemon posts to it directly and never needs to be same-origin with the page. */

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
            // Collapses a replacement onto its predecessor — see the daemon's notifications.ts for why each
            // tag is per-conversation rather than per-event.
            tag: payload.tag,
            requireInteraction: payload.requireInteraction === true,
            // Read back by the click handler; `data` is the only channel from here to there.
            data: { url: payload.url || "/" },
        }),
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const target = new URL(event.notification.data?.url || "/", self.location.origin);
    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            // Prefer an existing tab on this origin: the app is a single-page shell holding live streams and
            // open editors, so opening a second copy would be strictly worse than navigating the one that
            // already exists. `navigate` may be unavailable in some browsers — focusing is still the win.
            for (const client of windows) {
                const url = new URL(client.url);
                if (url.origin !== self.location.origin) {
                    continue;
                }
                // NEVER the pop-out. A popped-out panel's page is a window client on this origin too — and the
                // most recently focused one whenever the user works in it, so matchAll lists it FIRST. Navigating
                // it replaces the panel with a second full copy of the app in a popup-sized window (which, under
                // the mobile breakpoint, looks exactly like the chat panel it displaced) — a realm of its own
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
