import type { User } from "@intentic-app/api-contract";
import { useDevice } from "@intentic/ui";
import { createRouter, createWebHistory, type RouteLocationNormalized, type RouteLocationRaw, type RouteRecordRaw } from "vue-router";
import { restorePersistedQueries } from "../composables/queryPersistence";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { setupRedirect } from "./setupGate";

declare module "vue-router" {
    interface RouteMeta {
        title?: string;
    }
}

// Resolve the session once (Better Auth cookie) and redirect to /login only when the platform AUTHORITATIVELY
// says none. An unavailable platform gets its own retry screen; it is not evidence that the user signed out.
type Resolved = { readonly user: User } | { readonly redirect: RouteLocationRaw };

const resolveUser = async (to: RouteLocationNormalized): Promise<Resolved> => {
    const { user, refresh } = useAuth();
    let current = user.value;
    if (current === null) {
        try {
            current = await refresh();
        } catch {
            return { redirect: { path: `/platform-unavailable`, query: { returnTo: to.fullPath } } };
        }
    }
    return current ? { user: current } : { redirect: `/login` };
};

// Signed in, with a user in hand — and hydrate the query cache from IndexedDB (per-user buster) before any
// route mounts, so a reload paints the last-known workspace instead of blocking on the daemon.
const requireAuth = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> => {
    const resolved = await resolveUser(to);
    if (!(`user` in resolved)) {
        return resolved.redirect;
    }
    await restorePersistedQueries(resolved.user.id);
    return true;
};

// Signed in and NOTHING else, for a page that mounts no query of its own. /desktop-auth is the one that
// cares: it reads nothing from the cache, and hydrating a whole workspace's worth of it would be a disk read
// standing between the user and the Google prompt that page exists to show.
const requireSession = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> => {
    const resolved = await resolveUser(to);
    return `user` in resolved ? true : resolved.redirect;
};

/* GOOGLE FIRST, SESSION SECOND. Minting the ID token needs nothing from the platform, so letting it wait for
 * the session round trip — and then for this page's own chunk to arrive, and then for it to mount — is dead
 * time charged to the one screen whose entire content is a person waiting for Google to appear. Synchronous:
 * it returns in the same tick, and the awaited guard after it runs against a prompt already in flight.
 *
 * Only with the app's handoff parameters in hand. Someone who lands here by hand has nothing to hand off, and
 * a Google prompt on a page that is about to say so would be a prompt nobody asked for. */
const startGoogleMint = (to: RouteLocationNormalized): true => {
    if (typeof to.query[`state`] === `string` && typeof to.query[`challenge`] === `string`) {
        void useGoogleIdentity().getIdToken({ gate: false });
    }
    return true;
};

// Gate the workspace shell on having a workspace to open — setupGate.ts owns the predicate and the reasoning.
const requireSetup = async (): Promise<boolean | RouteLocationRaw> => {
    const { list } = useSandbox();
    return setupRedirect(await list()) ?? true;
};

// Menu and Terminal are full-screen tabs only on the mobile shell — the desktop shell docks the terminal and
// puts the menu's contents on the rail, so a desktop hit lands on the workspace instead.
const mobileOnly = (): boolean | RouteLocationRaw => (useDevice().mobile.value ? true : `/workspace`);

// …and full-screen chat is the desktop's alone, the mirror image: the mobile shell's chat is the agent route
// (an agent's conversation IS its chat surface there), so a mobile hit lands on the fleet those live behind.
const desktopOnly = (): boolean | RouteLocationRaw => (useDevice().mobile.value ? `/agents` : true);

const routes: RouteRecordRaw[] = [
    {
        path: `/login`,
        name: `login`,
        meta: { title: `Login` },
        component: () => import(`../pages/Login.vue`),
    },
    {
        path: `/platform-unavailable`,
        name: `platform-unavailable`,
        meta: { title: `Can't reach Intentic` },
        component: () => import(`../pages/PlatformUnavailable.vue`),
    },
    {
        /* The desktop app's sign-in, in the user's REAL browser. The app can't run Google's flow in its own
         * webview (see environments/desktop.ts), so it opens this page in the default browser: requireAuth
         * makes it an ordinary sign-in, and the page then hands the credentials back over `intentic://auth`.
         * A person who lands here without an app just sees an explanation. */
        path: `/desktop-auth`,
        name: `desktop-auth`,
        meta: { title: `Sign in to Intentic` },
        beforeEnter: [startGoogleMint, requireSession],
        component: () => import(`../pages/DesktopAuth.vue`),
    },
    {
        // …and the other end, opened INSIDE the app's webview: redeem the handoff, which is what puts the
        // session cookie in this webview's jar. Unguarded on purpose — the whole point is that there is no
        // session here yet.
        path: `/desktop-auth/complete`,
        name: `desktop-auth-complete`,
        meta: { title: `Signing in…` },
        component: () => import(`../pages/DesktopAuthComplete.vue`),
    },
    {
        // Initial-setup / recovery view. Outside the shell; signed-in but bounced back to the workspace once the
        // sandbox is connected (redirectIfReady).
        path: `/setup`,
        name: `setup`,
        meta: { title: `Setup` },
        beforeEnter: [requireAuth],
        component: () => import(`../pages/Setup.vue`),
    },
    {
        // Persistent workspace shell (rail + shared chat + area outlet). Guarded: signed in AND sandbox
        // connected; otherwise requireSetup redirects to /setup (so all shell navigation is blocked until setup
        // completes).
        path: `/`,
        beforeEnter: [requireAuth, requireSetup],
        component: () => import(`../shell/WorkspaceShell.vue`),
        children: [
            // Mobile lands on the agent fleet — glance at every running agent, tap in to drive one; desktop
            // keeps the workspace (its chat is docked), on the first session out of setup as much as on any
            // later one: the workspace is where the code is, where getting code IN is offered, and where the
            // docked chat is already sitting to be typed at.
            { path: ``, redirect: () => (useDevice().mobile.value ? `/agents` : `/workspace`) },
            // Full-screen chat: the rail-docked chat's whole surface (pages/ChatArea.vue lends it the slot,
            // and standing here is what makes the rail the chat's home — useLayout.chatHome). An area rather
            // than a layout switch, so the rail, the back button and a reload all already know how to enter
            // and leave it.
            { path: `chat`, name: `chat`, meta: { title: `Chat` }, beforeEnter: [desktopOnly], component: () => import(`../pages/ChatArea.vue`) },
            { path: `agents`, name: `agents`, meta: { title: `Agents` }, component: () => import(`../pages/Agents.vue`) },
            // Drill-in for one agent: full-screen chat + isolated diff review. The old mobile /chat tab folded
            // in here (an agent's conversation IS the chat surface).
            { path: `agents/:id`, name: `agent`, meta: { title: `Agent` }, component: () => import(`../agents/AgentDetail.vue`) },
            { path: `menu`, name: `menu`, meta: { title: `Menu` }, beforeEnter: [mobileOnly], component: () => import(`../pages/MobileMenu.vue`) },
            {
                path: `terminal`,
                name: `terminal`,
                meta: { title: `Terminal` },
                beforeEnter: [mobileOnly],
                component: () => import(`../pages/MobileTerminal.vue`),
            },
            {
                path: `capabilities/:card?`,
                name: `capabilities`,
                meta: { title: `Capabilities` },
                component: () => import(`../pages/Capabilities.vue`),
            },
            { path: `sandbox/:tab?`, name: `sandbox`, meta: { title: `Sandbox` }, component: () => import(`../pages/SandboxHub.vue`) },
            // Splat param: the open file's path lives in the URL (`/workspace/src/foo.ts`) so a reload or a
            // shared link reopens it. Optional/repeatable, so bare `/workspace` still matches (path === "").
            {
                path: `workspace/:path(.*)*`,
                name: `workspace`,
                meta: { title: `Workspace` },
                component: () => import(`../pages/workspace/Workspace.vue`),
            },
            // The session is in the URL so a reload reopens the same browser; optional, because the rail tile
            // links to the bare path and the view picks the most recently active one.
            { path: `browsers/:session?`, name: `browsers`, meta: { title: `Browsers` }, component: () => import(`../pages/Browsers.vue`) },
            // Same shape and same reason as the browsers above: the id is in the URL so a reload — or the chat
            // card's link — reopens the same agent, and the bare path shows whichever is most recently active.
            { path: `subagents/:id?`, name: `subagents`, meta: { title: `Subagents` }, component: () => import(`../pages/Subagents.vue`) },
            { path: `ext/:ext/:key?`, name: `extension`, component: () => import(`../pages/ExtensionHost.vue`) },
            { path: `settings/:tab?`, name: `settings`, meta: { title: `Settings` }, component: () => import(`../pages/SettingsHub.vue`) },
        ],
    },
    {
        // Public invite-accept landing (the emailed link). No guard — the invitee may be logged out or on the
        // wrong Google account; the page drives sign-in as the invited address, then flips the pending grant.
        path: `/invite/:token`,
        name: `invite`,
        meta: { title: `Accept invite` },
        component: () => import(`../pages/AcceptInvite.vue`),
    },
    /* THE KIT, ON ONE PAGE — dev only, and unguarded on purpose: it needs no session, no sandbox and no
     * repository, so it opens in any state the app can be in. `import.meta.env.DEV` is a compile-time constant,
     * so the route and its whole component graph vanish from a production build rather than shipping behind a
     * check. It exists because the drift this app kept growing — thirteen dialog widths, two red boxes, four
     * captions off the type scale — is invisible in a file and obvious the moment the variants are in a row. */
    ...(import.meta.env.DEV
        ? [{ path: `/kit`, name: `kit`, meta: { title: `Design kit` }, component: () => import(`../pages/DesignKit.vue`) } satisfies RouteRecordRaw]
        : []),
    { path: `/:pathMatch(.*)*`, redirect: `/` },
];

export const router = createRouter({
    /* The build's own base, not vue-router's default. Its default is a `<base href>` element or `/` — it never
     * looks at Vite's, so an app built under a path prefix routed as if it were at the root: every path resolved
     * one level up from where its own bundle lives. `/` for this app, which is why nothing here changes; the
     * interactive demo (@intentic-dev/demo) builds the same source under `/demo/` and is what surfaced it. */
    history: createWebHistory(import.meta.env.BASE_URL),
    routes,
});

/* A redeploy replaces every content-hashed chunk, and every route above is a lazy import — so a window opened
 * before the deploy holds an index.html whose routes point at files that no longer exist. Clicking one made the
 * URL flicker and settle back where it was: the dynamic import rejects, vue-router aborts the navigation, and
 * nothing said why — the app just looked broken until the user happened to hard-refresh. A failed chunk load IS
 * "this window is stale", so answer it with the reload the user would eventually perform by hand, landed on the
 * route they asked for rather than the one they were leaving.
 *
 * Matched on the wording the runtimes actually produce (Chromium/Firefox/Safari phrase the import failure
 * differently, and Vite's own preload helper rethrows CSS failures with its own message) rather than on error
 * class — a TypeError is also what a coding bug inside a route component throws, and reloading on those would
 * turn any real regression into a reload loop. The per-target flag is the loop guard for a chunk that is
 * GENUINELY gone (a broken deploy): one reload per destination, then the old silent abort; cleared by any
 * navigation that lands, so the next redeploy gets its one reload again. */
const CHUNK_RELOADED_KEY = `intentic.chunkReloaded`;
const STALE_CHUNK_MESSAGE =
    /error loading dynamically imported module|failed to fetch dynamically imported module|importing a module script failed|unable to preload css/i;
router.onError((error, to) => {
    if (!STALE_CHUNK_MESSAGE.test(String(error))) {
        return;
    }
    try {
        if (sessionStorage.getItem(CHUNK_RELOADED_KEY) === to.fullPath) {
            return;
        }
        sessionStorage.setItem(CHUNK_RELOADED_KEY, to.fullPath);
    } catch {
        return; // no storage, no loop guard — the silent abort is safer than a possible reload loop
    }
    location.assign(to.fullPath);
});

// Formats the browser tab as `<Page> / intentic` from each route's `title`, falling back to the bare brand
// when a route declares none (replaces the route title strategy).
router.afterEach((to, _from, failure) => {
    if (failure === undefined) {
        try {
            sessionStorage.removeItem(CHUNK_RELOADED_KEY);
        } catch {
            // No storage to clean.
        }
    }
    document.title = to.meta.title ? `${to.meta.title} / intentic` : `intentic`;
});
