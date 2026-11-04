import { overlayBackSettled, useDevice } from "@intentic/ui";
import { isStaleChunkError, recoverStaleChunk } from "@intentic/ui/chunk";
import {
    createRouter,
    createWebHashHistory,
    createWebHistory,
    type RouteLocationNormalized,
    type RouteLocationRaw,
    type RouteRecordRaw,
    START_LOCATION,
} from "vue-router";
import { FLOATING_PANELS, HOME_SEGMENT, SANDBOX_SEGMENT, TOP_PAGES, topPath } from "@intentic/sandbox-contract/app-routes";
import { asyncView } from "../components/asyncView";
import { conversationRedirect, linkedConversation } from "./conversationLink";
import { requireAuth, resolveUser, unavailable } from "./sessionGuard";
import { setupRoutes } from "./setupRoutes";
import { localRoutes } from "./localRoutes";
import { installNativeApp } from "./nativeHandoff";
import { installSignInPlace } from "./signInPlace";
import { restorePersistedQueries } from "../lib/queryPersistence";
import { noteShellRoute } from "../lib/accounts/accountBoundary";
import { useAuth } from "../client/auth/useAuth";
import { useGoogleIdentity } from "../client/auth/useGoogleIdentity";
import { mintsOnArrival } from "../features/auth/handoffSpent";
import { useSandbox } from "../client/sandbox/useSandbox";
import { useRole } from "../client/sandbox/useRole";
import { useSandboxSession } from "../client/session/sandboxSession";
import { retryOnEntry } from "../client/auth/platformRetry";
import { NOTHING_TO_OPEN_PATH } from "../app/environments/nothingToOpen";
import { installRouteSandbox, openNamedSandbox, selectRouteSandbox, settleGate } from "./shellGates";
import { normalizeDaemonUrl } from "../lib/daemonUrl";
import { t } from "@intentic/ui/i18n";
import { localFace, sandboxFace } from "../app/environments/local";
import { receiveHandoff } from "../features/chat/drafts/localHandoff";
import { receiveTaskHandoff } from "../features/chat/drafts/localTaskHandoff";
import { noteFound } from "../lib/foundOnComputer";
import { homeViewGuard } from "../lib/routes/homeDetour";
import { setPageTitle } from "../shell/browser-tab/tabTitle";
import { coldStartAtRoot, installedApp, lastRoute, rememberRoute } from "./recentRoute";
import { afterPaint } from "../lib/afterPaint";
import { installNavigation } from "../workbench/navigation/navigation";
import { HOME_PATH, rootLanding, sandboxLanding } from "../lib/routes/firstScreens";
import { embedded } from "../app/environments/nativeApp";
import { activeSandboxId } from "../app/storage/activeSandbox";
import { here, linkOf, page, routeSandbox } from "../lib/routes/links";
import { activeConversation, pageRoutes } from "./pageRoutes";
import { legacyFloatingRoutes, legacyRoutes } from "./legacyRoutes";

declare module "vue-router" {
    interface RouteMeta {
        /**
         * The tab title, as a function rather than a string: the route table is built once, while this module is
         * still being imported, and `t` has no catalog to read yet. Called on every navigation instead (below).
         */
        title?: () => string;
    }
}

// Google minting starts immediately, before the session round trip or this page's chunk, so the wait is not dead time
// on a screen whose whole content is waiting for Google; only when the app's handoff params are present, and not on a
// restored tab whose hand-off already finished (handoffSpent.ts).
const startGoogleMint = (to: RouteLocationNormalized): true => {
    if (mintsOnArrival(to.query)) {
        void useGoogleIdentity().getIdToken({ gate: false });
    }
    return true;
};

// A sandbox's own address, handed over by the sandbox itself when someone opened it in a browser (the daemon's GET /):
// the sandbox it names when the list has it, recovery when the list lacks it, and the outage screen (which offers it
// first) when the platform cannot be asked.
const openAddressed = async (to: RouteLocationNormalized): Promise<RouteLocationRaw> => {
    const named = [to.query[`url`]].flat()[0];
    const url = named === null || named === undefined ? undefined : normalizeDaemonUrl(named);
    if (url === undefined) {
        return topPath(`root`);
    }
    const resolved = await resolveUser(to);
    if (!(`user` in resolved)) {
        return resolved.redirect;
    }
    await restorePersistedQueries(resolved.user.id);
    const { list, select } = useSandbox();
    // allow(silent-catch): as in requireSetup, a list that could not be had sends the reader to the outage screen.
    const rows = await list().catch(() => undefined);
    if (rows === undefined) {
        return unavailable(to);
    }
    const listed = rows.find((entry) => entry.daemonUrl !== null && normalizeDaemonUrl(entry.daemonUrl) === url);
    if (listed === undefined) {
        return { path: topPath(`recover`), query: { url } };
    }
    select(listed.id);
    return topPath(`root`);
};

// THE DESKTOP APP TAKING THIS PAGE TO A PATH WITHOUT A RELOAD (app/environments/desktop.ts `installDesktopOpener`): a
// sandbox picked in a local window's switcher. Inside the shell a sandbox named the old way (`?sandbox=`) is chosen
// here, the way a link arriving would choose it, since the shell's entry guard does not run again for a shell already
// entered; an address naming its sandbox chooses it by itself (shellGates.ts). Outside it, the guards do as they would
// for the address.
export const openInPage = async (path: string): Promise<void> => {
    if (router.currentRoute.value.matched[0]?.path !== topPath(`root`)) {
        await router.push(path);
        return;
    }
    const settled = await openNamedSandbox(router.resolve(path));
    await router.push(settled === true ? path : settled);
};

// The root: Home for everyone who has one (lib/routes/firstScreens.ts), the landing inside the sandbox open for a guest
// of a box and for the Android app, which draws the board itself.
const rootRedirect = (): string => {
    const { isGuest, homeOnly } = useRole();
    return rootLanding({ isGuest: isGuest.value, homeOnly: homeOnly.value }, embedded(), activeSandboxId.value);
};

// A sandbox's bare address is its first screen. The reader's standing is known only in the sandbox open, so another's
// lands on its board, and the guest fence (shell/guestFence.ts) moves a guest on from there.
const sandboxRootRedirect = (to: Pick<RouteLocationNormalized, `params`>): string => {
    const sandbox = routeSandbox(to);
    if (sandbox === undefined) {
        return HOME_PATH;
    }
    const { isGuest, homeOnly } = useRole();
    return sandboxLanding(sandbox, sandbox === activeSandboxId.value ? { isGuest: isGuest.value, homeOnly: homeOnly.value } : { isGuest: false, homeOnly: false });
};

const routes: RouteRecordRaw[] = [
    ...setupRoutes,
    {
        path: topPath(`login`),
        name: `login`,
        meta: { title: () => t(`router.index.login`) },
        component: () => import(`../features/auth/Login.vue`),
    },
    {
        // A sign-in mail's link: names the address and spends the code it carries on a press, never on load (mail
        // scanners fetch links). Unguarded, there is no session yet.
        path: topPath(`loginConfirm`),
        name: `login-confirm`,
        meta: { title: () => t(`router.index.confirmSignIn`) },
        component: () => import(`../features/auth/LoginConfirm.vue`),
    },
    {
        path: topPath(`platformUnavailable`),
        name: `platform-unavailable`,
        meta: { title: () => t(`router.index.cantReachIntentic`) },
        // Guarded so a reload on this URL is the retry, not a re-render of the failure (platformRetry.ts).
        beforeEnter: [retryOnEntry],
        component: () => import(`../features/setup/PlatformUnavailable.vue`),
    },
    {
        // Desktop app's sign-in, opened in the OS's real browser (it cannot run Google's flow in its own webview).
        // Deliberately unguarded, since that browser is often not signed in as this app's user.
        path: topPath(`desktopAuth`),
        name: `desktop-auth`,
        meta: { title: () => t(`router.index.signInToIntentic`) },
        beforeEnter: [startGoogleMint],
        component: () => import(`../features/auth/DesktopAuth.vue`),
    },
    {
        // Opened inside the app's webview: redeems the handoff, putting the session cookie in this webview's jar.
        // Unguarded on purpose, there is no session here yet.
        path: topPath(`desktopAuthComplete`),
        name: `desktop-auth-complete`,
        meta: { title: () => t(`router.index.signingIn`) },
        component: () => import(`../features/auth/DesktopAuthComplete.vue`),
    },
    // The desktop app's workspace with nothing to open waited here until 2026-10-26, behind This computer; a window an
    // older build left on it lands where it lands now (app/environments/nothingToOpen.ts).
    { path: `/no-sandbox`, redirect: NOTHING_TO_OPEN_PATH },
    {
        // The sandboxes this device remembers and the account's list lacks, offered back (features/sandbox/recovery).
        path: topPath(`recover`),
        name: `recover`,
        meta: { title: () => t(`router.index.reconnectSandboxes`) },
        beforeEnter: [requireAuth],
        component: () => import(`../features/sandbox/recovery/Recover.vue`),
    },
    {
        // A sandbox's own address, from the sandbox (its GET / sends a browser here). The guard always answers with
        // somewhere else; the screen behind it is recovery's, for the address it names.
        path: topPath(`open`),
        name: `open`,
        beforeEnter: [openAddressed],
        component: () => import(`../features/sandbox/recovery/Recover.vue`),
    },
    {
        // A guarded preview's way in, from the page it shows a visitor with no pass
        // (features/preview/previewPassRules.ts): signs this browser in to the preview and sends it back. Behind sign-in,
        // which brings a signed-out visitor back.
        path: topPath(`previewPass`),
        name: `preview-pass`,
        meta: { title: () => t(`router.index.openingPreview`) },
        beforeEnter: [requireAuth],
        component: () => import(`../features/preview/PreviewPass.vue`),
    },
    {
        // A floating panel's own window (chat, terminal or browsers) of one sandbox, no shell around it, nothing to
        // navigate. Guarded like the shell, the sandbox its address names chosen as the shell chooses it; the path
        // enumerates the three panels, an unknown one falls through.
        path: `/${SANDBOX_SEGMENT}/:sandbox/floating/:panel(${FLOATING_PANELS.join(`|`)})`,
        name: `floating`,
        // The shell's own gate, settled as the shell settles it: nothing to open is Home, never a setup page.
        beforeEnter: [requireAuth, settleGate, selectRouteSandbox],
        component: () => import(`../shell/window/FloatingSection.vue`),
    },
    // A floating window's address before frames, which a desktop app still asks for.
    ...legacyFloatingRoutes([requireAuth, settleGate]),
    {
        // Persistent workspace shell (rail + shared chat + area outlet). Home, recovery and settings need only an
        // account; other pages need a sandbox; otherwise the gate sends the reader to Home's first run, which offers a
        // setup of their own left unfinished (app/environments/nothingToOpen.ts). Its children are flat, one record per
        // page and frame (pageRoutes.ts), so `matched[0]` is this record wherever the shell is showing.
        path: topPath(`root`),
        beforeEnter: [requireAuth, settleGate, openNamedSandbox, selectRouteSandbox],
        component: () => import(`../shell/WorkspaceShell.vue`),
        children: [
            // The account's own pages in Home's frame are static addresses, so they outrank a sandbox named here.
            {
                path: `${HOME_SEGMENT}/:sandbox?`,
                name: `home`,
                meta: { frame: `home`, title: () => t(`home.title`) },
                component: asyncView(() => import(`../features/home/MasterHomeView.vue`)),
            },
            // THE FIRST SCREEN IS HOME (2026-10-25): the master view, every sandbox at once, before and after the first
            // one (lib/routes/firstScreens.ts). Going into a sandbox is a press there, and lands on that sandbox's own first
            // screen, its agent board; so does a link naming one (openNamedSandbox). A guest of a box has no Home but
            // its chat: the tree is a read the daemon refuses it. The Android app draws the board itself and keeps it.
            { path: ``, redirect: rootRedirect },
            { path: `${SANDBOX_SEGMENT}/:sandbox`, redirect: sandboxRootRedirect },
            ...pageRoutes(),
            ...legacyRoutes(),
        ],
    },
    {
        // Public invite-accept landing (the emailed link). No guard, the invitee may be logged out or on the wrong
        // Google account; the page drives sign-in as the invited address, then flips the pending grant.
        path: `/${TOP_PAGES.invite}`,
        name: `invite`,
        meta: { title: () => t(`router.index.acceptInvite`) },
        component: () => import(`../features/setup/AcceptInvite.vue`),
    },

    // Every component variant on one page, dev only, unguarded since it needs no session, sandbox or repository.
    // `import.meta.env.DEV` is compile-time, so this route and its whole graph vanish from a production build.
    ...(import.meta.env.DEV
        ? [
              {
                  path: topPath(`kit`),
                  name: `kit`,
                  meta: { title: () => t(`router.index.designKit`) },
                  component: () => import(`../features/settings/DesignKit.vue`),
              } satisfies RouteRecordRaw,
              {
                  path: topPath(`kitRepair`),
                  name: `kit-repair`,
                  meta: { title: () => t(`local.repair.title`) },
                  component: () => import(`../local/repair/RepairKitSection.vue`),
              } satisfies RouteRecordRaw,
          ]
        : []),
    { path: `/:pathMatch(.*)*`, redirect: topPath(`root`) },
];

export const router = createRouter({
    // The build's own base, not vue-router's default (`<base href>` or `/`): otherwise a path-prefixed build resolves
    // every route one level up. `/` here; @intentic/demo needs it under `/demo/`.
    //
    // A local window keeps its route in the hash instead: the app's asset protocol answers `files/local` with the local
    // page (vite.local.config.ts) and an address below it with the bundle's other page, so a reload of `files/local/device`
    // would load the wrong app. `files/local#/device` reloads onto the screen it was on. The app's sandbox face is served
    // the same way (`files/sandbox`), so it does the same.
    history: localFace() === undefined && !sandboxFace() ? createWebHistory(import.meta.env.BASE_URL) : createWebHashHistory(),
    routes: localFace() === undefined ? routes : localRoutes(),
    // Makes a hash like `/sandbox/usage#accounts` actually scroll into view; vue-router ignores a fragment on its
    // pushState navigations. `{ el }` finds whichever pane owns the scrollbar; no hash means no opinion.
    // Only to an anchor already drawn: handing the router a selector that matches nothing yet only earns a warning.
    scrollBehavior: (to) => (to.hash === `` || document.querySelector(to.hash) === null ? false : { el: to.hash, behavior: `smooth` }),
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
// Removal receipts and links from before the account page still name the Devices board's old foot (`/devices#deleted`),
// which needs an active sandbox; they reach recovery from anywhere.
router.beforeEach((to) => (linkOf(to.path)?.page === `devices` && to.hash === `#deleted` ? here(page.deletedSandboxes(), to) : true));
// The desktop app asks for a sign-in over the view, never instead of it (signInPlace.ts). Before every guard that might
// send the reader somewhere for the screen it replaces.
installSignInPlace(router);
// From Home, a sandbox's own view (its Models, today) is shown where Home's chat was, with the way back to it, rather than
// entered: every door to it is covered at once, so none has to know it was pressed on Home (lib/routes/homeDetour.ts).
router.beforeEach((to, from) => homeViewGuard(to, from));
// The sandbox an address names is the one shown, for every navigation inside the shell (shellGates.ts).
installRouteSandbox(router);
// Whether the workspace shell is what is showing, for the account boundary: a page drawn for one account reloads when
// the browser moves to another, a page outside the shell follows it (lib/accounts/accountBoundary.ts).
router.afterEach((to) => noteShellRoute(to.matched[0]?.path === topPath(`root`)));
router.afterEach((to, _from, failure) => {
    if (failure === undefined && to.path !== topPath(`root`) && to.matched.some((match) => match.path === topPath(`root`)) && installedApp()) {
        rememberRoute(to.fullPath, Date.now());
    }
});

// A pick in a bottom sheet closes it and navigates in one tap. The sheet gives its history entry back with a back
// traversal, which must land before the pick's route is pushed, or it steps back off that route instead (useBackDismiss).
router.beforeResolve(() => overlayBackSettled());

// The desktop app's "Ask an agent about this" arrives as `?handoff=` on whatever route it lands: kept for the chat that
// takes the file, and out of the address before any other guard reads it (features/chat/drafts/localHandoff.ts).
router.beforeEach((to) => receiveHandoff(to, () => useAuth().user.value !== null));

router.beforeEach((to) => receiveTaskHandoff(to, localFace() !== undefined, () => router.currentRoute.value.path));

// The desktop app's `/setup?found=…` (the AI tools signed in on this computer) is kept before the sign-in gate can send
// the reader away from it, for the landing once setup finishes (lib/foundOnComputer.ts).
router.beforeEach((to) => noteFound(to));

// A link naming a conversation opens it wherever it lands: the daemon's push notifications point at
// `/?conversation=<id>`, and a shell that rewrites its entry path before the router runs (the demo does) must not
// drop the tap on the way in. Global, not the home redirect's, for that reason; the target carries no such query,
// so it cannot loop.
// The chat's home is read only for such a link, and its module loaded only then: it opens floating-window machinery a
// sign-in page has no business starting.
router.beforeEach(async (to) => {
    if (linkedConversation(to.query) === undefined) {
        return true;
    }
    const surface = useDevice().mobile.value ? `phone` : (await import(`../models/conversations/panel/chatPanelLayout`)).chatOnRailTile.value ? `chat` : `board`;
    return conversationRedirect(to.query, surface, to) ?? true;
});

// INSIDE THE ANDROID APP'S WEBVIEW, after every guard above that names where a navigation goes: a screen the app draws
// itself is handed to it from here, whoever asked for it (nativeHandoff.ts). Installs nothing anywhere else.
installNativeApp(router, { show: openInPage, activeConversation, adoptSession: useSandboxSession().adoptSession });

// Router half of stale-chunk recovery (asyncView owns the in-shell half). Covers route-level loads (login, handoffs,
// invite, the shell); a dead chunk here reloads onto the route asked for.
router.onError((error, to) => {
    if (isStaleChunkError(error)) {
        recoverStaleChunk(router.resolve(to).href);
    }
});

// The reload guard is not cleared on a landed navigation: asyncView lands every nav instantly regardless of chunk
// health, so clearing here risks a reload loop on a broken deploy. The guard expires after a few minutes (`loadChunk`).

// Sets the tab title to `<Page> / intentic` from the route's `title`, falling back to the bare brand when none is
// declared. Asked for per navigation, so it is in the reader's language even when they changed it after boot; only for
// one that landed, since a navigation a guard stopped (the desktop app's sign-in, asked in a dialog over the view) leaves
// the reader on the page whose title is already up.
// The tab's mark (what needs you, what finished) is put in front of it by shell/browser-tab/browserTab.ts.
router.afterEach((to, _from, failure) => {
    if (failure === undefined) {
        setPageTitle(to.meta.title?.());
    }
});

// Last, after the table's own hooks: everything below composition navigates through this registry, and the afterEach
// hooks it queued run after the ones above, as they did when those modules imported this one.
installNavigation(router);
