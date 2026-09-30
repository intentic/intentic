import type { User } from "@intentic/api-contract";
import { overlayBackSettled, useDevice } from "@intentic/ui";
import { isStaleChunkError, recoverStaleChunk } from "@intentic/ui/chunk";
import { type FunctionalComponent, h } from "vue";
import { createRouter, createWebHistory, type RouteLocationNormalized, type RouteLocationRaw, type RouteRecordRaw, START_LOCATION } from "vue-router";
import { asyncView } from "../components/asyncView";
import { homeViewId, PROJECTS_VIEW_ID } from "../core-views/registry";
import { conversationRedirect } from "./conversationLink";
import { mobileChatPath } from "../shell/tabRoots";
import SplitViewOutline from "../components/SplitViewOutline.vue";
import { restorePersistedQueries } from "../lib/queryPersistence";
import { useAuth } from "../features/auth/useAuth";
import { useGoogleIdentity } from "../features/auth/useGoogleIdentity";
import { mintsOnArrival } from "../features/auth/handoffSpent";
import { useSandbox } from "../features/sandbox/client/useSandbox";
import { useRole } from "../features/sandbox/secrets/useRole";
import { retryOnEntry } from "./platformRetry";
import { arriveOnSandbox } from "./sandboxArrival";
import { setupRedirect } from "./setupGate";
import { signInAt } from "./signIn";
import { t } from "@intentic/ui/i18n";
import { localFace } from "../app/environments/local";
import { receiveHandoff } from "../features/chat/drafts/localHandoff";
import { setPageTitle } from "../shell/browser-tab/tabTitle";
import { coldStartAtRoot, installedApp, lastRoute, rememberRoute } from "./recentRoute";
import { afterPaint } from "../lib/afterPaint";

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
// on a screen whose whole content is waiting for Google; only when the app's handoff params are present, and not on a
// restored tab whose hand-off already finished (handoffSpent.ts).
const startGoogleMint = (to: RouteLocationNormalized): true => {
    if (mintsOnArrival(to.query)) {
        void useGoogleIdentity().getIdToken({ gate: false });
    }
    return true;
};

// Gates the workspace shell on having a workspace to open; setupGate.ts owns the predicate.
const requireSetup = async (): Promise<boolean | RouteLocationRaw> => {
    const { list } = useSandbox();
    return setupRedirect(await list()) ?? true;
};

// A link naming a sandbox (`/?sandbox=<id>`) opens the shell on it; sandboxArrival.ts owns the rule. After the gate, so
// the list it reads is the one the gate just fetched.
const openNamedSandbox = (to: RouteLocationNormalized): Promise<true | RouteLocationRaw> => arriveOnSandbox(to, useSandbox());

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
// setup, invite, the shell) stay bare lazy imports. `mobile` ranks a view in a phone's idle prefetch: `first` where its
// next tap goes (an agent's page from the board, the menu), `skip` for the two surfaces a phone never draws.
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
        // Guarded so a reload on this URL is the retry, not a re-render of the failure (platformRetry.ts).
        beforeEnter: [retryOnEntry],
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
        // A desktop window on a folder of the user's own disk (app/environments/local.ts): the explorer and the editor
        // panes, nothing that needs a sandbox. Guarded like the shell; the window's bootstrap seeds what both read.
        path: `/local`,
        name: `local`,
        meta: { title: () => localFace()?.name ?? t(`shared.files`) },
        beforeEnter: [requireAuth, requireSetup],
        component: () => import(`../local/LocalFiles.vue`),
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
        beforeEnter: [requireAuth, requireSetup, openNamedSandbox],
        component: () => import(`../shell/WorkspaceShell.vue`),
        children: [
            // Where setup lets go of the user: mobile lands on the agent fleet, desktop on the home tile, where its
            // chat is already docked: the file tree, or a maker's Project page once that extension has registered.
            // A guest has no home tile but the chat: the tree and the Project page are reads the daemon refuses it.
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
                meta: { title: () => t(`shared.chat`) },
                beforeEnter: [chatEntry],
                component: asyncView(() => import(`../features/chat/panel/ChatSection.vue`), undefined, { mobile: `skip` }),
            },
            // The live app preview's full-window home, same arrangement as the chat route. Desktop only: the mobile
            // shell mounts no poppable panels, and a phone opens the preview URL directly.
            {
                path: `preview`,
                name: `preview`,
                meta: { title: () => t(`shared.preview`) },
                beforeEnter: [desktopOnly],
                component: asyncView(() => import(`../features/preview/PreviewArea.vue`), undefined, { mobile: `skip` }),
            },
            {
                path: `agents`,
                name: `agents`,
                meta: { title: () => t(`shared.agents`) },
                component: asyncView(() => import(`../features/agents/fleet/Agents.vue`)),
            },
            // Everything agents wait on people for, answered in place (docs/architecture/needs.md).
            {
                path: `needs`,
                name: `needs`,
                meta: { title: () => t(`needs.inbox.title`) },
                component: asyncView(() => import(`../features/needs/NeedsInbox.vue`)),
            },
            // Drill-in for one agent: full-screen chat plus isolated diff review; an agent's conversation is its chat
            // surface.
            {
                path: `agents/:id`,
                name: `agent`,
                meta: { title: () => t(`shared.agent`) },
                component: asyncView(() => import(`../features/agents/review/AgentDetail.vue`), undefined, { mobile: `first` }),
            },
            {
                path: `menu`,
                name: `menu`,
                meta: { title: () => t(`shared.menu`) },
                beforeEnter: [mobileOnly],
                component: asyncView(() => import(`../shell/MobileMenu.vue`), undefined, { mobile: `first` }),
            },
            {
                path: `terminal`,
                name: `terminal`,
                meta: { title: () => t(`shared.terminal`) },
                beforeEnter: [mobileOnly],
                component: asyncView(() => import(`../features/terminal/MobileTerminal.vue`)),
            },
            // The one place a first model is connected. `?provider=` continues a press made somewhere else (a picker
            // row, the trial strip), which is why it is a query rather than a segment: the lane is the page, the
            // provider is only what it opens on.
            {
                path: `connect`,
                name: `connect`,
                meta: { title: () => t(`chat.words.connectAModel`) },
                component: asyncView(() => import(`../features/connect/Connect.vue`)),
            },
            {
                path: `capabilities/:entry?`,
                name: `capabilities`,
                meta: { title: () => t(`shared.capabilities`) },
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
                meta: { title: () => t(`shared.sandboxHub`) },
                // The hub retitles itself with the active sandbox's name once mounted; the outline just says what the
                // page is.
                component: asyncView(() => import(`../features/sandbox/SandboxHub.vue`), hubOutline(`Sandbox`, ``, 7)),
            },
            // Splat param: the open file's path lives in the URL (`/workspace/src/foo.ts`), so a reload or a shared
            // link reopens it. Optional/repeatable, so bare `/workspace` still matches.
            {
                path: `workspace/:path(.*)*`,
                name: `workspace`,
                meta: { title: () => t(`shared.workspace`) },
                component: asyncView(() => import(`../features/workspace/page/Workspace.vue`)),
            },
            // The session is in the URL so a reload reopens the same browser; optional, since the rail tile links to
            // the bare path and the view picks the most recently active one.
            {
                path: `browsers/:session?`,
                name: `browsers`,
                meta: { title: () => t(`shared.browsers`) },
                component: asyncView(() => import(`../features/browsers/Browsers.vue`)),
            },
            { path: `ext/:ext/:key?`, name: `extension`, component: asyncView(() => import(`../features/extensions/ExtensionHost.vue`)) },
            {
                path: `settings/:tab?`,
                name: `settings`,
                meta: { title: () => t(`shared.settings`) },
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

// A PRESS PAINTS BEFORE THE SCREEN IT OPENS, on a phone. Everything a navigation does (guards, the old screen torn down,
// the new one mounted) otherwise runs in the task of the tap itself, so the tapped card or tab shows no press at all
// until the next screen is fully built: on a Galaxy S10 that was 0.5–1.6s of a frozen board per tap (INP, PostHog web
// vitals). Yielding one frame first costs ~16ms and lets the press, and anything the tap already changed, reach the
// screen. The app's first navigation has no press to show; a desktop pointer's navigation is cheap enough not to need it.
router.beforeEach((_to, from) => {
    const { mobile, coarse } = useDevice();
    return from === START_LOCATION || !(mobile.value || coarse.value) ? true : afterPaint().then(() => true);
});

// The installed app's cold start at "/" goes back to the page it was on, if that was recent (recentRoute.ts). Only the
// first navigation: "/" chosen inside a running app means home.
router.beforeEach((to, from) => (coldStartAtRoot(to, from === START_LOCATION) && installedApp() ? (lastRoute(Date.now()) ?? true) : true));
router.afterEach((to, _from, failure) => {
    if (failure === undefined && to.path !== `/` && to.matched.some((match) => match.path === `/`) && installedApp()) {
        rememberRoute(to.fullPath, Date.now());
    }
});

// A pick in a bottom sheet closes it and navigates in one tap. The sheet gives its history entry back with a back
// traversal, which must land before the pick's route is pushed, or it steps back off that route instead (useBackDismiss).
router.beforeResolve(() => overlayBackSettled());

// The desktop app's "Ask an agent about this" arrives as `?handoff=` on whatever route it lands: kept for the chat that
// takes the file, and out of the address before any other guard reads it (features/chat/drafts/localHandoff.ts).
router.beforeEach((to) => receiveHandoff(to));

// A link naming a conversation opens it wherever it lands: the daemon's push notifications point at
// `/?conversation=<id>`, and a shell that rewrites its entry path before the router runs (the demo does) must not
// drop the tap on the way in. Global, not the home redirect's, for that reason; the target carries no such query,
// so it cannot loop.
router.beforeEach((to) => conversationRedirect(to.query, useDevice().mobile.value) ?? true);

// A window on a local folder has one screen. Anything that would lead elsewhere (a link into the workspace, the shell's
// home) leads back to it: every other screen reads a sandbox this window has none of.
router.beforeEach((to) => (localFace() !== undefined && to.name !== `local` ? { name: `local` } : true));

// Router half of stale-chunk recovery (asyncView owns the in-shell half). Covers route-level loads (login, handoffs,
// invite, the shell); a dead chunk here reloads onto the route asked for.
router.onError((error, to) => {
    if (isStaleChunkError(error)) {
        recoverStaleChunk(router.resolve(to).href);
    }
});

// The reload guard is not cleared on a landed navigation: asyncView lands every nav instantly regardless of chunk
// health, so clearing here risks a reload loop on a broken deploy. A chunk that loads clears it (`loadChunk`).

// Sets the tab title to `<Page> / intentic` from the route's `title`, falling back to the bare brand when none is
// declared. Asked for per navigation, so it is in the reader's language even when they changed it after boot.
// The tab's mark (what needs you, what finished) is put in front of it by shell/browser-tab/browserTab.ts.
router.afterEach((to) => setPageTitle(to.meta.title?.()));
