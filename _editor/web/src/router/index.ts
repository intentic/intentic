import type { User } from "@intentic/api-contract";
import { useDevice } from "@intentic/ui";
import { type FunctionalComponent, h } from "vue";
import { createRouter, createWebHistory, type RouteLocationNormalized, type RouteLocationRaw, type RouteRecordRaw } from "vue-router";
import { asyncView } from "../components/asyncView";
import { homeViewId, PROJECTS_VIEW_ID } from "../core-views/registry";
import { conversationRedirect } from "./conversationLink";
import { mobileChatPath } from "../shell/tabRoots";
import SplitViewOutline from "../components/SplitViewOutline.vue";
import { restorePersistedQueries } from "../lib/queryPersistence";
import { useAuth } from "../features/auth/useAuth";
import { useGoogleIdentity } from "../features/auth/useGoogleIdentity";
import { useSandbox } from "../features/sandbox/client/useSandbox";
import { useRole } from "../features/sandbox/secrets/useRole";
import { setupRedirect } from "./setupGate";
import { signInAt } from "./signIn";
import { isStaleChunkError, recoverStaleChunk } from "./staleChunk";
import { t } from "@intentic/ui/i18n";

declare module "vue-router" {
    interface RouteMeta {
        /**
         * The tab title, as a function rather than a string: the route table is built once, while this module is
         * still being imported, and `t` has no catalog to read yet. Called on every navigation instead (below).
         */
        title?: () => string;
    }
}

// Resolves the session once (Better Auth cookie); redirects to /login only when the platform authoritatively says none.
// An unavailable platform gets its own retry screen, not treated as a sign-out.
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
    // Signed out: the login screen carries the page that asked for it.
    return current ? { user: current } : { redirect: signInAt(to.fullPath) };
};

// Signed in, with a user in hand: hydrate the query cache from IndexedDB (per-user buster) before any route mounts, so
// a reload paints the last-known workspace instead of blocking on the daemon.
const requireAuth = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> => {
    const resolved = await resolveUser(to);
    if (!(`user` in resolved)) {
        return resolved.redirect;
    }
    await restorePersistedQueries(resolved.user.id);
    return true;
};

// Google minting starts immediately, before the session round trip or this page's chunk, so the wait is not dead time
// on a screen whose whole content is waiting for Google; only when the app's handoff params are present.
const startGoogleMint = (to: RouteLocationNormalized): true => {
    if (typeof to.query[`state`] === `string` && typeof to.query[`challenge`] === `string`) {
        void useGoogleIdentity().getIdToken({ gate: false });
    }
    return true;
};

// Gates the workspace shell on having a workspace to open; setupGate.ts owns the predicate.
const requireSetup = async (): Promise<boolean | RouteLocationRaw> => {
    const { list } = useSandbox();
    return setupRedirect(await list()) ?? true;
};

// Menu and Terminal are full-screen tabs only on the mobile shell; the desktop shell docks the terminal and puts the
// menu's contents on the rail, so a desktop hit lands on the workspace instead.
const mobileOnly = (): boolean | RouteLocationRaw => (useDevice().mobile.value ? true : `/workspace`);

// Full-screen chat is the desktop's alone: the mobile shell's chat is the agent route (a conversation is its chat
// surface there), so a mobile hit lands on the fleet those live behind.
const desktopOnly = (): boolean | RouteLocationRaw => (useDevice().mobile.value ? `/agents` : true);

// /chat on a phone is the Chat tab: the active conversation's own screen. The store is imported at the press, not
// at module load, so the router does not pull the chat's whole graph into every first paint.
const chatEntry = async (): Promise<boolean | RouteLocationRaw> => {
    if (!useDevice().mobile.value) {
        return true;
    }
    const { useChat } = await import(`../features/chat/run/useChat`);
    return mobileChatPath(useChat().active.value.conversationId);
};

// In-shell routes wrap in asyncView so a click never blocks on a chunk download; only first-paint entry routes (login,
// setup, invite, the shell) stay bare lazy imports.
const hubOutline = (title: string, description: string, railRows: number): FunctionalComponent => {
    return () => h(SplitViewOutline, { title, description, railRows });
};

const routes: RouteRecordRaw[] = [
    {
        path: `/login`,
        name: `login`,
        meta: { title: () => t(`router.index.login`) },
        component: () => import(`../features/auth/Login.vue`),
    },
    {
        path: `/platform-unavailable`,
        name: `platform-unavailable`,
        meta: { title: () => t(`router.index.cantReachIntentic`) },
        component: () => import(`../features/setup/PlatformUnavailable.vue`),
    },
    {
        // Desktop app's sign-in, opened in the OS's real browser (it cannot run Google's flow in its own webview).
        // Deliberately unguarded, since that browser is often not signed in as this app's user.
        path: `/desktop-auth`,
        name: `desktop-auth`,
        meta: { title: () => t(`router.index.signInToIntentic`) },
        beforeEnter: [startGoogleMint],
        component: () => import(`../features/auth/DesktopAuth.vue`),
    },
    {
        // Opened inside the app's webview: redeems the handoff, putting the session cookie in this webview's jar.
        // Unguarded on purpose, there is no session here yet.
        path: `/desktop-auth/complete`,
        name: `desktop-auth-complete`,
        meta: { title: () => t(`router.index.signingIn`) },
        component: () => import(`../features/auth/DesktopAuthComplete.vue`),
    },
    {
        // Initial-setup / recovery view. Outside the shell; signed-in but bounced back to the workspace once the
        // sandbox is connected (redirectIfReady).
        path: `/setup`,
        name: `setup`,
        meta: { title: () => t(`router.index.setup`) },
        beforeEnter: [requireAuth],
        // Wrapped although it is outside the shell: "Add sandbox" reaches it from the shell, and that click deserves
        // the same instant flip as any other. Full-screen wizard, so no outline to promise.
        component: asyncView(() => import(`../features/setup/Setup.vue`)),
    },
    {
        // A floating panel's own window (chat, terminal or preview), no shell around it, nothing to navigate. Guarded
        // like the shell; the path enumerates the three panels, an unknown one falls through.
        path: `/floating/:panel(chat|terminal|preview)`,
        name: `floating`,
        beforeEnter: [requireAuth, requireSetup],
        component: () => import(`../features/chat/panel/FloatingSection.vue`),
    },
    {
        // Persistent workspace shell (rail + shared chat + area outlet). Guarded: signed in and sandbox connected;
        // otherwise requireSetup redirects to /setup, so all shell navigation is blocked until setup completes.
        path: `/`,
        beforeEnter: [requireAuth, requireSetup],
        component: () => import(`../shell/WorkspaceShell.vue`),
        children: [
            // Where setup lets go of the user: mobile lands on the agent fleet, desktop on the home seat, where its
            // chat is already docked: the file tree, or a maker's Project page once that extension has registered.
            // A guest has no home seat but the chat: the tree and the Project page are reads the daemon refuses it.
            {
                path: ``,
                redirect: () =>
                    useRole().isGuest.value
                        ? `/chat`
                        : useDevice().mobile.value
                          ? `/agents`
                          : homeViewId() === PROJECTS_VIEW_ID
                            ? `/ext/${PROJECTS_VIEW_ID}`
                            : `/workspace`,
            },
            // Full-screen chat: the rail-docked chat's own surface, expanded. A route rather than a layout switch, so
            // the rail, back button and reload already know how to enter and leave it. On a phone, the Chat tab.
            {
                path: `chat`,
                name: `chat`,
                meta: { title: () => t(`router.index.chat`) },
                beforeEnter: [chatEntry],
                component: asyncView(() => import(`../features/chat/panel/ChatSection.vue`)),
            },
            // The live app preview's full-window home, same arrangement as the chat route. Desktop only: the mobile
            // shell mounts no poppable panels, and a phone opens the preview URL directly.
            {
                path: `preview`,
                name: `preview`,
                meta: { title: () => t(`router.index.preview`) },
                beforeEnter: [desktopOnly],
                component: asyncView(() => import(`../features/preview/PreviewArea.vue`)),
            },
            {
                path: `agents`,
                name: `agents`,
                meta: { title: () => t(`router.index.agents`) },
                component: asyncView(() => import(`../features/agents/fleet/Agents.vue`)),
            },
            // Drill-in for one agent: full-screen chat plus isolated diff review; an agent's conversation is its chat
            // surface.
            {
                path: `agents/:id`,
                name: `agent`,
                meta: { title: () => t(`router.index.agent`) },
                component: asyncView(() => import(`../features/agents/review/AgentDetail.vue`)),
            },
            {
                path: `menu`,
                name: `menu`,
                meta: { title: () => t(`router.index.menu`) },
                beforeEnter: [mobileOnly],
                component: asyncView(() => import(`../shell/MobileMenu.vue`)),
            },
            {
                path: `terminal`,
                name: `terminal`,
                meta: { title: () => t(`router.index.terminal`) },
                beforeEnter: [mobileOnly],
                component: asyncView(() => import(`../features/terminal/MobileTerminal.vue`)),
            },
            // The one place a first model is connected. `?provider=` continues a press made somewhere else (a picker
            // row, the trial strip), which is why it is a query rather than a segment: the lane is the page, the
            // provider is only what it opens on.
            {
                path: `connect`,
                name: `connect`,
                meta: { title: () => t(`router.index.connect`) },
                component: asyncView(() => import(`../features/connect/Connect.vue`)),
            },
            {
                path: `capabilities/:entry?`,
                name: `capabilities`,
                meta: { title: () => t(`router.index.capabilities`) },
                // Title and description mirror the page's own copy, so the outline wears the real heading immediately.
                component: asyncView(
                    () => import(`../features/capabilities/Capabilities.vue`),
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
                meta: { title: () => t(`router.index.sandbox`) },
                // The hub retitles itself with the active sandbox's name once mounted; the outline just says what the
                // page is.
                component: asyncView(() => import(`../features/sandbox/SandboxHub.vue`), hubOutline(`Sandbox`, ``, 7)),
            },
            // Splat param: the open file's path lives in the URL (`/workspace/src/foo.ts`), so a reload or a shared
            // link reopens it. Optional/repeatable, so bare `/workspace` still matches.
            {
                path: `workspace/:path(.*)*`,
                name: `workspace`,
                meta: { title: () => t(`router.index.workspace`) },
                component: asyncView(() => import(`../features/workspace/page/Workspace.vue`)),
            },
            // The session is in the URL so a reload reopens the same browser; optional, since the rail tile links to
            // the bare path and the view picks the most recently active one.
            {
                path: `browsers/:session?`,
                name: `browsers`,
                meta: { title: () => t(`router.index.browsers`) },
                component: asyncView(() => import(`../features/browsers/Browsers.vue`)),
            },
            // The id is in the URL so a reload or a chat card's link reopens the same agent; the bare path shows
            // whichever is most recently active.
            {
                path: `subagents/:id?`,
                name: `subagents`,
                meta: { title: () => t(`router.index.subagents`) },
                component: asyncView(() => import(`../features/chat/subagents/Subagents.vue`)),
            },
            { path: `ext/:ext/:key?`, name: `extension`, component: asyncView(() => import(`../features/extensions/ExtensionHost.vue`)) },
            {
                path: `settings/:tab?`,
                name: `settings`,
                meta: { title: () => t(`router.index.settings`) },
                // Mirrors the page's own heading (pages/SettingsHub.vue).
                component: asyncView(() => import(`../features/settings/SettingsHub.vue`), hubOutline(`Settings`, ``, 5)),
            },
        ],
    },
    {
        // Public invite-accept landing (the emailed link). No guard, the invitee may be logged out or on the wrong
        // Google account; the page drives sign-in as the invited address, then flips the pending grant.
        path: `/invite/:token`,
        name: `invite`,
        meta: { title: () => t(`router.index.acceptInvite`) },
        component: () => import(`../features/setup/AcceptInvite.vue`),
    },

    // Every component variant on one page, dev only, unguarded since it needs no session, sandbox or repository.
    // `import.meta.env.DEV` is compile-time, so this route and its whole graph vanish from a production build.
    ...(import.meta.env.DEV
        ? [
              {
                  path: `/kit`,
                  name: `kit`,
                  meta: { title: () => t(`router.index.designKit`) },
                  component: () => import(`../features/settings/DesignKit.vue`),
              } satisfies RouteRecordRaw,
          ]
        : []),
    { path: `/:pathMatch(.*)*`, redirect: `/` },
];

export const router = createRouter({
    // The build's own base, not vue-router's default (`<base href>` or `/`): otherwise a path-prefixed build resolves
    // every route one level up. `/` here; @intentic/demo needs it under `/demo/`.
    history: createWebHistory(import.meta.env.BASE_URL),
    routes,
    // Makes a hash like `/sandbox/usage#accounts` actually scroll into view; vue-router ignores a fragment on its
    // pushState navigations. `{ el }` finds whichever pane owns the scrollbar; no hash means no opinion.
    scrollBehavior: (to) => (to.hash === `` ? false : { el: to.hash, behavior: `smooth` }),
});

// A link naming a conversation opens it wherever it lands: the daemon's push notifications point at
// `/?conversation=<id>`, and a shell that rewrites its entry path before the router runs (the demo does) must not
// drop the tap on the way in. Global, not the home redirect's, for that reason; the target carries no such query,
// so it cannot loop.
router.beforeEach((to) => conversationRedirect(to.query, useDevice().mobile.value) ?? true);

// Router half of stale-chunk recovery (asyncView owns the in-shell half). Covers route-level loads (login, handoffs,
// invite, the shell); a dead chunk here reloads onto the route asked for.
router.onError((error, to) => {
    if (isStaleChunkError(error)) {
        recoverStaleChunk(to.fullPath);
    }
});

// The reload guard is not cleared on a landed navigation: asyncView lands every nav instantly regardless of chunk
// health, so clearing here risks a reload loop on a broken deploy.

// Sets the tab title to `<Page> / intentic` from the route's `title`, falling back to the bare brand when none is
// declared. Asked for per navigation, so it is in the reader's language even when they changed it after boot.
router.afterEach((to) => {
    const title = to.meta.title?.();
    document.title = title === undefined ? `intentic` : `${title} / intentic`;
});
