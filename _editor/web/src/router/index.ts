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
import { asyncView } from "../components/asyncView";
import { heldView } from "../components/heldPlace";
import { conversationRedirect, linkedConversation } from "./conversationLink";
import { requireAuth, resolveUser, unavailable } from "./sessionGuard";
import { setupRoutes } from "./setupRoutes";
import { hubOutline, settingsPartRoutes } from "./routeParts";
import { localRoutes } from "./localRoutes";
import { installNativeApp } from "./nativeHandoff";
import { installSignInPlace } from "./signInPlace";
import { mobileChatPath } from "../lib/routes/phoneScreens";
import { restorePersistedQueries } from "../lib/queryPersistence";
import { useAuth } from "../client/auth/useAuth";
import { useGoogleIdentity } from "../client/auth/useGoogleIdentity";
import { mintsOnArrival } from "../features/auth/handoffSpent";
import { useSandbox } from "../client/sandbox/useSandbox";
import { useRole } from "../client/sandbox/useRole";
import { useSandboxSession } from "../client/session/sandboxSession";
import { retryOnEntry } from "../client/auth/platformRetry";
import { NOTHING_TO_OPEN_PATH } from "../app/environments/nothingToOpen";
import { openNamedSandbox, settleGate } from "./shellGates";
import { normalizeDaemonUrl } from "../lib/daemonUrl";
import { t } from "@intentic/ui/i18n";
import { useVocabulary } from "../workbench/views/vocabulary";
import { localFace, sandboxFace } from "../app/environments/local";
import { receiveHandoff } from "../features/chat/drafts/localHandoff";
import { receiveTaskHandoff } from "../features/chat/drafts/localTaskHandoff";
import { noteFound } from "../lib/foundOnComputer";
import { MODELS_PATH } from "../lib/routes/modelsPath";
import { goInside, homeViewGuard } from "../lib/routes/homeDetour";
import { DELETED_ANCHOR, DELETED_PATH, DEVICES_PATH } from "../models/sandbox/devices/deviceLinks";
import { setPageTitle } from "../shell/browser-tab/tabTitle";
import { coldStartAtRoot, installedApp, lastRoute, rememberRoute } from "./recentRoute";
import { afterPaint } from "../lib/afterPaint";
import { browsersPath, previewRedirect } from "../workbench/browsers/browsersPaths";
import { installNavigation } from "../workbench/navigation/navigation";
import { rootLanding } from "../lib/routes/firstScreens";
import { embedded } from "../app/environments/nativeApp";

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
        return `/`;
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
        return { path: `/recover`, query: { url } };
    }
    select(listed.id);
    return `/`;
};

// THE DESKTOP APP TAKING THIS PAGE TO A PATH WITHOUT A RELOAD (app/environments/desktop.ts `installDesktopOpener`): a
// sandbox picked in a local window's switcher. Inside the shell the named sandbox is chosen here, the way a link
// arriving would choose it, since the shell's entry guard does not run again for a shell already entered; outside it,
// the guards do as they would for the address.
// A sandbox picked is a step inside it, so Home's rule for showing a sandbox's view in place stands aside for it.
export const openInPage = async (path: string): Promise<void> => {
    if (router.currentRoute.value.matched[0]?.path !== `/`) {
        await router.push(path);
        return;
    }
    const settled = await openNamedSandbox(router.resolve(path));
    await goInside(() => router.push(settled === true ? path : settled));
};

// Menu and Terminal are full-screen pages only on the mobile shell, opened from its rail; the desktop shell docks the terminal and puts the
// menu's contents on the rail, so a desktop hit lands on the workspace instead.
const mobileOnly = (): boolean | RouteLocationRaw => (useDevice().mobile.value ? true : `/workspace`);

// The conversation the chat has open. The store is imported when asked, not at module load, so the router does not pull
// the chat's whole graph into every first paint.
const activeConversation = async (): Promise<string> => {
    const { useChat } = await import(`../models/conversations/run/useChat`);
    return useChat().active.value.conversationId;
};

// /chat on a phone is the active conversation's own screen.
const chatEntry = async (): Promise<boolean | RouteLocationRaw> => (useDevice().mobile.value ? mobileChatPath(await activeConversation()) : true);

// In-shell routes wrap in asyncView so a click never blocks on a chunk download; only first-paint entry routes (login,
// setup, invite, the shell) stay bare lazy imports. `mobile` ranks a view in a phone's idle prefetch: `first` where its
// next tap goes (an agent's page from the board, the menu), `skip` for the two surfaces a phone never draws.

const routes: RouteRecordRaw[] = [
    ...setupRoutes,
    {
        path: `/login`,
        name: `login`,
        meta: { title: () => t(`router.index.login`) },
        component: () => import(`../features/auth/Login.vue`),
    },
    {
        // A sign-in mail's link: names the address and spends the code it carries on a press, never on load (mail
        // scanners fetch links). Unguarded, there is no session yet.
        path: `/login/confirm`,
        name: `login-confirm`,
        meta: { title: () => t(`router.index.confirmSignIn`) },
        component: () => import(`../features/auth/LoginConfirm.vue`),
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
    // The desktop app's workspace with nothing to open waited here until 2026-10-26, behind This computer; a window an
    // older build left on it lands where it lands now (app/environments/nothingToOpen.ts).
    { path: `/no-sandbox`, redirect: NOTHING_TO_OPEN_PATH },
    {
        // The sandboxes this device remembers and the account's list lacks, offered back (features/sandbox/recovery).
        path: `/recover`,
        name: `recover`,
        meta: { title: () => t(`router.index.reconnectSandboxes`) },
        beforeEnter: [requireAuth],
        component: () => import(`../features/sandbox/recovery/Recover.vue`),
    },
    {
        // A sandbox's own address, from the sandbox (its GET / sends a browser here). The guard always answers with
        // somewhere else; the screen behind it is recovery's, for the address it names.
        path: `/open`,
        name: `open`,
        beforeEnter: [openAddressed],
        component: () => import(`../features/sandbox/recovery/Recover.vue`),
    },
    {
        // A floating panel's own window (chat, terminal or browsers), no shell around it, nothing to navigate. Guarded
        // like the shell; the path enumerates the three panels, an unknown one falls through.
        path: `/floating/:panel(chat|terminal|browsers)`,
        name: `floating`,
        // The shell's own gate, settled as the shell settles it: nothing to open is Home, never a setup page.
        beforeEnter: [requireAuth, settleGate],
        component: () => import(`../shell/window/FloatingSection.vue`),
    },
    // The live app's own window until it became a tab of Browsers (2026-10-08); a desktop app that remembers one still
    // asks for it here.
    { path: `/floating/preview`, redirect: `/floating/browsers` },
    {
        // Persistent workspace shell (rail + shared chat + area outlet). Home, recovery and settings need only an account; other pages need a sandbox;
        // otherwise the gate sends the reader to Home's first run, which offers a setup of their own left unfinished
        // (app/environments/nothingToOpen.ts).
        path: `/`,
        beforeEnter: [requireAuth, settleGate, openNamedSandbox],
        component: () => import(`../shell/WorkspaceShell.vue`),
        children: [
            {
                path: `home/:sandbox?`,
                name: `home`,
                meta: { title: () => t(`home.title`) },
                component: asyncView(() => import(`../features/home/MasterHomeView.vue`)),
            },
            {
                path: `deleted-sandboxes`,
                name: `deleted-sandboxes`,
                meta: { title: () => t(`sandbox.words.recentlyDeleted`) },
                component: asyncView(() => import(`../features/sandbox/devices/deleted/SandboxTrashPage.vue`)),
            },
            // THE FIRST SCREEN IS HOME (2026-10-25): the master view, every sandbox at once, before and after the first
            // one (lib/routes/firstScreens.ts). Going into a sandbox is a press there, and lands on that sandbox's own first
            // screen, its agent board; so does a link naming one (openNamedSandbox). A guest of a box has no Home but
            // its chat: the tree is a read the daemon refuses it. The Android app draws the board itself and keeps it.
            {
                path: ``,
                redirect: () => {
                    const { isGuest, homeOnly } = useRole();
                    return rootLanding({ isGuest: isGuest.value, homeOnly: homeOnly.value }, embedded());
                },
            },
            // Full-screen chat: the rail-docked chat's own surface, expanded. A route rather than a layout switch, so
            // the rail, back button and reload already know how to enter and leave it. On a phone, the conversation's own screen.
            {
                path: `chat`,
                name: `chat`,
                meta: { title: () => t(`shared.chat`) },
                beforeEnter: [chatEntry],
                component: asyncView(() => import(`../features/chat/panel/ChatSection.vue`), undefined, { mobile: `skip` }),
            },
            // The live app's home until it became a tab of Browsers (2026-10-08). Kept for the links an older build, an
            // extension's "See it" or a bookmark still open: `?target=` names the app, and lands on its tab.
            { path: `preview`, redirect: (to) => previewRedirect(to.query[`target`]) },
            {
                path: `agents`,
                name: `agents`,
                meta: { title: () => useVocabulary().value.agents },
                component: asyncView(() => import(`../features/agents/fleet/Agents.vue`)),
            },
            // The Needs you inbox until 2026-10-12, when each of its rows went back to the tile that already badged it
            // (docs/architecture/needs.md). Kept for a bookmark or an older build's notification: the board is where an
            // agent's ask and a held wake are cards.
            { path: `needs`, redirect: (to) => ({ path: `/agents`, query: to.query }) },
            // Drill-in for one agent: full-screen chat plus isolated diff review; an agent's conversation is its chat
            // surface.
            {
                path: `agents/:id`,
                name: `agent`,
                meta: { title: () => t(`shared.agent`) },
                component: asyncView(() => import(`../features/agents/review/AgentDetail.vue`), undefined, { mobile: `first` }),
            },
            // One page an agent showed in its conversation, alone on the screen, by the page's own id: what a link to it
            // opens, and what the Android app shows in its WebView (lib/routes/phoneScreens.ts `agentPagePath`).
            {
                path: `agents/:id/pages/:page`,
                name: `agent-page`,
                meta: { title: () => t(`chat.chatPages.screenTitle`) },
                component: asyncView(() => import(`../features/chat/transcript/pages/ChatPageScreen.vue`)),
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
            // The connect page's address until it became Sandbox ▸ Models (lib/routes/modelsPath.ts). Kept, query and all,
            // for the links an older build or a desktop app still opens: `?provider=` continues a press made elsewhere and
            // `?found=` names what was found signed in on this computer, and both mean the same thing there.
            { path: `connect`, redirect: (to) => ({ path: MODELS_PATH, query: to.query, hash: to.hash }) },
            {
                path: `capabilities/:entry?`,
                name: `capabilities`,
                meta: { title: () => t(`shared.capabilities`) },
                // Title and description mirror the page's own copy, so the outline wears the real heading immediately.
                // Held for maintainers: anyone below meets the gate naming it, never the catalog's refused reads.
                component: asyncView(
                    async () => heldView((await import(`../features/capabilities/Capabilities.vue`)).default, () => t(`shared.capabilities`), `capabilities.list`),
                    hubOutline(
                        () => t(`shared.capabilities`),
                        () => t(`capabilities.slices.catalogDescription`),
                        6,
                    ),
                ),
            },
            // The machines this sandbox reaches, a view of their own beside the hub rather than a section of it: the rail
            // tiles it as Devices is tiled in a local window. The hub's old address keeps working, query and all, so
            // a link out of an older build or a desktop app still lands on the machine it named.
            {
                path: `devices`,
                name: `devices`,
                meta: { title: () => t(`sandbox.words.devicesSection`) },
                component: asyncView(() => import(`../features/sandbox/devices/DevicesView.vue`)),
            },
            { path: `sandbox/devices`, redirect: (to) => ({ name: `devices`, query: to.query, hash: to.hash }) },
            // Recently deleted used to be a hub section; recovery now also has its own account-level page.
            { path: `sandbox/deleted`, redirect: () => DELETED_PATH },
            // The audit log was a hub section until 2026-10-17; its records are a part of Activity now, and how they are
            // kept (its old second part, `?section=keeping`) is Retention's.
            {
                path: `sandbox/audit`,
                redirect: (to) =>
                    to.query[`section`] === `keeping`
                        ? { name: `sandbox`, params: { tab: `retention` } }
                        : { name: `sandbox`, params: { tab: `activity` }, query: { ...to.query, section: `audit` }, hash: to.hash },
            },
            // Areas was a hub section until 2026-10-26; it is a part of Access now, beside the profiles that name it.
            {
                path: `sandbox/areas`,
                redirect: (to) => ({ name: `sandbox`, params: { tab: `access` }, query: { ...to.query, section: `areas` }, hash: to.hash }),
            },
            {
                path: `sandbox/:tab?`,
                name: `sandbox`,
                meta: { title: () => t(`shared.sandboxHub`) },
                // The hub retitles itself with the active sandbox's name once mounted; the outline just says what the
                // page is.
                component: asyncView(() => import(`../features/sandbox/SandboxHub.vue`), hubOutline(() => t(`shared.sandboxHub`), () => ``, 7)),
            },
            // Splat param: the open file's path lives in the URL (`/workspace/src/foo.ts`), so a reload or a shared
            // link reopens it. Optional/repeatable, so bare `/workspace` still matches.
            {
                path: `workspace/:path(.*)*`,
                name: `workspace`,
                meta: { title: () => useVocabulary().value.workspace },
                component: asyncView(() => import(`../features/workspace/page/Workspace.vue`)),
            },
            // Everything live the sandbox shows: its browser windows, the apps it serves, its desktop and the windows on it,
            // as tabs of one view. The tab in front is in the URL so a reload reopens it (browsersSurface.ts's keys: a
            // window's session name, `preview:<target>`, `desktop`, `app:<window>`); optional, since a bare /browsers
            // opens on whatever was in front last. A target id holds a slash (`app:shop/web`), hence the open pattern.
            {
                path: `browsers/:tab(.*)?`,
                name: `browsers`,
                meta: { title: () => t(`shared.browsers`) },
                component: asyncView(() => import(`../shell/browsers/BrowsersArea.vue`)),
            },
            // The sandbox's own desktop was a view of its own until it became a tab of Browsers (2026-10-08).
            { path: `desktop`, redirect: browsersPath({ kind: `desktop` }) },
            { path: `ext/:ext/:key?`, name: `extension`, component: asyncView(() => import(`../features/extensions/ExtensionHost.vue`)) },
            ...settingsPartRoutes(),
            {
                path: `settings/:tab?`,
                name: `settings`,
                meta: { title: () => t(`shared.settings`) },
                // Mirrors the page's own heading (pages/SettingsHub.vue).
                component: asyncView(() => import(`../features/settings/SettingsHub.vue`), hubOutline(() => t(`shared.settings`), () => ``, 5)),
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
              {
                  path: `/kit/repair`,
                  name: `kit-repair`,
                  meta: { title: () => t(`local.repair.title`) },
                  component: () => import(`../local/repair/RepairKitSection.vue`),
              } satisfies RouteRecordRaw,
          ]
        : []),
    { path: `/:pathMatch(.*)*`, redirect: `/` },
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
    // Only to an anchor already drawn: one inside data still being read (Devices' `#deleted`) scrolls itself once it lands,
    // and handing the router a selector that matches nothing yet only earns a warning.
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
// Older removal receipts must reach recovery even from an account page with no active sandbox.
router.beforeEach((to) => (to.path === DEVICES_PATH && to.hash === `#${DELETED_ANCHOR}` ? DELETED_PATH : true));
// The desktop app asks for a sign-in over the view, never instead of it (signInPlace.ts). Before every guard that might
// send the reader somewhere for the screen it replaces.
installSignInPlace(router);
// From Home, a sandbox's own view (its Models, today) is shown where Home's chat was, with the way back to it, rather than
// entered: every door to it is covered at once, so none has to know it was pressed on Home (lib/routes/homeDetour.ts).
router.beforeEach((to, from) => homeViewGuard(to, from));
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
    return conversationRedirect(to.query, surface) ?? true;
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
// health, so clearing here risks a reload loop on a broken deploy. A chunk that loads clears it (`loadChunk`).

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
