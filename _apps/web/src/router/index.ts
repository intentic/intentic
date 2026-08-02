import { useDevice } from "@intentic-app/ui";
import { createRouter, createWebHistory, type RouteLocationRaw, type RouteRecordRaw } from "vue-router";
import { restorePersistedQueries } from "../composables/queryPersistence";
import { useAuth } from "../composables/useAuth";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { setupRedirect } from "./setupGate";

declare module "vue-router" {
    interface RouteMeta {
        title?: string;
    }
}

// Resolve the session once (Better Auth cookie) and redirect to /login if none — an unreachable API counts
// as signed-out (a rejected guard would abort navigation and leave a blank screen). With a user in hand,
// hydrate the query cache from IndexedDB (per-user buster) before any route mounts — a reload paints the
// last-known workspace instead of blocking on the daemon.
const requireAuth = async (): Promise<boolean | RouteLocationRaw> => {
    const { user, refresh } = useAuth();
    const current = user.value ?? (await refresh().catch(() => null));
    if (!current) {
        return `/login`;
    }
    await restorePersistedQueries(current.id);
    return true;
};

// Gate the workspace shell on having a workspace to open — setupGate.ts owns the predicate and the reasoning.
const requireSetup = async (): Promise<boolean | RouteLocationRaw> => {
    const { list } = useSandbox();
    return setupRedirect(await list()) ?? true;
};

// Chat, Menu, and Terminal are full-screen tabs only on the mobile shell — the desktop shell docks chat and
// the terminal and puts the menu's contents on the rail, so a desktop hit lands on the workspace instead.
const mobileOnly = (): boolean | RouteLocationRaw => (useDevice().mobile.value ? true : `/workspace`);

const routes: RouteRecordRaw[] = [
    {
        path: `/login`,
        name: `login`,
        meta: { title: `Login` },
        component: () => import(`../pages/Login.vue`),
    },
    {
        /* The desktop app's sign-in, in the user's REAL browser. The app can't run Google's flow in its own
         * webview (see environments/desktop.ts), so it opens this page in the default browser: requireAuth
         * makes it an ordinary sign-in, and the page then hands the credentials back over `intentic://auth`.
         * A person who lands here without an app just sees an explanation. */
        path: `/desktop-auth`,
        name: `desktop-auth`,
        meta: { title: `Sign in to Intentic` },
        beforeEnter: [requireAuth],
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
            // keeps the workspace (its chat is docked).
            { path: ``, redirect: () => (useDevice().mobile.value ? `/agents` : `/workspace`) },
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
                meta: { title: `Add a capability` },
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
            { path: `drafts`, name: `drafts`, meta: { title: `Drafts` }, component: () => import(`../pages/Drafts.vue`) },
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
