/* THE APP'S SERVICE WORKER: web push, and the editor's own copy of itself for when its origin cannot answer (2026-10-26).

The editor and the platform api share one host behind one tunnel, so when that host is down app.intentic.dev answers
with Cloudflare's 52x/530 page or nothing at all, and the outage screen that opens remembered sandboxes directly
(features/sandbox/recovery) could never load. This worker keeps the last good shell (index.html) and the chunks the
outage path needs, and answers a navigation with that copy only when the network fails or answers 500/502–599. A good
answer always wins and replaces the copy, so a deploy is never masked. Everything else passes through untouched:
another origin (the api, every sandbox daemon, Google), anything but GET, anything with credentials or a range, and
every same-origin path that is not the shell, `/assets/` or `/ext-shims/`.

The build writes the precache list in place of the marker below (vite.offline.ts). With none (the dev server, the
demo's build), the worker caches nothing and answers no fetch: it is the push worker it always was. */

// Replaced in dist/sw.js by the build: `{ build, urls }`, the shell's critical chunks of this build.
const PRECACHE = /* intentic:precache */ null;

const OFFLINE = `intentic-offline`;
const SHELL_CACHE = `${OFFLINE}-shell`;
const ASSET_CACHE = `${OFFLINE}-assets`;
const PRECACHE_PREFIX = `${OFFLINE}-precache-`;
// Every route of the app is the same index.html, kept under one key.
const SHELL_KEY = `/`;
// A healthy origin answers a navigation in about a second, and Cloudflare gives up on a dead one after about 19 (522).
// Past this, with a copy in hand, the copy is shown; without one the page keeps waiting on the network.
const NAVIGATION_PATIENCE_MS = 15000;
// Chunks kept on use across deploys, so a tab of the previous build can still load its lazy views; the oldest go first.
const ASSET_CAP = 400;
// Parallel fetches while precaching, so an install never queues the whole list on one connection.
const PRECACHE_BATCH = 6;

// Not the app, whatever the mode: a navigation to one of these gets the network's answer and nothing else.
const NOT_THE_SHELL = /^\/(?:api|assets|fonts|ext-shims|wire|\.well-known)\//;
const NOT_THE_SHELL_FILES = new Set([`/build.json`, `/sw.js`, `/manifest.webmanifest`, `/favicon.ico`, `/favicon.svg`, `/apple-touch-icon.png`]);

// The statuses a dead origin is served as: 500, and 502 through 599 (Cloudflare's 52x and 530). 501 is an answer.
const fallsBack = (status) => status === 500 || (status >= 502 && status <= 599);

// What the worker does with a request: `shell` (network first, the kept shell when that fails), `asset` (the cache
// first, kept on use), `fresh` (network first, the kept copy when that fails), or `pass` (not touched).
const kindOf = (request, origin) => {
    if (request.method !== `GET`) {
        return `pass`;
    }
    const url = new URL(request.url);
    if (url.origin !== origin || request.headers.has(`authorization`) || request.headers.has(`range`)) {
        return `pass`;
    }
    const path = url.pathname;
    if (request.mode === `navigate`) {
        return NOT_THE_SHELL.test(path) || NOT_THE_SHELL_FILES.has(path) ? `pass` : `shell`;
    }
    // The runtime config (rewritten per deploy, served no-store) and the import map's shims (no-cache, so an extension's
    // imports track the deploy): always asked for, kept only for when asking fails.
    if (path === `/assets/js/env.js` || path.startsWith(`/ext-shims/`)) {
        return `fresh`;
    }
    return path.startsWith(`/assets/`) ? `asset` : `pass`;
};

// The app's shell as the origin served it: a plain 200 page of ours, not a redirect (Safari refuses to answer a
// navigation with one) and not an error page.
const isShell = (response) =>
    response.status === 200 && response.type === `basic` && !response.redirected && (response.headers.get(`content-type`) ?? ``).includes(`text/html`);

// A response the asset cache may keep: a whole 200 of ours that the origin did not mark private or unstorable.
const storable = (response) => response.status === 200 && response.type === `basic` && !/\b(?:no-store|private)\b/.test(response.headers.get(`cache-control`) ?? ``);

const TIMED_OUT = Symbol(`timed out`);
const after = (ms) => new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), ms));

const keptShell = async () => (await caches.open(SHELL_CACHE)).match(SHELL_KEY);

// A navigation: the network's answer unless it failed or is a dead origin's, then the kept shell, then the network's
// answer as it was. The copy is refreshed from every good answer, kept alive past the reply so a good page that arrives
// after the patience ran out still replaces it.
const navigate = (event) => {
    const settled = fetch(event.request).then(
        (response) => ({ response, copy: isShell(response) ? response.clone() : undefined }),
        (error) => ({ error }),
    );
    event.waitUntil(settled.then(async ({ copy }) => (copy === undefined ? undefined : (await caches.open(SHELL_CACHE)).put(SHELL_KEY, copy))));
    const finish = async (outcome) => {
        if (outcome.error === undefined && !fallsBack(outcome.response.status)) {
            return outcome.response;
        }
        const shell = await keptShell();
        if (shell !== undefined) {
            return shell;
        }
        if (outcome.error !== undefined) {
            throw outcome.error;
        }
        return outcome.response;
    };
    return (async () => {
        const first = await Promise.race([settled, after(NAVIGATION_PATIENCE_MS)]);
        if (first !== TIMED_OUT) {
            return finish(first);
        }
        return (await keptShell()) ?? finish(await settled);
    })();
};

// A hashed chunk never changes under its name: what the cache holds is the answer, and a miss is kept once fetched.
const cacheFirst = async (event) => {
    const hit = await caches.match(event.request);
    if (hit !== undefined) {
        return hit;
    }
    const response = await fetch(event.request);
    if (storable(response)) {
        const copy = response.clone();
        event.waitUntil(caches.open(ASSET_CACHE).then((cache) => cache.put(event.request, copy)));
    }
    return response;
};

// The newest copy of a file asked for every time: the last one kept on use, else the one this build's install fetched.
const keptCopy = async (request) => (await (await caches.open(ASSET_CACHE)).match(request)) ?? caches.match(request);

// Asked every time, kept for the time asking fails. Kept even under no-store: the copy answers only an outage.
const networkFirst = async (event) => {
    let response;
    try {
        response = await fetch(event.request);
    } catch (error) {
        const hit = await keptCopy(event.request);
        if (hit !== undefined) {
            return hit;
        }
        throw error;
    }
    if (response.status === 200 && response.type === `basic`) {
        const copy = response.clone();
        event.waitUntil(caches.open(ASSET_CACHE).then((cache) => cache.put(event.request, copy)));
        return response;
    }
    return (fallsBack(response.status) ? await keptCopy(event.request) : undefined) ?? response;
};

// This build's shell and critical chunks, each on its own: one that fails is said and skipped, never a failed install,
// since an install that fails is also a push worker that never arrives.
const precache = async (manifest) => {
    const store = await caches.open(`${PRECACHE_PREFIX}${manifest.build}`);
    const pending = [...manifest.urls];
    const fetchOne = async (url) => {
        if (url === SHELL_KEY) {
            const response = await fetch(url, { cache: `no-store`, credentials: `omit` });
            if (isShell(response)) {
                await (await caches.open(SHELL_CACHE)).put(SHELL_KEY, response);
            }
            return;
        }
        if ((await store.match(url)) !== undefined) {
            return;
        }
        const response = await fetch(url, { credentials: `omit` });
        if (response.status === 200 && response.type === `basic`) {
            await store.put(url, response);
        }
    };
    const worker = async () => {
        for (let url = pending.shift(); url !== undefined; url = pending.shift()) {
            try {
                await fetchOne(url);
            } catch (error) {
                console.warn(`[sw] could not keep ${url} for offline use:`, error);
            }
        }
    };
    await Promise.all(Array.from({ length: PRECACHE_BATCH }, worker));
};

// Builds are named by their start time, so the newest sorts first.
const newestFirst = (a, b) => b.localeCompare(a, `en`, { numeric: true });

// This build's precache and the one before it (a tab still running that build loads its chunks from there); the
// on-use chunks held to their cap, oldest first.
const prune = async (manifest) => {
    const current = `${PRECACHE_PREFIX}${manifest.build}`;
    const older = (await caches.keys()).filter((name) => name.startsWith(PRECACHE_PREFIX) && name !== current).sort(newestFirst);
    await Promise.all(older.slice(1).map((name) => caches.delete(name)));
    const assets = await caches.open(ASSET_CACHE);
    const kept = await assets.keys();
    await Promise.all(kept.slice(0, Math.max(0, kept.length - ASSET_CAP)).map((request) => assets.delete(request)));
};

// Take over as soon as installed rather than waiting for every tab to close: a user who just enabled
// notifications expects the next turn to reach them, not the one after their next full browser restart. An open tab
// keeps running: the new worker answers only its next requests, the same way the old one did, and never reloads it.
self.addEventListener("install", (event) => {
    self.skipWaiting();
    if (PRECACHE !== null) {
        event.waitUntil(precache(PRECACHE));
    }
});
self.addEventListener("activate", (event) => event.waitUntil(Promise.all([self.clients.claim(), PRECACHE === null ? undefined : prune(PRECACHE)])));

self.addEventListener("fetch", (event) => {
    if (PRECACHE === null) {
        return;
    }
    const kind = kindOf(event.request, self.location.origin);
    if (kind === `shell`) {
        event.respondWith(navigate(event));
    } else if (kind === `asset`) {
        event.respondWith(cacheFirst(event));
    } else if (kind === `fresh`) {
        event.respondWith(networkFirst(event));
    }
});

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
                // The open app routes there itself (workbench/notifications/notificationTaps.ts), keeping its streams and
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
