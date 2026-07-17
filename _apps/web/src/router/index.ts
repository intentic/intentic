import { useDevice } from "@intentic-app/ui";
import { createRouter, createWebHistory, type RouteLocationRaw, type RouteRecordRaw } from "vue-router";
import { restorePersistedQueries } from "../composables/queryPersistence";
import { useAuth } from "../composables/useAuth";
import { useSandbox } from "../composables/sandbox/useSandbox";

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

// Gate the workspace shell on having at least one sandbox (mirrors requireAuth). Zero sandboxes → onboarding at
// /setup. With one or more, the shell renders; its switcher handles an unreachable active sandbox, so we no
// longer bounce the whole shell to /setup on a dead daemon.
const requireSetup = async (): Promise<boolean | RouteLocationRaw> => {
    const { list } = useSandbox();
    const sandboxes = await list();
    return sandboxes.length === 0 ? `/setup` : true;
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
            { path: `secrets`, name: `secrets`, meta: { title: `Secrets` }, component: () => import(`../pages/Secrets.vue`) },
            { path: `ext/:ext/:key`, name: `extension`, component: () => import(`../pages/ExtensionHost.vue`) },
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
    history: createWebHistory(),
    routes,
});

// Formats the browser tab as `<Page> / intentic` from each route's `title`, falling back to the bare brand
// when a route declares none (replaces the route title strategy).
router.afterEach((to) => {
    document.title = to.meta.title ? `${to.meta.title} / intentic` : `intentic`;
});
