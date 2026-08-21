import type { User } from "@intentic-app/api-contract";
import { useDevice } from "@intentic/ui";
import { type FunctionalComponent, h } from "vue";
import { createRouter, createWebHistory, type RouteLocationNormalized, type RouteLocationRaw, type RouteRecordRaw } from "vue-router";
import { asyncView } from "../components/asyncView";
import SplitViewOutline from "../components/SplitViewOutline.vue";
import { restorePersistedQueries } from "../composables/queryPersistence";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { setupRedirect } from "./setupGate";
import { isStaleChunkError, recoverStaleChunk } from "./staleChunk";

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

// Signed in, with a user in hand, and hydrate the query cache from IndexedDB (per-user buster) before any
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
 * the session round trip, and then for this page's own chunk to arrive, and then for it to mount, is dead
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

// Gate the workspace shell on having a workspace to open, setupGate.ts owns the predicate and the reasoning.
const requireSetup = async (): Promise<boolean | RouteLocationRaw> => {
    const { list } = useSandbox();
    return setupRedirect(await list()) ?? true;
};

// Menu and Terminal are full-screen tabs only on the mobile shell, the desktop shell docks the terminal and
// puts the menu's contents on the rail, so a desktop hit lands on the workspace instead.
const mobileOnly = (): boolean | RouteLocationRaw => (useDevice().mobile.value ? true : `/workspace`);

// …and full-screen chat is the desktop's alone, the mirror image: the mobile shell's chat is the agent route
// (an agent's conversation IS its chat surface there), so a mobile hit lands on the fleet those live behind.
const desktopOnly = (): boolean | RouteLocationRaw => (useDevice().mobile.value ? `/agents` : true);

/* NAVIGATION NEVER WAITS, the in-shell routes below register through asyncView rather than as bare lazy
 * imports, because vue-router completes a navigation only once a route-level `() => import(…)` has resolved:
 * the click froze for as long as the chunk download took, charged to whichever destination was heaviest.
 * asyncView's wrapper is synchronous, so the view flips in the same tick; the code arrives behind an outline
 * (components/asyncView.ts owns the mechanism and the failure path, router/prefetch.ts pulls the chunks at
 * idle so the outline is a cold-network-only event).
 *
 * The entry-point routes, login, setup handoffs, the invite landing, the shell record itself, stay as bare
 * lazy imports on purpose: they are first paints, not transitions away from a view the user is looking at, so
 * there is nothing on screen for them to un-freeze.
 *
 * An index-and-body page gets the outline of its own shape, wearing its REAL title and description, static
 * strings this table already knows. Full-bleed surfaces (workspace, chat, terminals, the fleets) get none:
 * their honest placeholder is the shell's own background, and each draws its inner skeletons once mounted. */
const hubOutline = (title: string, description: string, railRows: number): FunctionalComponent => {
    return () => h(SplitViewOutline, { title, description, railRows });
};

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
        // session cookie in this webview's jar. Unguarded on purpose, the whole point is that there is no
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
        // Wrapped although it is outside the shell: "Add sandbox" reaches it FROM the shell, and that click
        // deserves the same instant flip as any other. Full-screen wizard, so no outline to promise.
        component: asyncView(() => import(`../pages/Setup.vue`)),
    },
    {
        // Persistent workspace shell (rail + shared chat + area outlet). Guarded: signed in AND sandbox
        // connected; otherwise requireSetup redirects to /setup (so all shell navigation is blocked until setup
        // completes).
        path: `/`,
        beforeEnter: [requireAuth, requireSetup],
        component: () => import(`../shell/WorkspaceShell.vue`),
        children: [
            /* WHERE SETUP LETS GO OF THE USER: mobile lands on the agent fleet, desktop on the workspace (its
             * chat is docked), the workspace is where the code is, where getting code IN is offered, and
             * where the docked chat is already sitting to be typed at. */
            {
                path: ``,
                redirect: () => (useDevice().mobile.value ? `/agents` : `/workspace`),
            },
            // Full-screen chat: the rail-docked chat's whole surface (pages/ChatArea.vue lends it the slot,
            // and standing here is what makes the rail the chat's home, useLayout.chatHome). An area rather
            // than a layout switch, so the rail, the back button and a reload all already know how to enter
            // and leave it.
            {
                path: `chat`,
                name: `chat`,
                meta: { title: `Chat` },
                beforeEnter: [desktopOnly],
                component: asyncView(() => import(`../pages/ChatArea.vue`)),
            },
            // The live app preview: the preview panel's full-window home (pages/PreviewArea.vue lends it the
            // slot, exactly the chat area's arrangement). Desktop only, the mobile shell mounts no poppable
            // panels, and a phone opens the preview URL itself.
            {
                path: `preview`,
                name: `preview`,
                meta: { title: `Preview` },
                beforeEnter: [desktopOnly],
                component: asyncView(() => import(`../pages/PreviewArea.vue`)),
            },
            { path: `agents`, name: `agents`, meta: { title: `Agents` }, component: asyncView(() => import(`../pages/Agents.vue`)) },
            // Drill-in for one agent: full-screen chat + isolated diff review. The old mobile /chat tab folded
            // in here (an agent's conversation IS the chat surface).
            { path: `agents/:id`, name: `agent`, meta: { title: `Agent` }, component: asyncView(() => import(`../agents/AgentDetail.vue`)) },
            {
                path: `menu`,
                name: `menu`,
                meta: { title: `Menu` },
                beforeEnter: [mobileOnly],
                component: asyncView(() => import(`../pages/MobileMenu.vue`)),
            },
            {
                path: `terminal`,
                name: `terminal`,
                meta: { title: `Terminal` },
                beforeEnter: [mobileOnly],
                component: asyncView(() => import(`../pages/MobileTerminal.vue`)),
            },
            {
                path: `capabilities/:card?`,
                name: `capabilities`,
                meta: { title: `Capabilities` },
                // The title and description mirror the page's own (pages/Capabilities.vue, its catalog copy),
                // static strings, so the outline wears the real heading in the first frame.
                component: asyncView(
                    () => import(`../pages/Capabilities.vue`),
                    hubOutline(
                        `Capabilities`,
                        `Grow your sandbox: each capability gives your agent new tools or connects your accounts. Everything is stored only in your sandbox.`,
                        6,
                    ),
                ),
            },
            {
                path: `sandbox/:tab?`,
                name: `sandbox`,
                meta: { title: `Sandbox` },
                // The hub titles itself with the active sandbox's NAME once mounted; the outline says what the
                // page is rather than guessing which box, and the description is the hub's own (SandboxHub.vue).
                component: asyncView(
                    () => import(`../pages/SandboxHub.vue`),
                    hubOutline(
                        `Sandbox`,
                        `The workspace AI operates from. The platform keeps only its address; accounts and credentials stay inside it.`,
                        7,
                    ),
                ),
            },
            // Splat param: the open file's path lives in the URL (`/workspace/src/foo.ts`) so a reload or a
            // shared link reopens it. Optional/repeatable, so bare `/workspace` still matches (path === "").
            {
                path: `workspace/:path(.*)*`,
                name: `workspace`,
                meta: { title: `Workspace` },
                component: asyncView(() => import(`../pages/workspace/Workspace.vue`)),
            },
            // The session is in the URL so a reload reopens the same browser; optional, because the rail tile
            // links to the bare path and the view picks the most recently active one.
            {
                path: `browsers/:session?`,
                name: `browsers`,
                meta: { title: `Browsers` },
                component: asyncView(() => import(`../pages/Browsers.vue`)),
            },
            // Same shape and same reason as the browsers above: the id is in the URL so a reload, or the chat
            // card's link, reopens the same agent, and the bare path shows whichever is most recently active.
            { path: `subagents/:id?`, name: `subagents`, meta: { title: `Subagents` }, component: asyncView(() => import(`../pages/Subagents.vue`)) },
            { path: `ext/:ext/:key?`, name: `extension`, component: asyncView(() => import(`../pages/ExtensionHost.vue`)) },
            {
                path: `settings/:tab?`,
                name: `settings`,
                meta: { title: `Settings` },
                // Mirrors the page's own heading (pages/SettingsHub.vue).
                component: asyncView(
                    () => import(`../pages/SettingsHub.vue`),
                    hubOutline(`Settings`, `Your personal preferences on this platform.`, 5),
                ),
            },
        ],
    },
    {
        // Public invite-accept landing (the emailed link). No guard, the invitee may be logged out or on the
        // wrong Google account; the page drives sign-in as the invited address, then flips the pending grant.
        path: `/invite/:token`,
        name: `invite`,
        meta: { title: `Accept invite` },
        component: () => import(`../pages/AcceptInvite.vue`),
    },

    /* ══ THE THREE SANDBOX-FREE SURFACES ══════════════════════════════════════════════════════════════════
     *
     * All three belong to somebody who reached this platform from a terminal on their own laptop and owns no
     * sandbox: their coding agent asked for a paid service, and these are sign-in, payment and approval.
     *
     * DELIBERATELY OUTSIDE THE SHELL, and that placement is the entire point rather than a layout preference.
     * Every route under `/` is guarded by requireSetup, which redirects anyone whose sandboxes have never
     * phoned home to /setup, so the membership tab, the only buying surface this product had, was unreachable
     * by exactly the people most likely to want to buy one. A membership was always an account's rather than a
     * machine's; this is where that stops being a claim.
     *
     * `requireAuth` is not used on any of them either, for the same reason: it hydrates a workspace's query
     * cache and then bounces to /login, whose own success path pushes into the shell. Each page resolves the
     * session itself and drives its own Google sign-in, returning to its own full path. */
    {
        // Where Better Auth's OAuth authorize sends an unauthenticated MCP client's owner (api auth.ts).
        path: `/connect`,
        name: `connect`,
        meta: { title: `Connect to intentic` },
        component: () => import(`../pages/Connect.vue`),
    },
    {
        // Buying a membership with no sandbox anywhere in the story. Stripe returns here, not to settings.
        path: `/join`,
        name: `join`,
        meta: { title: `Join intentic` },
        component: () => import(`../pages/Join.vue`),
    },
    {
        /* The spend gate's wall. The ONLY place a parked service run becomes an approved one, and the reason
         * an agent outside a sandbox can be handed a spending catalogue at all, since nothing it says about
         * consent is read anywhere and the run re-reads what this page wrote. */
        path: `/approve/:id`,
        name: `approve`,
        meta: { title: `Approve a run` },
        component: () => import(`../pages/ApproveRun.vue`),
    },
    /* THE KIT, ON ONE PAGE, dev only, and unguarded on purpose: it needs no session, no sandbox and no
     * repository, so it opens in any state the app can be in. `import.meta.env.DEV` is a compile-time constant,
     * so the route and its whole component graph vanish from a production build rather than shipping behind a
     * check. It exists because the drift this app kept growing, thirteen dialog widths, two red boxes, four
     * captions off the type scale, is invisible in a file and obvious the moment the variants are in a row. */
    ...(import.meta.env.DEV
        ? [{ path: `/kit`, name: `kit`, meta: { title: `Design kit` }, component: () => import(`../pages/DesignKit.vue`) } satisfies RouteRecordRaw]
        : []),
    { path: `/:pathMatch(.*)*`, redirect: `/` },
];

export const router = createRouter({
    /* The build's own base, not vue-router's default. Its default is a `<base href>` element or `/`, it never
     * looks at Vite's, so an app built under a path prefix routed as if it were at the root: every path resolved
     * one level up from where its own bundle lives. `/` for this app, which is why nothing here changes; the
     * interactive demo (@intentic-dev/demo) builds the same source under `/demo/` and is what surfaced it. */
    history: createWebHistory(import.meta.env.BASE_URL),
    routes,
});

/* The stale-window recovery's ROUTER half (staleChunk.ts owns the shared detection and the one-reload guard;
 * asyncView owns the other half, for the in-shell views whose failures no router hook can see). This backstop
 * covers what still loads at route level, login, the auth handoffs, the invite landing, the workspace shell
 * itself: a dead chunk there rejects the navigation, and the answer is the reload the user would eventually
 * perform by hand, landed on the route they asked for rather than the one they were leaving. */
router.onError((error, to) => {
    if (isStaleChunkError(error)) {
        recoverStaleChunk(to.fullPath);
    }
});

/* The reload guard is NOT cleared here anymore. It used to be, "a navigation landed" was proof the window's
 * chunks exist, because a navigation could not land without its chunk. asyncView broke that implication on
 * purpose: every in-shell navigation lands instantly, chunk or no chunk, so clearing on arrival would re-arm
 * the guard between the reload and the retry and turn a genuinely broken deploy into a reload loop. The clear
 * lives where the evidence is now: a chunk actually resolving (asyncView). */

// Formats the browser tab as `<Page> / intentic` from each route's `title`, falling back to the bare brand
// when a route declares none (replaces the route title strategy).
router.afterEach((to) => {
    document.title = to.meta.title ? `${to.meta.title} / intentic` : `intentic`;
});
