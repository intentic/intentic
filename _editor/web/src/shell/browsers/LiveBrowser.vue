<script setup lang="ts">
import type { BrowserPage, BrowserSession, DesktopWindow } from "@intentic/sandbox-contract/schemas/terminal";
import { errorMessage } from "@intentic/base/errors";
import { noticeOf } from "@intentic/ui/async";
import { AnchoredOverlay, Button, EmptyState, Icon, Picker, ui } from "@intentic/ui";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, shallowRef, watch } from "vue";
import { activePageOf } from "../../features/browsers/activePage";
import { toUrl } from "../../features/browsers/address";
import { useHeldAddress } from "../../features/browsers/heldAddress";
import { browsersFront, browsersOpened, browsersPinned, browsersWantPreview, showTab, unpinTab } from "../../workbench/browsers/browsersSurface";
import { parseTabKey, sameTab, tabKey, type LiveTab, type PinnedTab } from "../../workbench/browsers/browsersPaths";
import { toggleBrowsersFloating, useBrowsersFloating } from "../../workbench/browsers/browsersFloating";
import LiveTabStrip from "../../features/browsers/LiveTabStrip.vue";
import LiveLauncher, { type LaunchGroup } from "./LiveLauncher.vue";
import { initialOf, type GroupMark, type StripGroup, type StripTab } from "../../features/browsers/stripTab";
import { closeBrowser, closeBrowserPage, openBrowser, useBrowsersQuery } from "../../features/browsers/browsersQuery";
import type { BrowserCommand } from "../../models/browsers/keyIntent";
import Omnibox from "../../features/browsers/Omnibox.vue";
import { useBrowserView } from "../../features/browsers/useBrowserView";
import { agentTitle, agentTurnRunning } from "../../features/browsers/agentTurns";
import BrowserSelectMenu from "../../features/capabilities/connect/BrowserSelectMenu.vue";
import { postTurnControl } from "../../client/sandbox/streams/turnStream";
import { useOperation, useOperations } from "../../workbench/operations/operations";
import { loopbackPreviewTarget, pickTarget, type PreviewTarget } from "../../models/preview/previewModel";
import { usePreviewTargets } from "../../features/preview/usePreviewTargets";
import { noAppsLine, stateOf, tintOf } from "../../features/preview/targetWords";
import PreviewTab from "../../features/preview/PreviewTab.vue";
import PreviewStage from "../../features/preview/PreviewStage.vue";
import { phoneById, phonePickerGroups, phoneUserAgent, storePhoneId, storedPhoneId } from "../../features/preview/phoneModels";
import DesktopTab from "../../features/desktop/DesktopTab.vue";
import { useDesktopQuery } from "../../features/desktop/desktopQuery";
import { usePorts } from "../../models/sandbox/environment/usePorts";
import { useRole } from "../../client/sandbox/useRole";
import { useT } from "@intentic/ui/i18n";

// EVERYTHING LIVE THE SANDBOX SHOWS, AS TABS OF ONE BROWSER: the live apps its dev servers serve (framed straight from
// them, not streamed), the windows of its own Chromium (streamed), its desktop and each window on that desktop
// (streamed). One per window, mounted above the router (PoppablePanels.vue) and moved, never rebuilt, between /browsers,
// the side panel and a window of its own; parked, the framed apps keep their state and the streams pause.
//
// The strip leads with the reader's pins (apps, the desktop, its windows), then the pages of every open web window, each
// window's run behind its mark once there is more than the person's own, theirs last and right beside the +; the list of
// windows sits at the strip's far end. What a tab is shows in its glyph and the glyph's colour. One window streams at a
// time, the one whose page is in front; picking a tab of another switches the picture to it. The
// toolbar is the browser's: history, reload, the address bar, then whatever the tab in front owns (an app's Start and
// Stop, the hand on a desktop, an agent's window's Take over), a phone frame where a page has a layout to frame, and the
// menu. The web windows are the person's own to use: their own window takes every click and key, an agent's window does
// too once its turn is over, and only while that agent's turn runs is it watched instead, with Take over to step in.

const { parked = false } = defineProps<{
    // In the parking stage, out of sight: nothing streams, framed apps keep running.
    parked?: boolean;
}>();

const t = useT();
const { canShip } = useRole();

const front = browsersFront;
const pinned = browsersPinned;
const webInFront = computed(() => front.value.kind === `web`);
const isFront = (tab: LiveTab): boolean => sameTab(front.value, tab);
// Whether the tab in front can be seen at all: what lets a picture stream.
const seen = computed(() => !parked);

// ===== The web windows =====

const { sessions } = useBrowsersQuery();

// Only what is open: a closed window has nothing left to show or do.
const windows = computed(() => sessions.value.filter((session) => session.running));
const ownWindow = computed(() => windows.value.find((session) => session.own === true));

// Whether an agent may act in this window at any moment: its turn is running and it isn't parked waiting on the person.
// A window whose agent is done, or that was never an agent's, is the person's to use.
const agentDrives = (session: BrowserSession): boolean => {
    if (session.own === true || session.help !== undefined) {
        return false;
    }
    return session.owner !== undefined && agentTurnRunning(session.owner);
};

// The web window whose pages the strip shows, kept while a pin is in front so coming back lands where the reader was:
// the one last named, else one asking for help, else the person's own, else one an agent is busy in, else whichever
// moved last. None open is the start page.
const namedWindow = ref<string | undefined>(front.value.kind === `web` ? front.value.session : undefined);
watch(front, (tab) => {
    if (tab.kind === `web`) {
        namedWindow.value = tab.session;
    }
});
const selected = computed<string | undefined>(() => {
    const named = namedWindow.value;
    const open = windows.value;
    if (named !== undefined && open.some((session) => session.name === named)) {
        return named;
    }
    return (
        open.find((session) => session.help !== undefined) ??
        ownWindow.value ??
        open.find((session) => agentDrives(session)) ??
        open.toSorted((left, right) => right.activityAt - left.activityAt)[0]
    )?.name;
});
const current = computed(() => windows.value.find((session) => session.name === selected.value));
const pages = computed<readonly BrowserPage[]>(() => current.value?.pages ?? []);
const watchable = computed(() => current.value?.name);
const view = useBrowserView(watchable, { visible: computed(() => seen.value && webInFront.value) });

const showWindow = (name: string): void => showTab({ kind: `web`, session: name });

// The agent is driving this window, and the person has not stepped in.
const agentDriving = computed(() => current.value !== undefined && agentDrives(current.value));
const tookOver = ref(false);
// A fresh turn starting in a window the person had taken over gets the window back: its agent is about to act in it.
watch(agentDriving, (driving, before) => {
    if (driving && before === false) {
        tookOver.value = false;
    }
});
// Everything the person does to the page goes through only when this is true; the view sends nothing otherwise.
const interactive = computed(() => current.value !== undefined && (!agentDriving.value || tookOver.value));
// Re-said on every window change too: the view resets its own gate whenever it dials another window.
watch(
    [interactive, () => current.value?.name],
    ([yes]) => {
        view.driving.value = yes;
    },
    { immediate: true },
);
// Taken over from a running agent: the one state worth a ring, since a keystroke now lands in the agent's way.
const steppedIn = computed(() => agentDriving.value && tookOver.value);

// The page the user picked; cleared on window change, since a page id only means something inside its own session.
const pickedPage = ref<string | undefined>();

// Which tab reads as selected: see activePageOf for the rule.
const activePage = computed<BrowserPage | undefined>(() => activePageOf(pages.value, pickedPage.value));

const pickPage = (page: BrowserPage): void => {
    pickedPage.value = page.id;
    view.bindPage(page.id);
};

// A tab's text: title, else host, else raw url, the same ladder the daemon uses for the session label, so a tab and
// its window row never disagree. A page with none of them is a fresh tab, and says so.
const BLANK = `about:blank`;
const hostOf = (url: string): string => {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};
const pageLabel = (page: BrowserPage): string => {
    if (page.title !== undefined && page.title !== ``) {
        return page.title;
    }
    if (page.url === `` || page.url === BLANK) {
        return t(`browsers.browsers.newTab`);
    }
    return hostOf(page.url) || page.url;
};

// Whose profile a window runs in: `web` is credential-free and the person's own window is theirs; anything else is a
// connected account's signed-in profile, the only case with a name to show.
const CREDENTIAL_FREE = `web`;
const accountOf = (session: BrowserSession | undefined): string | undefined =>
    session === undefined || session.own === true || session.server === CREDENTIAL_FREE ? undefined : session.server;
const account = computed(() => accountOf(current.value));

// A window's name in the window list: the person's own is "Your browser", an agent's is that agent's conversation.
const windowName = (session: BrowserSession): string =>
    session.own === true
        ? t(`browsers.browsers.yourBrowser`)
        : ((session.owner === undefined ? undefined : agentTitle(session.owner)) ?? session.label);

// Second line of a window row: who has it now, its account when it has one, and how many tabs.
const windowMeta = (session: BrowserSession): string =>
    [
        session.own === true ? undefined : agentDrives(session) ? t(`browsers.browsers.agentBrowsing`) : t(`browsers.browsers.agentDone`),
        accountOf(session),
        t(`browsers.browsers.pageCount`, { count: session.pages.length }, session.pages.length),
    ]
        .filter((part) => part !== undefined)
        .join(` · `);

// One dot of state: asking for help, an agent at work in it, or simply open.
const dotOf = (session: BrowserSession): string =>
    session.help !== undefined ? `bg-warning` : agentDrives(session) ? `bg-primary-500` : `bg-success`;
// The strip's dot says only what wants a look; a window simply open is most of them, and a green dot on each was noise.
const stripDotOf = (session: BrowserSession): string | undefined => (session.help !== undefined || agentDrives(session) ? dotOf(session) : undefined);

// What stands for a window on the strip: a person for the reader's own, an agent's conversation by its initial, and an
// agent whose conversation isn't known by name by a robot rather than the initial of whatever page it is on.
const OWN_MARK: GroupMark = { kind: `icon`, icon: `user` };
const markOf = (session: BrowserSession): GroupMark => {
    if (session.own === true) {
        return OWN_MARK;
    }
    const letter = initialOf((session.owner === undefined ? undefined : agentTitle(session.owner)) ?? ``);
    return letter === undefined ? { kind: `icon`, icon: `robot` } : { kind: `initial`, letter };
};

// Yours first, then the agents' by who moved last.
const windowList = computed(() => [
    ...(ownWindow.value === undefined ? [] : [ownWindow.value]),
    ...windows.value.filter((session) => session.own !== true).toSorted((left, right) => right.activityAt - left.activityAt),
]);

// ===== The live apps =====

const { targets, listed: appsRead, start, stop, forward, refresh } = usePreviewTargets(browsersOpened);
// Only the list's answer can say which apps there are; until then (or while it fails) nothing is picked or promised.
const settled = computed(() => appsRead.value.state === `ready`);
const previewActions = { start, stop, forward, refresh };

// The app a pin is of, exactly: a `repo:` pin whose repo now runs as apps lands on its first app, as the old picker did,
// but an id the list does not have is gone rather than quietly some other app under this tab's name.
const targetOf = (id: string): PreviewTarget | undefined => {
    const exact = targets.value.find((target) => target.id === id);
    if (exact !== undefined || !id.startsWith(`repo:`)) {
        return exact;
    }
    const repo = id.slice(`repo:`.length);
    return targets.value.find((target) => target.repo === repo);
};

// "The live app", asked for without naming one (the palette, the status bar's chip): the app most worth seeing, once the
// list has answered, preferring one already pinned.
watch(
    [browsersWantPreview, settled, targets],
    ([wants, ready]) => {
        if (!wants || !ready) {
            return;
        }
        browsersWantPreview.value = false;
        const pinnedApp = pinned.value.find((pin) => pin.kind === `preview`);
        const pick = pickTarget(targets.value, pinnedApp?.kind === `preview` ? pinnedApp.id : undefined);
        if (pick !== undefined) {
            showTab({ kind: `preview`, id: pick.id });
        }
    },
    { immediate: true },
);

// Each pinned app's tab, by key, for what the toolbar asks of the one in front. Reactive, so the address bar follows the
// tab in front's own address; one setter per key, since a fresh function each render would unset and reset the ref
// every time and loop.
interface PreviewHandle {
    readonly reload: () => void;
    readonly navigate: (url: string) => boolean;
    readonly address: string | undefined;
    // Whether the app is in its frame yet: before that there is nothing to reload.
    readonly framed: boolean;
}
const previewHandles = shallowReactive(new Map<string, PreviewHandle>());
const previewSetters = new Map<string, (handle: unknown) => void>();
const previewRef = (key: string): ((handle: unknown) => void) => {
    const known = previewSetters.get(key);
    if (known !== undefined) {
        return known;
    }
    const setter = (handle: unknown): void => {
        if (handle === null) {
            previewHandles.delete(key);
        } else if (previewHandles.get(key) !== handle) {
            // SAFETY: the ref is PreviewTab's own instance, whose defineExpose is exactly this shape.
            previewHandles.set(key, handle as PreviewHandle);
        }
    };
    previewSetters.set(key, setter);
    return setter;
};
const frontPreview = computed(() => (front.value.kind === `preview` ? previewHandles.get(tabKey(front.value)) : undefined));

// ===== The desktop =====

const desk = useDesktopQuery();
const deskWindows = computed<readonly DesktopWindow[]>(() => desk.state.value?.list ?? []);
const windowOf = (id: string): DesktopWindow | undefined => deskWindows.value.find((entry) => entry.id === id);
// How a window is named on its tab and in its address: its title, else its program.
const windowLabel = (entry: DesktopWindow | undefined, id: string): string => entry?.title || entry?.app || id;
const appAddress = (entry: DesktopWindow | undefined, id: string): string =>
    `app://${(entry?.app ?? id).toLowerCase().replaceAll(/[^a-z0-9.-]+/gu, `-`)}`;
const DESKTOP_ADDRESS = `desktop://`;

// ===== The strip =====

const PAGE = `page:`;
// The start page's one tab: not a page anywhere yet, just where the first address will go.
const START_ID = `${PAGE}start`;

const pinTab = (pin: PinnedTab): StripTab => {
    const id = tabKey(pin);
    switch (pin.kind) {
        case `preview`: {
            const target = targetOf(pin.id);
            return {
                id,
                label: target?.label ?? pin.id.slice(pin.id.indexOf(`:`) + 1),
                note: target === undefined ? undefined : [stateOf(target), target.url].filter(Boolean).join(` · `),
                icon: `eye`,
                kind: target === undefined ? t(`browsers.kind.app`) : `${t(`browsers.kind.app`)}, ${stateOf(target)}`,
                tint: tintOf(target),
                closable: true,
                pinned: true,
            };
        }
        case `desktop`:
            return { id, label: t(`shared.desktop`), note: DESKTOP_ADDRESS, icon: `screen`, closable: true, pinned: true };
        case `app`: {
            const entry = windowOf(pin.id);
            return {
                id,
                label: windowLabel(entry, pin.id),
                note: appAddress(entry, pin.id),
                icon: `window-maximize`,
                kind: t(`browsers.kind.window`),
                closable: true,
                pinned: true,
            };
        }
    }
};

// The windows on the strip, in an order that holds still: the agents' in the order they appeared, then the person's own,
// last and right beside the +, where a tab of theirs grows in. Ordered by activity instead, the runs traded places every
// time an agent clicked. Remembered for the view's life; a window not placed yet goes at the end of the agents'.
const placed = ref<readonly string[]>([]);
watch(
    windows,
    (open) => {
        const names = new Set(open.map((session) => session.name));
        const kept = placed.value.filter((name) => names.has(name));
        const fresh = open
            .filter((session) => !kept.includes(session.name))
            .toSorted((left, right) => left.activityAt - right.activityAt)
            .map((session) => session.name);
        if (fresh.length > 0 || kept.length !== placed.value.length) {
            placed.value = [...kept, ...fresh];
        }
    },
    { immediate: true },
);
const stripWindows = computed<readonly BrowserSession[]>(() => {
    const rank = (session: BrowserSession): number =>
        session.own === true ? Number.MAX_SAFE_INTEGER : placed.value.indexOf(session.name) + 1 || placed.value.length + 1;
    return windows.value.toSorted((left, right) => rank(left) - rank(right));
});

// Whether a window's pages are the person's to act on (close, type into): their own, or an agent's that is not at work
// in it; the one in front also once they have taken it over.
const usable = (session: BrowserSession): boolean => (session.name === current.value?.name ? interactive.value : !agentDrives(session));

// Whose tabs are whose, said once the strip holds more than the person's own browser's: every window's run carries its
// mark. Only windows with a tab on the strip count; one with every tab closed has no run to tell apart.
const labelled = computed(() => {
    const shown = stripWindows.value.filter((session) => session.pages.length > 0);
    return shown.length > 1 || shown.some((session) => session.own !== true);
});
// The person's own window keeps one group key from the moment a tab of theirs is on its way, so the mark that stood
// over a tab still opening is the one the window's arrival keeps.
const OWN_GROUP = `own`;
const groupOf = (session: BrowserSession): StripGroup => ({
    id: session.own === true ? OWN_GROUP : session.name,
    label: windowName(session),
    note: windowMeta(session),
    mark: markOf(session),
    dot: stripDotOf(session),
    current: webInFront.value && session.name === selected.value,
});

// Every web page on the strip, with the window and page each tab stands for; a strip id carries the window, since a page
// id only means something inside its own.
const stripIdOf = (session: string, pageId: string): string => `${PAGE}${session}:${pageId}`;
const pageEntries = computed(() =>
    stripWindows.value.flatMap((session) => {
        const group = labelled.value ? groupOf(session) : undefined;
        return session.pages.map((page) => ({
            session,
            page,
            tab: {
                id: stripIdOf(session.name, page.id),
                key: arrivedKeys.value.get(stripIdOf(session.name, page.id)),
                label: pageLabel(page),
                note: page.url === `` ? undefined : page.url,
                icon: `globe`,
                closable: usable(session),
                pinned: false,
                group,
            } satisfies StripTab,
        }));
    }),
);
const entryOf = (stripId: string) => pageEntries.value.find((entry) => entry.tab.id === stripId);

// The person's own window's mark, standing over a tab of theirs on its way before the window itself is listed.
const ownGroup = computed<StripGroup>(() =>
    ownWindow.value === undefined
        ? { id: OWN_GROUP, label: t(`browsers.browsers.yourBrowser`), mark: OWN_MARK, current: false }
        : groupOf(ownWindow.value),
);

// A tab of the person's own on its way: drawn at once where it will land, right beside the +, and in front, the way a
// browser's new tab is there the moment it's pressed rather than once the page behind it answers.
const OPENING_ID = `${PAGE}opening`;
// Held until the tab itself is listed and put in front, so the strip never shows neither.
const tabOnTheWay = computed(
    () => current.value !== undefined && (opening.value || blankAsked.value || (pendingTab.value !== undefined && pendingTab.value.focus !== `page`)),
);
// A blank one, from the press of + until the tab is listed and in front: already a new tab in every way the reader can
// see (its own page, an empty address bar with the keyboard), since nothing about it needs the daemon's answer. One
// opened at an address is loading, and says so.
const blankOnTheWay = computed(() => tabOnTheWay.value && (blankAsked.value || pendingTab.value?.blank === true));
// What the stage draws for it, and for a tab of the person's own that is still blank once it is there: this view's own
// new-tab page rather than the picture of Chromium's about:blank, which is a white screen in any theme. An agent's
// blank page is left as the picture, since an agent may have written into it without ever giving it an address.
const newTabPage = computed(
    () =>
        blankOnTheWay.value ||
        (current.value?.own === true && activePage.value !== undefined && (activePage.value.url === `` || activePage.value.url === BLANK)),
);
const openingTab = computed<StripTab | undefined>(() =>
    tabOnTheWay.value
        ? {
              id: OPENING_ID,
              key: openingKey.value,
              label: t(`browsers.browsers.newTab`),
              icon: blankOnTheWay.value ? `globe` : `spinner`,
              spin: !blankOnTheWay.value,
              closable: false,
              pinned: false,
              group: labelled.value ? ownGroup.value : undefined,
          }
        : undefined,
);

const webTabs = computed<readonly StripTab[]>(() => {
    if (current.value === undefined) {
        // With no web window, the start page has its tab only while it is in front; behind a pin it is nothing at all.
        return webInFront.value || pinned.value.length === 0
            ? [{ id: START_ID, label: t(`browsers.browsers.newTab`), icon: `globe`, closable: false, pinned: false }]
            : [];
    }
    // The tab on its way stands in for the one it becomes until that one is taken, so the strip never shows both: by id
    // once the open has answered, and before that, as any tab of the person's own the open found not there yet, since
    // the list can carry it before the answer names it.
    const arriving = pendingTab.value?.key === undefined ? undefined : stripIdOf(pendingTab.value.name, pendingTab.value.pageId);
    const inFlight = openingTab.value !== undefined && (opening.value || blankAsked.value) ? ownBefore.value : undefined;
    const standIn = (entry: (typeof pageEntries.value)[number]): boolean =>
        openingTab.value !== undefined &&
        (entry.tab.id === arriving || (inFlight !== undefined && entry.session.own === true && !inFlight.has(entry.tab.id)));
    const tabs = pageEntries.value.flatMap((entry) => (standIn(entry) ? [] : [entry.tab]));
    return openingTab.value === undefined ? tabs : [...tabs, openingTab.value];
});
// The pins whose bodies stay mounted behind the one in front: each app keeps its frame, each desktop tab its socket.
const previewPins = computed(() => pinned.value.flatMap((pin) => (pin.kind === `preview` ? [pin] : [])));
const deskPins = computed(() => pinned.value.flatMap((pin) => (pin.kind === `desktop` || pin.kind === `app` ? [pin] : [])));
// In front and seen: what lets a tab stream and put its verbs in the toolbar.
const live = (pin: PinnedTab): boolean => seen.value && isFront(pin);

const stripTabs = computed<readonly StripTab[]>(() => [...pinned.value.map(pinTab), ...webTabs.value]);
const activeStripId = computed(() => {
    if (!webInFront.value) {
        return tabKey(front.value);
    }
    if (openingTab.value !== undefined) {
        return OPENING_ID;
    }
    if (current.value === undefined) {
        return START_ID;
    }
    return activePage.value === undefined ? undefined : stripIdOf(current.value.name, activePage.value.id);
});

// Where the keyboard goes once a tab is in front, as a browser puts it: into the page, or into the address bar of a
// blank one. Left on the strip's button, every shortcut and keystroke went nowhere until the page was clicked.
const focusPage = (page: BrowserPage | undefined): void => {
    void nextTick(() => (page === undefined || page.url === `` || page.url === BLANK ? focusAddress() : stageEl.value?.focus()));
};

// A tab of the window in front is picked right away; one of another window is picked once that window is the one
// streaming (takePendingTab), since a page id told to the window being left means nothing there.
const pickStrip = (tab: StripTab): void => {
    pendingTab.value = undefined;
    if (tab.pinned) {
        showTab(parseTabKey(tab.id));
        return;
    }
    const entry = entryOf(tab.id);
    if (current.value === undefined || entry === undefined) {
        showTab({ kind: `web`, session: current.value?.name });
        void nextTick(current.value === undefined ? focusAddress : () => stageEl.value?.focus());
        return;
    }
    if (entry.session.name !== current.value.name) {
        pendingTab.value = { name: entry.session.name, pageId: entry.page.id, focus: `page` };
        showWindow(entry.session.name);
        return;
    }
    showTab({ kind: `web`, session: current.value.name });
    pickPage(entry.page);
    focusPage(entry.page);
};

// A window's mark: that window in front, on the page it was last on.
const pickGroup = (group: StripGroup): void => {
    pendingTab.value = undefined;
    const session = group.id === OWN_GROUP ? ownWindow.value : windows.value.find((listed) => listed.name === group.id);
    if (session === undefined) {
        return;
    }
    showWindow(session.name);
    void nextTick(() => stageEl.value?.focus());
};

const closeStrip = (tab: StripTab): void => {
    if (tab.pinned) {
        const pin = parseTabKey(tab.id);
        if (pin.kind !== `web`) {
            unpinTab(pin);
        }
        return;
    }
    const entry = entryOf(tab.id);
    if (entry === undefined) {
        return;
    }
    if (entry.session.name !== current.value?.name) {
        closeElsewhere(entry.session, entry.page);
        return;
    }
    const closingFront = webInFront.value && entry.page.id === activePage.value?.id;
    closeTab(entry.page);
    // The close button goes with its tab, and the keyboard with it; the tab now in front takes it.
    if (closingFront) {
        focusPage(activePage.value);
    }
};

// The tab beside the selected one across the whole strip, wrapping; what Ctrl+Tab and Ctrl+Shift+Tab pick.
const pickNeighbour = (step: 1 | -1): void => {
    const all = stripTabs.value;
    const at = all.findIndex((tab) => tab.id === activeStripId.value);
    const next = all[(at + step + all.length) % all.length];
    if (next !== undefined) {
        pickStrip(next);
    }
};

// The address bar shows the active page's address until the owner types into it; Enter sends what they typed
// (address.ts decides whether that is an address or a search), Escape puts the page's own back.
const webAddress = computed(() => activePage.value?.url ?? BLANK);

// What Enter sent the active tab to, said until the tab reports getting there (heldAddress.ts).
const typed = useHeldAddress(activePage);

const address = computed<string>(() => {
    const tab = front.value;
    if (tab.kind === `preview`) {
        return frontPreview.value?.address ?? targetOf(tab.id)?.url ?? ``;
    }
    if (tab.kind === `desktop`) {
        return DESKTOP_ADDRESS;
    }
    if (tab.kind === `app`) {
        return appAddress(windowOf(tab.id), tab.id);
    }
    return typed.shown.value ?? (blankOnTheWay.value || webAddress.value === BLANK ? `` : webAddress.value);
});
// Where the address bar takes typing: a web page and a live app; the desktop's address is a name, not a place to go.
const addressEditable = computed(() => front.value.kind === `web` || front.value.kind === `preview`);
const addressKind = computed(() => (front.value.kind === `desktop` ? `screen` : front.value.kind === `app` ? `window-maximize` : undefined));
const omnibox = ref<{ focus: () => void } | undefined>();
const focusAddress = (): void => omnibox.value?.focus();

// ===== Opening =====

// Opening in the person's own window: the window starts on the first call, and every call answers which tab it opened,
// which goes in front once the list carries it. A blank tab hands the keyboard to the address bar, as a new tab does.
// The ledger's (operations.ts), tagged with the address asked for: a window takes seconds to start, and one asked for
// from a view left meanwhile is still starting, or failed, when the view comes back.
const opener = useOperation<Awaited<ReturnType<typeof openBrowser>>>(`browsers/open`);
const opening = opener.busy;
const openError = computed(() => opener.failure.value?.title);
// What the last open asked for, so Try again asks for it again whichever field it came from.
const lastOpen = computed(() => opener.operation.value?.tag);
// A tab to put in front once its window is the one streaming and the list carries it, and where the keyboard goes then:
// the address bar of a blank tab, the page of one opened at an address, either for a tab picked on the strip.
interface PendingTab {
    readonly name: string;
    readonly pageId: string;
    readonly focus: `address` | `stage` | `page`;
    // Opened blank: drawn as a new tab until it arrives, and where an address typed meanwhile goes (`queued`).
    readonly blank?: boolean;
    // The strip key of the tab drawn while it was on its way, which it takes over on arrival (StripTab's `key`).
    readonly key?: string;
}
const pendingTab = shallowRef<PendingTab | undefined>();
// A tab that never came (closed as it opened) gives up after a while, so one the same window lists later can't grab the
// front and the keyboard out of nowhere.
const PENDING_MS = 10_000;
let pendingTimer: number | undefined;
const awaitTab = (pending: PendingTab | undefined): void => {
    pendingTab.value = pending;
    window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(() => {
        if (pendingTab.value === pending) {
            pendingTab.value = undefined;
        }
    }, PENDING_MS);
};
// A blank tab asked for and not answered yet: set on the press itself, since the ledger's run says it is busy only a
// tick later, after the address bar has already been focused on the address being left. Once answered, the pending
// tab's `blank` says it instead.
const blankAsked = ref(false);
// An address Enter sent from a blank tab still on its way, sent to that tab by id once it arrives (takePendingTab).
const queued = ref<string | undefined>();
// One strip key per open, and the ones tabs took over on arrival, by strip id: the tab drawn at once and the tab that
// arrives are one tab on the strip, filled in, rather than one folding away while another grows in beside it.
let opens = 0;
const openingKey = ref(`${OPENING_ID}:0`);
// The person's own tabs as the open found them, by strip id: whichever else the list carries before the open answers is
// the one on its way.
const ownBefore = shallowRef<ReadonlySet<string> | undefined>();
const arrivedKeys = shallowRef<ReadonlyMap<string, string>>(new Map());
const openOwn = async (url?: string): Promise<void> => {
    if (opening.value || blankAsked.value) {
        return;
    }
    queued.value = undefined;
    opens += 1;
    openingKey.value = `${OPENING_ID}:${opens}`;
    const own = ownWindow.value;
    ownBefore.value = new Set(own === undefined ? [] : own.pages.map((page) => stripIdOf(own.name, page.id)));
    if (url === undefined) {
        typed.release();
    } else {
        typed.hold(url, undefined);
    }
    showTab({ kind: `web`, session: current.value?.own === true ? current.value.name : namedWindow.value });
    if (url === undefined && current.value !== undefined) {
        // The new tab is already in front (blankOnTheWay), so the keyboard is the address bar's now, not once it arrives.
        blankAsked.value = true;
        void nextTick(focusAddress);
    }
    const ran = await opener.run({
        what: t(`browsers.browsers.starting`),
        tag: url,
        failed: (error) => noticeOf(errorMessage(error)),
        // The window coming up is the answer.
        quiet: true,
        task: () => openBrowser(url),
    });
    const opened = ran?.state === `done` ? ran.value : undefined;
    blankAsked.value = false;
    if (opened === undefined) {
        queued.value = undefined;
        typed.release();
        return;
    }
    // Read here, it is no news the next time this view comes back.
    opener.dismiss();
    if (opened.pageId === undefined) {
        // A window that could not say which tab (an older daemon): the address typed into it has no tab to go to.
        queued.value = undefined;
    }
    awaitTab(
        opened.pageId === undefined
            ? undefined
            : {
                  name: opened.name,
                  pageId: opened.pageId,
                  focus: url === undefined && queued.value === undefined ? `address` : `stage`,
                  blank: url === undefined,
                  key: openingKey.value,
              },
    );
    if (opened.pageId === undefined) {
        // No tab to say it of: the held address has nowhere to stand.
        typed.release();
    } else {
        typed.settle(opened.pageId);
    }
    showWindow(opened.name);
};
const takePendingTab = (): void => {
    const pending = pendingTab.value;
    const page = pending === undefined || pending.name !== selected.value ? undefined : pages.value.find((listed) => listed.id === pending.pageId);
    if (pending === undefined || page === undefined) {
        return;
    }
    pendingTab.value = undefined;
    if (pending.key !== undefined) {
        arrivedKeys.value = new Map(arrivedKeys.value).set(stripIdOf(pending.name, page.id), pending.key);
    }
    pickPage(page);
    const sent = pending.blank === true ? queued.value : undefined;
    queued.value = undefined;
    if (sent !== undefined) {
        // By id: the picture's `bind` just sent may not have reached the window yet, and the tab it shows is another.
        view.navigate(sent, page.id);
    }
    // A blank tab is for typing an address; one opened at an address is for the page, which takes the keyboard as a
    // browser gives it after Enter (the field it was typed in may be gone with the start page).
    const focus = sent === undefined ? pending.focus : `stage`;
    void nextTick(() => (focus === `address` ? focusAddress() : focus === `stage` ? stageEl.value?.focus() : focusPage(page)));
};
// After the render, not before: by then the picture has dialled the window being switched to (useBrowserView's own
// watch), so the page told to it is told to the right window rather than wiped with the one being left.
watch([pendingTab, selected, pages], takePendingTab, { flush: `post` });

// Ctrl+T, the +, the strip's double-click and the launcher's first row: a tab in the person's own window, whatever is in
// front. An agent's window is closed a couple of minutes after its turn ends, taking any tab opened in it along, and one
// an agent is at work in is not the person's to add to; theirs is, and keeps what they sign into. With no window open at
// all it is the start page, whose search box starts theirs.
const openTab = (): void => {
    if (current.value === undefined) {
        showTab({ kind: `web`, session: undefined });
        void nextTick(focusAddress);
        return;
    }
    void openOwn();
};

// A tab closed in a window not in front: over the roster's own call, since only the window in front has a socket open.
// The last tab of the person's own window takes the window with it, as it does in front.
const closeElsewhere = (session: BrowserSession, page: BrowserPage): void => {
    if (!usable(session)) {
        return;
    }
    if (session.own === true && session.pages.length === 1) {
        void closeBrowser(session.name);
        return;
    }
    void closeBrowserPage(session.name, page.id);
};

// The ports the shell already holds, for telling a typed localhost address that is one of the sandbox's own apps.
const { offered } = usePorts();

// Where a typed address goes when the web is in front: this window when it is the person's own, or an agent's they are
// working in on purpose (answering its ask, or taken over). Any other agent's window is one they are only looking at,
// and closes a couple of minutes after its turn ends; somewhere new goes to their own window, where it stays.
const navigatesHere = computed(
    () => current.value !== undefined && interactive.value && (current.value.own === true || current.value.help !== undefined || tookOver.value),
);

// The address bar's Enter. On a live app, a path on its own host stays in its frame; an address the sandbox serves as
// one of its apps goes to that app's tab; anything else is the web's, here when this is the window being worked in (see
// navigatesHere), and otherwise in the person's own window, the way typing into a browser always goes somewhere.
const submitAddress = (text: string): void => {
    const url = toUrl(text);
    if (url === undefined) {
        return;
    }
    if (front.value.kind === `preview` && frontPreview.value?.navigate(url) === true) {
        return;
    }
    const app = loopbackPreviewTarget(url, offered.value);
    if (app !== undefined) {
        showTab({ kind: `preview`, id: app });
        return;
    }
    if (front.value.kind === `web` && blankOnTheWay.value) {
        // Typed into the new tab before it arrived: it goes there once it does, never into the tab left behind it.
        queued.value = url;
        typed.hold(url, pendingTab.value?.pageId);
        return;
    }
    if (front.value.kind === `web` && navigatesHere.value) {
        typed.hold(url, activePage.value?.id);
        view.navigate(url);
        stageEl.value?.focus();
        return;
    }
    void openOwn(url);
};

// Closing the tab in front puts its neighbour in front (the one after it, else the one before), as a browser does. The
// last tab of the person's own window takes the window with it, which is what closing a browser's last tab does.
const closeTab = (page: BrowserPage): void => {
    const here = current.value;
    if (here === undefined || !interactive.value) {
        return;
    }
    if (here.own === true && pages.value.length === 1) {
        void closeBrowser(here.name);
        return;
    }
    if (page.id === activePage.value?.id) {
        const at = pages.value.findIndex((listed) => listed.id === page.id);
        const neighbour = pages.value[at + 1] ?? pages.value[at - 1];
        if (neighbour !== undefined) {
            pickPage(neighbour);
        }
    }
    view.closeTab(page.id);
};

// ===== The launcher =====

const launcherOpen = ref(false);
const launcherAnchor = ref<HTMLElement | undefined>();
const openLauncher = (anchor: HTMLElement): void => {
    launcherAnchor.value = anchor;
    launcherOpen.value = !launcherOpen.value;
};

const WEB_ITEM = `web`;
const pinnedKeys = computed(() => new Set(pinned.value.map(tabKey)));
const appItems = computed(() =>
    targets.value.map((target) => {
        const key = tabKey({ kind: `preview`, id: target.id });
        return {
            key,
            label: target.label,
            detail: target.detail === undefined ? stateOf(target) : `${target.detail} · ${stateOf(target)}`,
            icon: `eye` as const,
            tint: tintOf(target),
            open: pinnedKeys.value.has(key),
        };
    }),
);
// The desktop is a maintainer's to drive (the daemon refuses the rest), so only they are offered it.
const deskItems = computed(() =>
    canShip.value
        ? [
              { key: tabKey({ kind: `desktop` }), label: t(`shared.desktop`), detail: DESKTOP_ADDRESS, icon: `screen` as const, open: pinnedKeys.value.has(`desktop`) },
              ...deskWindows.value.map((entry) => {
                  const key = tabKey({ kind: `app`, id: entry.id });
                  return {
                      key,
                      label: windowLabel(entry, entry.id),
                      detail: appAddress(entry, entry.id),
                      icon: `window-maximize` as const,
                      open: pinnedKeys.value.has(key),
                  };
              }),
          ]
        : [],
);
const launchGroups = computed<readonly LaunchGroup[]>(() => [
    { label: ``, items: [{ key: WEB_ITEM, label: t(`browsers.browsers.newTab`), detail: t(`browsers.launcher.webDetail`), icon: `globe` }] },
    {
        label: t(`browsers.launcher.apps`),
        items: appItems.value,
        empty: noAppsLine(appsRead.value),
    },
    ...(deskItems.value.length === 0 ? [] : [{ label: t(`shared.desktop`), items: deskItems.value }]),
]);
// The start page's own offer: everything but a web tab, which its search box already is.
const startGroups = computed<readonly LaunchGroup[]>(() => launchGroups.value.slice(1));

const launch = (key: string): void => {
    launcherOpen.value = false;
    if (key === WEB_ITEM) {
        openTab();
        return;
    }
    showTab(parseTabKey(key));
};

// ===== The picture =====

// Two picture surfaces: a video canvas with a still canvas over it, or an img for frames when there's no display to
// grab. Pointer coordinates measure against whichever is painting (viewportCoords), not the stage around it; all
// use `object-contain`.
const frameEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const stillEl = ref<HTMLCanvasElement | null>(null);
const stageEl = ref<HTMLElement | null>(null);
// Whichever of the two is painting; every pointer handler measures against this instead of its own copy.
const pictureEl = computed<HTMLElement | undefined>(() => canvasEl.value ?? frameEl.value ?? undefined);
// The canvases mount/unmount with the picture kind; the decoder outlives them, so they're connected here.
watch([canvasEl, stillEl], ([canvas, still]) => view.attachCanvases(canvas, still));

// Stepping in while an agent drives, and handing the window back to it. Escape is not an exit, keyIntent forwards it
// to the page.
const takeOver = (): void => {
    tookOver.value = true;
    watchHint.value = false;
    stageEl.value?.focus();
};
const handBack = (): void => {
    tookOver.value = false;
};

// A click on a page an agent is driving does nothing, which a browser never does; so it says why, once, and offers to
// step in right where the click landed. Gone by itself, since the click was most likely just a look.
const HINT_MS = 3500;
const watchHint = ref(false);
let hintTimer: number | undefined;
const onStageDown = (event: MouseEvent): void => {
    if (interactive.value) {
        if (pictureEl.value !== undefined) {
            view.onMouseDown(event, pictureEl.value);
        }
        return;
    }
    if (event.button !== 0) {
        return;
    }
    watchHint.value = true;
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => (watchHint.value = false), HINT_MS);
};

const reload = (): void => {
    if (front.value.kind === `preview`) {
        frontPreview.value?.reload();
        return;
    }
    view.reload();
};

// What the browser's own shortcuts do here: the tabs and the address bar are this pane's, the rest is the view's.
const COMMANDS: Record<BrowserCommand, () => void> = {
    newTab: openTab,
    closeTab: () => {
        if (activePage.value !== undefined) {
            closeTab(activePage.value);
        }
    },
    address: focusAddress,
    nextTab: () => pickNeighbour(1),
    prevTab: () => pickNeighbour(-1),
    back: view.back,
    forward: view.forward,
    reload: view.reload,
    find: view.find,
};
const onCommand = (command: BrowserCommand): void => COMMANDS[command]();

const close = (name: string): void => void closeBrowser(name);

// The card renders the daemon's `help` flag and answers over the same /agent/reply channel the chat cards use; it
// closes when the daemon clears the flag, not from any local mutation. `helpNote` goes back to the agent either way.
// While it is open the window is the person's to use: the agent is parked on exactly that.
const helpNote = ref(``);
// A card on the picture folds to a chip without answering it, so it can stop covering what it's asking about.
const helpOpen = ref(true);

// Other windows waiting for hands surface as a chip beside the current ask, since the agent can be stuck in several at
// once; the selected window's own ask is the card above, not counted here.
const queuedHelp = computed(() => windows.value.filter((session) => session.help !== undefined && session.name !== selected.value));
// Any window asking while a pin is in front: the window list's chip says so, since no card is on screen to.
const helpBehind = computed(() => queuedHelp.value.length > 0 || (!webInFront.value && current.value?.help !== undefined));

// A JavaScript dialog the page has open, held by the daemon until someone answers; the prompt's text starts as what
// the page prefilled, and follows the dialog rather than the pane, so a second prompt doesn't inherit the first's.
const dialog = computed(() => current.value?.dialog);
const dialogText = ref(``);
watch(
    dialog,
    (open) => {
        dialogText.value = open?.defaultValue ?? ``;
    },
    { immediate: true },
);
const answerDialog = (accept: boolean): void => {
    if (dialog.value === undefined) {
        return;
    }
    view.answerDialog(accept, dialog.value.kind === `prompt` && accept ? dialogText.value : undefined);
};

const switcherOpen = ref(false);
const switcherTrigger = ref<HTMLElement | undefined>();
const menuOpen = ref(false);
const menuTrigger = ref<HTMLElement | undefined>();
const queueOpen = ref(false);

// Everything tied to the window being left behind (picked page, a tab on its way, a step-in, draft note, open menus)
// resets with it.
watch(selected, () => {
    pickedPage.value = undefined;
    tookOver.value = false;
    helpNote.value = ``;
    helpOpen.value = true;
    watchHint.value = false;
    switcherOpen.value = false;
    menuOpen.value = false;
    queueOpen.value = false;
});

// One reply per ask, by its request id, in the ledger: the ask is cleared by the daemon, not locally, so until the reply
// lands `help` still reads as open, here and in this view drawn again.
const replies = useOperations(`browsers/help`);
const replying = computed(() => {
    const help = current.value?.help;
    return help !== undefined && replies.at(help.requestId)?.state === `running`;
});
const replyError = computed(() => {
    const help = current.value?.help;
    return help === undefined ? undefined : replies.at(help.requestId)?.failure;
});
const resolveHelp = async (helped: boolean): Promise<void> => {
    const help = current.value?.help;
    if (help === undefined || replying.value) {
        return;
    }
    const note = helpNote.value.trim();
    const ran = await replies.run(help.requestId, {
        what: helped ? t(`chat.words.doneHandBack`) : t(`chat.words.cantHelpNow`),
        failed: t(`browsers.browsers.replyFailed`),
        // The ask going away is the answer.
        quiet: true,
        // undefined targets this box: a browser session belongs to the machine it runs on, and this view only lists the
        // active sandbox's (see postTurnControl).
        task: async () => {
            await postTurnControl(undefined, `reply`, {
                kind: `browser_help`,
                requestId: help.requestId,
                helped,
                ...(note === `` ? {} : { note }),
            });
        },
    });
    if (ran?.state === `done`) {
        helpNote.value = ``;
        replies.dismiss(help.requestId);
    }
};

// ===== The phone frame =====

// Per tab, by key: a live app framed as a phone stays a phone while another tab is in front. The handset is one choice
// for the whole view, remembered, as the old Preview's was.
const phoneTabs = ref<ReadonlySet<string>>(new Set());
const phoneId = ref(storedPhoneId());
const phone = computed(() => phoneById(phoneId.value));
const phoneOptions = phonePickerGroups();
// Clearing isn't a choice the list offers: there is always a handset on the stage.
const phoneChoice = computed<string | undefined>({
    get: () => phoneId.value,
    set: (id) => {
        if (id !== undefined) {
            phoneId.value = id;
            storePhoneId(id);
        }
    },
});
// The key a web window's frame is remembered under: the window, since its pages share one viewport.
const phoneKeyOf = (tab: LiveTab): string => (tab.kind === `web` ? `web:${current.value?.name ?? ``}` : tabKey(tab));
const framesPhone = (tab: LiveTab): boolean => phoneTabs.value.has(phoneKeyOf(tab));
// Only what has a page layout to frame: a live app and a web page; a desktop is a screen already.
const phoneable = computed(() => front.value.kind === `preview` || (front.value.kind === `web` && current.value !== undefined));
const phoneOn = computed(() => phoneable.value && framesPhone(front.value));
const togglePhone = (): void => {
    const key = phoneKeyOf(front.value);
    const next = new Set(phoneTabs.value);
    if (!next.delete(key)) {
        next.add(key);
    }
    phoneTabs.value = next;
};
// The web window renders as the handset's own viewport, under the make's own browser, while it wears one.
const webPhone = computed(() => (current.value !== undefined && framesPhone({ kind: `web`, session: current.value.name }) ? phone.value : undefined));
watch(
    [webPhone, () => current.value?.name],
    ([model]) => view.emulate(model === undefined ? undefined : { width: model.width, height: model.height, mobile: true, userAgent: phoneUserAgent(model) }),
    { immediate: true },
);

// ===== Sizes =====

// The stage's box is what the daemon sizes the page's viewport to, so the picture is the page at 1:1 rather than
// scaled into whatever is left; measured via ResizeObserver, since the chrome's own text-scaled height is part of
// what's left.
let observer: ResizeObserver | undefined;
watch(stageEl, (stage) => {
    observer?.disconnect();
    observer = undefined;
    // Null, not undefined: the stage lives under `v-if="current"`, and Vue writes null into the ref the moment that
    // element goes. `observe(null)` throws where the picture stops rather than where it is read.
    if (stage === null) {
        return;
    }
    observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
            view.requestSize(entry.contentRect.width, entry.contentRect.height);
        }
    });
    observer.observe(stage);
});

// Read off the view's own width, not a viewport breakpoint, since this pane's width has nothing to do with the screen's
// (a side panel, a window of its own). Only the account's name, the verbs' words and the phone's picker give way; tabs
// and address never do.
const rootEl = ref<HTMLElement | null>(null);
const rootWidth = ref(0);
let rootObserver: ResizeObserver | undefined;
onMounted(() => {
    if (rootEl.value === null) {
        return;
    }
    rootObserver = new ResizeObserver(([entry]) => {
        rootWidth.value = entry?.contentRect.width ?? 0;
    });
    rootObserver.observe(rootEl.value);
});
const compact = computed(() => rootWidth.value > 0 && rootWidth.value < 640);

// Where the tab in front puts its own verbs: a live app's Start and Stop, the desktop's hand on the wheel.
const toolsEl = ref<HTMLElement | undefined>();

// ===== The start page =====

// The start page's own search box, which takes the keyboard as the view opens on nothing.
const startField = ref<HTMLInputElement | undefined>();
const startText = ref(``);
const submitStart = (): void => {
    const url = toUrl(startText.value);
    if (url !== undefined) {
        void openOwn(url);
    }
};
// Whenever the view lands on nothing open (on arrival, or once the last window closes), the keyboard goes to the
// search box, the way a new browser window opens ready to type; not while parked, where nobody is looking.
const onStart = computed(() => webInFront.value && current.value === undefined && !parked);
watch(
    onStart,
    (empty) => {
        if (empty) {
            void nextTick(() => startField.value?.focus());
        }
    },
    { flush: `post` },
);
onMounted(() => {
    if (onStart.value) {
        startField.value?.focus();
    }
});
onBeforeUnmount(() => {
    observer?.disconnect();
    rootObserver?.disconnect();
    window.clearTimeout(hintTimer);
    window.clearTimeout(pendingTimer);
});

const { floats } = useBrowsersFloating();
</script>

<template>
    <div ref="rootEl" class="flex h-full min-h-0 w-full flex-col overflow-hidden bg-card">
        <!-- The strip: the pins, every open window's pages, the +, and at its far end the list of open windows when there is more than one. -->
        <div class="flex shrink-0 items-end bg-canvas pt-1">
            <LiveTabStrip
                :tabs="stripTabs"
                :active-id="activeStripId"
                @pick="pickStrip"
                @close="closeStrip"
                @pick-group="pickGroup"
                @open="openLauncher"
                @quick-open="openTab"
            >
                <template #end>
                    <template v-if="windowList.length > 1">
                        <button
                            ref="switcherTrigger"
                            type="button"
                            :class="ui.chip({ on: switcherOpen }, `mb-1 mr-1.5 shrink-0 self-center text-content`)"
                            aria-haspopup="menu"
                            :aria-expanded="switcherOpen"
                            :aria-label="t(`browsers.browsers.switchWindow`)"
                            v-tooltip.bottom="{
                                title: t(`browsers.browsers.switchWindow`),
                                rows: [{ label: t(`browsers.browsers.openCount`), value: windowList.length }],
                            }"
                            @click="switcherOpen = !switcherOpen"
                        >
                            <!-- A window is parked on an ask out of sight: this is what opens it. -->
                            <Icon v-if="helpBehind" name="exclamation-triangle" class="shrink-0 text-3xs text-warning" />
                            <Icon name="browsers" class="shrink-0 text-2xs" />
                            <span class="tabular-nums">{{ windowList.length }}</span>
                            <Icon name="chevron-down" class="shrink-0 text-3xs text-muted" />
                        </button>
                        <AnchoredOverlay v-model="switcherOpen" :anchor="switcherTrigger" side="bottom" cross="end">
                            <div class="flex w-72 flex-col gap-0.5 p-1">
                                <button
                                    v-for="session in windowList"
                                    :key="session.name"
                                    type="button"
                                    class="ui-row-select flex items-center gap-2 rounded-md px-2 py-1.5 text-left"
                                    :class="{ 'ui-row-select-on': session.name === selected && webInFront }"
                                    @click="
                                        switcherOpen = false;
                                        showWindow(session.name);
                                    "
                                >
                                    <span class="size-1.5 shrink-0 rounded-full" :class="dotOf(session)" />
                                    <span class="min-w-0 flex-1">
                                        <span class="block truncate text-xs" :class="session.name === selected && webInFront ? 'text-link' : 'text-content'">{{
                                            windowName(session)
                                        }}</span>
                                        <span class="block truncate text-3xs text-muted">{{ windowMeta(session) }}</span>
                                    </span>
                                    <Icon v-if="session.help !== undefined" name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
                                </button>
                            </div>
                        </AnchoredOverlay>
                    </template>
                    <!-- One window, asking for help behind a pin: the strip still says so, and goes to it. -->
                    <button
                        v-else-if="helpBehind && current"
                        type="button"
                        class="ui-chip mb-1 mr-1.5 shrink-0 self-center text-content"
                        :aria-label="t(`browsers.browsers.help`)"
                        v-tooltip.bottom="current.help?.message"
                        @click="showWindow(current.name)"
                    >
                        <Icon name="exclamation-triangle" class="shrink-0 text-3xs text-warning" />
                        <Icon name="browsers" class="shrink-0 text-2xs" />
                    </button>
                </template>
            </LiveTabStrip>
            <AnchoredOverlay v-model="launcherOpen" :anchor="launcherAnchor" side="bottom" cross="start">
                <LiveLauncher :groups="launchGroups" variant="menu" @pick="launch" />
            </AnchoredOverlay>
        </div>

        <!-- The toolbar: history, the address bar that is also the search box, what the tab in front owns, and the menu. -->
        <div class="view-header flex h-10 shrink-0 items-center gap-0.5 border-b border-line bg-card px-2">
            <button
                type="button"
                :class="ui.iconButton({ size: `md`, round: true })"
                :disabled="!webInFront || !interactive || blankOnTheWay"
                :aria-label="t(`browsers.browsers.back`)"
                v-tooltip.bottom="t(`browsers.browsers.back`)"
                @click="view.back()"
            >
                <Icon name="arrow-left" class="text-xs" />
            </button>
            <button
                v-if="!compact"
                type="button"
                :class="ui.iconButton({ size: `md`, round: true })"
                :disabled="!webInFront || !interactive || blankOnTheWay"
                :aria-label="t(`browsers.browsers.forward`)"
                v-tooltip.bottom="t(`browsers.browsers.forward`)"
                @click="view.forward()"
            >
                <Icon name="arrow-right" class="text-xs" />
            </button>
            <button
                type="button"
                :class="ui.iconButton({ size: `md`, round: true })"
                :disabled="front.kind === `preview` ? frontPreview?.framed !== true : !webInFront || !interactive || blankOnTheWay"
                :aria-label="t(`ui.action.reload`)"
                v-tooltip.bottom="t(`ui.action.reload`)"
                @click="reload"
            >
                <Icon name="refresh" class="text-xs" />
            </button>

            <Omnibox
                ref="omnibox"
                :editable="addressEditable"
                :value="address"
                :kind="addressKind"
                :placeholder="t(`browsers.browsers.addressPlaceholder`)"
                :copy-label="t(`browsers.browsers.copyAddress`)"
                :secure-label="t(`browsers.browsers.connectionSecure`)"
                :insecure-label="t(`browsers.browsers.connectionNotSecure`)"
                class="mx-1.5 flex-1"
                @submit="submitAddress"
                @cancel="stageEl?.focus()"
            />

            <!-- The tab in front's own verbs: a live app's Start and Stop and its terminal, the desktop's hand on the wheel. -->
            <div ref="toolsEl" class="flex shrink-0 items-center gap-1 empty:hidden"></div>

            <template v-if="webInFront">
                <!-- Whose profile this window runs in, where a browser keeps its profile button; only a signed-in one has a name to show. -->
                <span
                    v-if="account"
                    class="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-overlay pl-1 text-2xs text-content"
                    :class="compact ? 'pr-1' : 'pr-2.5'"
                    v-tooltip.bottom="{
                        title: t(`browsers.browsers.signedIn`),
                        rows: [{ label: t(`browsers.browsers.account`), value: account }],
                    }"
                >
                    <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-card text-muted">
                        <Icon name="user" class="text-3xs" />
                    </span>
                    <span v-if="!compact" class="max-w-28 truncate">{{ account }}</span>
                </span>

                <!-- Only while an agent drives this window: who has it, and the one press to change that. -->
                <template v-if="agentDriving">
                    <button
                        v-if="steppedIn"
                        type="button"
                        :class="ui.chip({ on: true }, `ml-1 shrink-0 font-medium`)"
                        v-tooltip.bottom="{ title: t(`browsers.browsers.handBack`), note: t(`browsers.browsers.agentCarriesOn`) }"
                        @click="handBack"
                    >
                        <span class="size-1.5 rounded-full bg-primary-500"></span>
                        {{ compact ? t(`browsers.browsers.handBack`) : t(`browsers.browsers.inControlHandBack`) }}
                    </button>
                    <template v-else>
                        <span v-if="!compact" class="ml-1 flex shrink-0 items-center gap-1.5 text-2xs text-muted">
                            <Icon name="robot" class="text-2xs" />
                            {{ t(`browsers.browsers.agentBrowsing`) }}
                        </span>
                        <button
                            type="button"
                            class="ui-chip ml-1 shrink-0 font-medium text-content"
                            v-tooltip.bottom="{ title: t(`browsers.browsers.takeOver`), note: t(`browsers.browsers.sendsYourInput`) }"
                            @click="takeOver"
                        >
                            {{ t(`browsers.browsers.takeOver`) }}
                        </button>
                    </template>
                </template>
            </template>

            <!-- The phone frame, for what has a page layout to frame: the handset, once on, beside it. -->
            <template v-if="phoneable">
                <Picker
                    v-if="phoneOn && !compact"
                    v-model="phoneChoice"
                    :options="phoneOptions"
                    variant="ghost"
                    :search-threshold="12"
                    :aria-label="t(`preview.previewPanel.phoneToFramePreview`)"
                    :header="t(`preview.previewPanel.phone`)"
                />
                <button
                    type="button"
                    :class="ui.iconButton({ on: phoneOn, size: `md`, round: true })"
                    :aria-pressed="phoneOn"
                    :aria-label="t(`browsers.phone.toggle`)"
                    v-tooltip.bottom="{ title: t(`browsers.phone.toggle`), note: phoneOn ? phone.label : t(`browsers.phone.note`) }"
                    @click="togglePhone"
                >
                    <Icon name="mobile" class="text-xs" />
                </button>
            </template>

            <!-- The view's own menu: the rare verbs, kept off the toolbar. -->
            <button
                ref="menuTrigger"
                type="button"
                :class="ui.iconButton({ on: menuOpen, size: `md`, round: true })"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
                :aria-label="t(`browsers.browsers.more`)"
                v-tooltip.bottom="t(`browsers.browsers.more`)"
                @click="menuOpen = !menuOpen"
            >
                <Icon name="ellipsis" class="rotate-90 text-xs" />
            </button>
            <AnchoredOverlay v-model="menuOpen" :anchor="menuTrigger" side="bottom" cross="end">
                <div class="flex w-60 flex-col gap-0.5 p-1">
                    <button
                        type="button"
                        class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                        @click="
                            menuOpen = false;
                            openTab();
                        "
                    >
                        <Icon name="plus" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 flex-1 truncate">{{ t(`browsers.browsers.newTab`) }}</span>
                    </button>
                    <!-- From an agent's window to your own: a switch when it is open, a start when it isn't. -->
                    <button
                        v-if="webInFront && current !== undefined && current.own !== true"
                        type="button"
                        class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                        @click="
                            menuOpen = false;
                            ownWindow ? showWindow(ownWindow.name) : openOwn();
                        "
                    >
                        <Icon name="browsers" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 flex-1 truncate">{{ t(`browsers.browsers.yourBrowser`) }}</span>
                    </button>
                    <a
                        v-if="addressEditable && address !== ``"
                        :href="address"
                        target="_blank"
                        rel="noreferrer"
                        class="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                        @click="menuOpen = false"
                    >
                        <Icon name="arrow-up-right" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 flex-1 truncate">{{ t(`browsers.browsers.openAddressYourself`) }}</span>
                    </a>
                    <!-- The handset, in the menu when the toolbar is too narrow to carry its picker. -->
                    <div v-if="phoneOn && compact" class="px-1 py-0.5">
                        <Picker
                            v-model="phoneChoice"
                            :options="phoneOptions"
                            variant="ghost"
                            :search-threshold="12"
                            :aria-label="t(`preview.previewPanel.phoneToFramePreview`)"
                            :header="t(`preview.previewPanel.phone`)"
                        />
                    </div>
                    <button
                        type="button"
                        class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                        @click="
                            menuOpen = false;
                            toggleBrowsersFloating();
                        "
                    >
                        <Icon :name="floats ? `sign-in` : `external-link`" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 flex-1 truncate">{{ floats ? t(`browsers.window.dock`) : t(`browsers.window.popOut`) }}</span>
                    </button>
                    <template v-if="webInFront && current !== undefined">
                        <div class="mx-2 my-0.5 h-px bg-line" />
                        <button
                            type="button"
                            class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-danger-600/10 hover:text-danger"
                            @click="
                                menuOpen = false;
                                close(current.name);
                            "
                        >
                            <Icon name="times" class="shrink-0 text-2xs text-muted" />
                            <span class="min-w-0 flex-1">
                                <span class="block">{{ t(`browsers.browsers.closeBrowser`) }}</span>
                                <span v-if="current.own !== true" class="block text-3xs text-muted">{{ t(`browsers.browsers.agentsNextBrowserTool`) }}</span>
                            </span>
                        </button>
                    </template>
                </div>
            </AnchoredOverlay>
        </div>

        <!-- What is in front. Every pin's body stays mounted behind it, so an app keeps its state and a desktop its socket. -->
        <div class="relative min-h-0 flex-1">
            <!-- The web window: whatever the stage's box is, the daemon sizes the viewport to it, unless a phone sets it. -->
            <div v-show="webInFront" class="absolute inset-0" :class="current ? 'bg-terminal' : 'bg-card'">
                <div
                    v-if="current"
                    ref="stageEl"
                    tabindex="0"
                    class="absolute inset-0 flex select-none outline-none"
                    :style="view.kind.value === 'video' ? { cursor: interactive ? view.cursor.value : 'default' } : undefined"
                    @mousemove="pictureEl && view.onMouseMove($event, pictureEl)"
                    @mousedown="onStageDown"
                    @mouseup="pictureEl && view.onMouseUp($event, pictureEl)"
                    @wheel="pictureEl && view.onWheel($event, pictureEl)"
                    @keydown="view.onKeyDown($event, onCommand)"
                    @paste="view.onPaste"
                    @contextmenu.prevent
                >
                    <!-- Full bleed, or the page as a phone's own viewport inside a drawn handset; the same picture either way. -->
                    <PreviewStage :phone="webPhone" :clip-gutter="false" backdrop="bg-terminal">
                        <template #default="{ frame }">
                            <div :style="frame" class="relative">
                                <!-- The page's viewport off the browser's own X display: video beneath, a sharp still of the settled page over it (videoSink); the same box, so a click aims the same on either. -->
                                <template v-if="view.kind.value === 'video'">
                                    <canvas ref="canvasEl" class="absolute inset-0 h-full w-full object-contain" />
                                    <canvas ref="stillEl" class="pointer-events-none absolute inset-0 h-full w-full object-contain" />
                                </template>
                                <!-- Display-less browsers expose one compositor surface without a cursor. -->
                                <img
                                    v-else
                                    v-show="view.frame.value"
                                    ref="frameEl"
                                    :src="view.frame.value"
                                    :style="interactive ? { cursor: view.cursor.value } : undefined"
                                    alt=""
                                    draggable="false"
                                    class="h-full w-full object-contain"
                                />
                            </div>
                        </template>
                    </PreviewStage>
                    <div v-if="view.status.value" class="absolute inset-0 flex items-center justify-center px-4">
                        <span class="rounded-md bg-card px-2 py-1 text-center text-xs text-muted">{{ view.statusWithElapsed.value }}</span>
                    </div>
                    <!-- An open drop-down the picture itself can't show; only happens on the frames path, since a native menu on video is already photographed and clickable. -->
                    <BrowserSelectMenu
                        v-if="view.select.value && interactive"
                        :menu="view.select.value"
                        :frame="pictureEl"
                        :view-width="view.viewWidth.value"
                        :view-height="view.viewHeight.value"
                        @pick="view.chooseOption"
                        @close="view.closeSelect"
                    />
                </div>

                <!-- Nothing open: a new tab's page, whose search box (like the address bar above it) starts the person's own window, and under it everything else this view can open. -->
                <div v-else class="absolute inset-0 flex justify-center overflow-y-auto p-6">
                    <div class="my-auto flex w-full max-w-xl flex-col items-center gap-5">
                        <Icon name="browsers" class="text-3xl text-subtle" />
                        <form class="ui-field-shell flex h-11 w-full items-center gap-3 rounded-full px-4" @submit.prevent="submitStart">
                            <Icon name="search" class="shrink-0 text-xs text-subtle" />
                            <!-- allow(substitutes): a browser's address field (a URL, or words to search the web for on Enter), not a filter over a list -->
                            <input
                                ref="startField"
                                v-model="startText"
                                type="text"
                                spellcheck="false"
                                autocomplete="off"
                                autocapitalize="off"
                                enterkeyhint="go"
                                :disabled="opening"
                                :placeholder="t(`browsers.browsers.addressPlaceholder`)"
                                :aria-label="t(`browsers.browsers.addressPlaceholder`)"
                                class="field-bare min-w-0 flex-1"
                            />
                            <Icon v-if="opening" name="spinner" spin class="shrink-0 text-xs text-muted" />
                        </form>
                        <p v-if="openError" class="flex flex-wrap items-center justify-center gap-x-2 text-center text-xs text-danger">
                            {{ openError }}
                            <button type="button" :class="ui.textButton({ flush: true })" @click="openOwn(lastOpen)">{{ t(`ui.action.tryAgain`) }}</button>
                        </p>
                        <p v-else class="max-w-md text-center text-2xs text-muted">
                            {{ opening ? t(`browsers.browsers.starting`) : t(`browsers.browsers.startCaption`) }}
                        </p>
                        <LiveLauncher :groups="startGroups" variant="page" class="mt-2" @pick="launch" />
                    </div>
                </div>

                <!-- A window with every tab closed (an agent's; yours closes with its last tab): the one thing to do in it. -->
                <div v-if="current && pages.length === 0" class="absolute inset-0 z-[1] flex items-center justify-center bg-card">
                    <EmptyState icon="browsers" :title="t(`browsers.browsers.noPagesOpen`)">
                        <template #actions>
                            <Button size="small" @click="openTab">
                                <Icon name="plus" class="text-2xs" />
                                {{ t(`browsers.browsers.newTab`) }}
                            </Button>
                        </template>
                    </EmptyState>
                </div>

                <!-- A blank tab of your own, from the press of + until an address commits in it: the start page's quiet
                     face with nothing to type into but the address bar, which has the keyboard. -->
                <div v-if="current && newTabPage" class="absolute inset-0 z-[1] flex justify-center overflow-y-auto bg-card p-6">
                    <div class="my-auto flex w-full max-w-xl flex-col items-center gap-5">
                        <Icon name="browsers" class="text-3xl text-subtle" />
                        <LiveLauncher v-if="startGroups.length > 0" :groups="startGroups" variant="page" class="mt-2" @pick="launch" />
                    </div>
                </div>

                <!-- Your own window starting from another one: it comes up behind this. A tab added to it once it runs says so on the strip instead. -->
                <div
                    v-if="current && ((opening && ownWindow === undefined) || openError)"
                    class="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3"
                >
                    <div class="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-card px-3.5 py-1.5 text-xs shadow-lg">
                        <template v-if="opening">
                            <Icon name="spinner" spin class="text-2xs text-muted" />
                            <span class="text-content">{{ t(`browsers.browsers.starting`) }}</span>
                        </template>
                        <template v-else>
                            <span class="text-danger">{{ openError }}</span>
                            <button type="button" :class="ui.iconButton()" :aria-label="t(`ui.action.dismiss`)" @click="opener.dismiss()">
                                <Icon name="times" class="text-3xs" />
                            </button>
                        </template>
                    </div>
                </div>

                <!-- While stepped in, the page rings: a keystroke now lands in the agent's way. -->
                <div v-if="steppedIn" class="pointer-events-none absolute inset-0 z-[2] ring-2 ring-inset ring-primary-500" />

                <!-- Said once on a click that went nowhere: the agent has this window, and the way to step in. -->
                <Transition
                    enter-active-class="transition duration-150 ease-out"
                    enter-from-class="-translate-y-1 opacity-0"
                    leave-active-class="transition duration-150 ease-in"
                    leave-to-class="-translate-y-1 opacity-0"
                >
                    <div v-if="watchHint && !interactive" class="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
                        <div class="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-card py-1 pl-3.5 pr-1 shadow-lg">
                            <span class="text-xs text-content">{{ t(`browsers.browsers.watchingOnly`) }}</span>
                            <button type="button" :class="ui.chip({ on: true }, `shrink-0 font-medium`)" @click="takeOver">
                                {{ t(`browsers.browsers.takeOver`) }}
                            </button>
                        </div>
                    </div>
                </Transition>

                <!-- A dialog the page opened, held by the daemon: answered here or by the agent, whichever first. Centred like the browser's own would be. -->
                <div v-if="dialog !== undefined" class="absolute inset-0 z-20 flex items-start justify-center bg-canvas/40 p-6">
                    <div class="flex w-full max-w-md flex-col gap-3 rounded-lg border border-line bg-card p-4 shadow-lg">
                        <div class="text-xs font-medium text-content">
                            {{ dialog.kind === `beforeunload` ? t(`browsers.browsers.leavePage`) : t(`browsers.browsers.pageSays`) }}
                        </div>
                        <div v-if="dialog.kind !== `beforeunload`" class="whitespace-pre-wrap break-words text-xs text-content">
                            {{ dialog.message }}
                        </div>
                        <input
                            v-if="dialog.kind === `prompt`"
                            v-model="dialogText"
                            type="text"
                            class="ui-field-box ui-field-sm w-full"
                            @keydown.enter.prevent="answerDialog(true)"
                            @keydown.esc.prevent="answerDialog(false)"
                        />
                        <div class="flex justify-end gap-2">
                            <Button v-if="dialog.kind !== `alert`" size="small" tier="boring" @click="answerDialog(false)">
                                {{ dialog.kind === `beforeunload` ? t(`browsers.browsers.stay`) : t(`ui.action.cancel`) }}
                            </Button>
                            <Button size="small" @click="answerDialog(true)">
                                {{ dialog.kind === `beforeunload` ? t(`ui.action.leave`) : t(`browsers.browsers.ok`) }}
                            </Button>
                        </div>
                    </div>
                </div>

                <!-- Cards over the picture, not above it; the stack itself takes no pointer events, so the page stays clickable around them. -->
                <div
                    v-if="current?.help !== undefined || queuedHelp.length > 0"
                    class="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2 p-3"
                >
                    <template v-if="current?.help !== undefined">
                        <!-- Folded: still names the waiting agent, covers nothing. -->
                        <button
                            v-if="!helpOpen"
                            type="button"
                            class="ui-chip ui-chip-lg pointer-events-auto border-warning-600/40 bg-card text-content shadow-lg hover:bg-overlay"
                            @click="helpOpen = true"
                        >
                            <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
                            <span class="max-w-80 truncate">{{ current.help.message }}</span>
                            <span class="shrink-0 text-link">{{ t(`ui.action.answer`) }}</span>
                        </button>
                        <div
                            v-else
                            class="pointer-events-auto flex w-full max-w-2xl flex-col gap-2 rounded-lg border border-warning-600/40 bg-card p-3 shadow-lg"
                        >
                            <div class="flex items-start gap-2 text-xs">
                                <Icon name="exclamation-triangle" class="shrink-0 text-sm text-warning" />
                                <!-- Kept on separate lines from the instruction below it: joined, a message ending in a period collides with a clause starting with a colon. -->
                                <div class="min-w-0 flex-1">
                                    <div class="text-xs text-content">
                                        <span class="font-medium">{{ t(`chat.words.agentNeedsHelp`) }}</span>
                                        {{ current.help.message }}
                                    </div>
                                    <div class="text-2xs text-muted">{{ t(`browsers.browsers.fixStepHandBack`) }}</div>
                                </div>
                                <button
                                    type="button"
                                    :class="ui.iconButton()"
                                    :aria-label="t(`browsers.browsers.foldOutWay`)"
                                    v-tooltip.top="t(`browsers.browsers.foldOutWay`)"
                                    @click="helpOpen = false"
                                >
                                    <Icon name="chevron-down" class="text-2xs" />
                                </button>
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <input
                                    v-model="helpNote"
                                    type="text"
                                    :placeholder="t(`chat.words.optionalNoteBackTo`)"
                                    class="ui-field-box ui-field-sm min-w-40 flex-1"
                                    @keydown.enter="resolveHelp(true)"
                                />
                                <Button size="small" class="shrink-0" :loading="replying" @click="() => resolveHelp(true)">
                                    {{ t(`chat.words.doneHandBack`) }}
                                </Button>
                                <Button size="small" tier="boring" class="shrink-0" :disabled="replying" @click="() => resolveHelp(false)">
                                    {{ t(`chat.words.cantHelpNow`) }}
                                </Button>
                            </div>
                            <p v-if="replyError" class="text-2xs text-danger">
                                {{ replyError.title }}<template v-if="replyError.detail"> {{ replyError.detail }}</template>
                            </p>
                        </div>
                    </template>

                    <!-- Expands inline, not in a popover: an anchored panel here would open right over the ask card it's queued behind. -->
                    <div v-if="queuedHelp.length > 0" class="pointer-events-auto flex w-full max-w-2xl flex-col items-center gap-2">
                        <div v-if="queueOpen" class="flex w-full flex-col gap-0.5 rounded-lg border border-line bg-card p-1 shadow-lg">
                            <button
                                v-for="session in queuedHelp"
                                :key="session.name"
                                type="button"
                                class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-content/5"
                                @click="
                                    queueOpen = false;
                                    showWindow(session.name);
                                "
                            >
                                <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate font-medium text-content">{{ windowName(session) }}</span>
                                    <span class="block truncate text-3xs text-muted">{{ session.help?.message }}</span>
                                </span>
                                <span class="shrink-0 text-2xs text-link">{{ t(`browsers.browsers.help`) }}</span>
                            </button>
                        </div>
                        <button
                            type="button"
                            class="ui-chip ui-chip-lg border-line bg-card text-content shadow-lg hover:bg-overlay"
                            :aria-expanded="queueOpen"
                            @click="queueOpen = !queueOpen"
                        >
                            <Icon name="exclamation-triangle" class="shrink-0 text-3xs text-warning" />
                            {{ t(`browsers.browsers.othersWaiting`, { count: queuedHelp.length }, queuedHelp.length) }}
                            <Icon :name="queueOpen ? 'chevron-down' : 'chevron-up'" class="shrink-0 text-3xs text-muted" />
                        </button>
                    </div>
                </div>
            </div>

            <!-- The live apps, each its own frame, kept behind the one in front. -->
            <div v-for="pin in previewPins" v-show="isFront(pin)" :key="tabKey(pin)" class="absolute inset-0">
                <PreviewTab
                    :ref="previewRef(tabKey(pin))"
                    :target="targetOf(pin.id)"
                    :listed="appsRead"
                    :active="live(pin)"
                    :tools-to="toolsEl"
                    :phone="framesPhone(pin) ? phone : undefined"
                    :compact="compact"
                    :actions="previewActions"
                    @open="(id) => showTab({ kind: `preview`, id })"
                    @close="unpinTab(pin)"
                />
            </div>

            <!-- The desktop and the windows on it, each its own stream, paused behind the one in front. -->
            <div v-for="pin in deskPins" v-show="isFront(pin)" :key="tabKey(pin)" class="absolute inset-0">
                <DesktopTab :window="pin.kind === `app` ? pin.id : undefined" :active="live(pin)" :tools-to="toolsEl" @close="unpinTab(pin)" />
            </div>
        </div>
    </div>
</template>
