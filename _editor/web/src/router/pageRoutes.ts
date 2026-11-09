import {
    ACCOUNT_PAGES,
    type AccountPageName,
    type FrameKind,
    HOME_SEGMENT,
    page,
    type PageName,
    SANDBOX_PAGES,
    SANDBOX_SEGMENT,
    type SandboxPageName,
} from "@intentic/sandbox-contract/app-routes";
import { useDevice } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { Component } from "vue";
import type { NavigationGuardWithThis, RouteLocationNormalized, RouteLocationRaw, RouteRecordRaw } from "vue-router";
import { asyncView } from "../components/asyncView";
import { heldView } from "../components/heldPlace";
import { here, routeName } from "../lib/routes/links";
import { mobileChatPath } from "../lib/routes/phoneScreens";
import { useVocabulary } from "../workbench/views/vocabulary";
import { accountSettingsView, hubOutline, settingsPartRoutes } from "./routeParts";

// THE SHELL'S PAGES, ONE RECORD PER PAGE AND FRAME (2026-11-04). Every page of the shared table
// (@intentic/sandbox-contract/app-routes) is routed twice: inside its sandbox, under `s/:sandbox`, and in Home's frame,
// under `home/:sandbox`, the same view in both. The record says which (`meta.frame`, `meta.page`), so the shell, the
// links and the readers of the route (lib/routes/links.ts) never infer the frame from where the reader came from.
// The account's own pages are routed the same way, without a sandbox in Home's frame.

/** How a page is drawn, the same in either frame. */
interface PageView {
    readonly title?: () => string;
    readonly component: Component;
    readonly beforeEnter?: readonly NavigationGuardWithThis<undefined>[];
}

// The conversation the chat has open. The store is imported when asked, not at module load, so the router does not pull
// the chat's whole graph into every first paint.
export const activeConversation = async (): Promise<string> => {
    const { useChat } = await import(`../models/conversations/run/useChat`);
    return useChat().active.value.conversationId;
};

// The chat on a phone is the active conversation's own screen, in the same frame and sandbox.
const chatEntry = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> =>
    useDevice().mobile.value ? mobileChatPath(await activeConversation(), to) : true;

// Menu and Terminal are full-screen pages only on the mobile shell, opened from its rail; the desktop shell docks the
// terminal and puts the menu's contents on the rail, so a desktop hit lands on the workspace of the same frame instead.
const mobileOnly = (to: RouteLocationNormalized): boolean | RouteLocationRaw => (useDevice().mobile.value ? true : here(page.workspace(), to));

// In-shell routes wrap in asyncView so a click never blocks on a chunk download; only first-paint entry routes (login,
// setup, invite, the shell) stay bare lazy imports. `mobile` ranks a view in a phone's idle prefetch: `first` where its
// next tap goes (an agent's page from the board, the menu), `skip` for the two surfaces a phone never draws.
const SANDBOX_VIEWS = {
    // Full-screen chat: the rail-docked chat's own surface, expanded. A route rather than a layout switch, so the rail,
    // back button and reload already know how to enter and leave it. On a phone, the conversation's own screen.
    chat: {
        title: () => t(`shared.chat`),
        beforeEnter: [chatEntry],
        component: asyncView(() => import(`../features/chat/panel/ChatSection.vue`), undefined, { mobile: `skip` }),
    },
    agents: { title: () => useVocabulary().value.agents, component: asyncView(() => import(`../features/agents/fleet/Agents.vue`)) },
    // Drill-in for one agent: full-screen chat plus isolated diff review; an agent's conversation is its chat surface.
    agent: {
        title: () => t(`shared.agent`),
        component: asyncView(() => import(`../features/agents/review/AgentDetail.vue`), undefined, { mobile: `first` }),
    },
    // One page an agent showed in its conversation, alone on the screen, by the page's own id: what a link to it opens,
    // and what the Android app shows in its WebView (lib/routes/phoneScreens.ts `agentPagePath`).
    agentPage: {
        title: () => t(`chat.chatPages.screenTitle`),
        component: asyncView(() => import(`../features/chat/transcript/pages/ChatPageScreen.vue`)),
    },
    // The open file's path lives in the address (`…/workspace/src/foo.ts`), so a reload or a shared link reopens it.
    workspace: { title: () => useVocabulary().value.workspace, component: asyncView(() => import(`../features/workspace/page/Workspace.vue`)) },
    // Everything live the sandbox shows: its browser windows, the apps it serves, its desktop and the windows on it, as
    // tabs of one view. The tab in front is in the address so a reload reopens it (browsersSurface.ts's keys: a window's
    // session name, `preview:<target>`, `desktop`, `app:<window>`); optional, since bare it opens on whatever was in front
    // last. A target id holds a slash (`app:shop/web`), hence the open pattern.
    browsers: { title: () => t(`shared.browsers`), component: asyncView(() => import(`../shell/browsers/BrowsersArea.vue`)) },
    // The machines this sandbox reaches, a view of their own beside the hub rather than a section of it: the rail tiles it
    // as Devices is tiled in a local window.
    devices: { title: () => t(`sandbox.words.devicesSection`), component: asyncView(() => import(`../features/sandbox/devices/DevicesView.vue`)) },
    capabilities: {
        title: () => t(`shared.capabilities`),
        // Title and description mirror the page's own copy, so the outline wears the real heading immediately. Held for
        // maintainers: anyone below meets the gate naming it, never the catalog's refused reads.
        component: asyncView(
            async () =>
                heldView((await import(`../features/capabilities/Capabilities.vue`)).default, () => t(`shared.capabilities`), `capabilities.list`),
            hubOutline(
                () => t(`shared.capabilities`),
                () => t(`capabilities.slices.catalogDescription`),
                6,
            ),
        ),
    },
    extension: { component: asyncView(() => import(`../features/extensions/ExtensionHost.vue`)) },
    // The sandbox's own settings: "settings" in an address is always the sandbox's, "account" always the reader's. The
    // hub retitles itself with the sandbox's name once mounted; the outline just says what the page is.
    sandboxSettings: {
        title: () => t(`shared.sandboxHub`),
        component: asyncView(
            () => import(`../features/sandbox/SandboxHub.vue`),
            hubOutline(
                () => t(`shared.sandboxHub`),
                () => ``,
                7,
                { search: true, mark: true },
            ),
        ),
    },
    terminal: {
        title: () => t(`shared.terminal`),
        beforeEnter: [mobileOnly],
        component: asyncView(() => import(`../features/terminal/MobileTerminal.vue`)),
    },
    menu: {
        title: () => t(`shared.menu`),
        beforeEnter: [mobileOnly],
        component: asyncView(() => import(`../shell/MobileMenu.vue`), undefined, { mobile: `first` }),
    },
} satisfies Record<SandboxPageName, PageView>;

const ACCOUNT_VIEWS = {
    account: { title: () => t(`shared.settings`), component: accountSettingsView() },
    // The account's deleted sandboxes: every sandbox the account deleted, wherever it ran, so a page of the account's.
    deletedSandboxes: {
        title: () => t(`sandbox.words.recentlyDeleted`),
        component: asyncView(() => import(`../features/home/SandboxTrashPage.vue`)),
    },
} satisfies Record<AccountPageName, PageView>;

const record = (frame: FrameKind, base: string, name: PageName, pattern: string, view: PageView): RouteRecordRaw => {
    const meta = view.title === undefined ? { frame, page: name } : { frame, page: name, title: view.title };
    const routed: RouteRecordRaw = { path: `${base}/${pattern}`, name: routeName(frame, name), meta, component: view.component };
    return view.beforeEnter === undefined ? routed : { ...routed, beforeEnter: [...view.beforeEnter] };
};

const FRAME_BASES = { inside: `${SANDBOX_SEGMENT}/:sandbox`, home: `${HOME_SEGMENT}/:sandbox` } as const satisfies Record<FrameKind, string>;

// SAFETY: both tables are const literals whose own keys are exactly their page names; Object.entries only widens them.
const sandboxPages = Object.entries(SANDBOX_PAGES) as [SandboxPageName, string][];
// SAFETY: as above.
const accountPages = Object.entries(ACCOUNT_PAGES) as [AccountPageName, string][];

/**
 * The shell's child records for every page: each page of a sandbox in both frames, the account's pages inside a sandbox
 * and in Home's frame (static, so `/home/account` outranks `/home/<sandbox>`), and the old addresses of Settings' parts
 * under both (routeParts.ts).
 */
export const pageRoutes = (): RouteRecordRaw[] => {
    const frames: FrameKind[] = [`inside`, `home`];
    return [
        ...frames.flatMap((frame) => sandboxPages.map(([name, pattern]) => record(frame, FRAME_BASES[frame], name, pattern, SANDBOX_VIEWS[name]))),
        ...settingsPartRoutes(`${FRAME_BASES.inside}/${ACCOUNT_PAGES.account.split(`/`)[0]}`, routeName(`inside`, `account`)),
        ...settingsPartRoutes(`${HOME_SEGMENT}/${ACCOUNT_PAGES.account.split(`/`)[0]}`, routeName(`home`, `account`)),
        ...accountPages.flatMap(([name, pattern]) => [
            record(`inside`, FRAME_BASES.inside, name, pattern, ACCOUNT_VIEWS[name]),
            record(`home`, HOME_SEGMENT, name, pattern, ACCOUNT_VIEWS[name]),
        ]),
    ];
};
