<script setup lang="ts">
import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract";
import { AnchoredOverlay, Button, EmptyState, Icon, timeAgo, ui } from "@intentic/ui";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { activePageOf } from "./activePage";
import { toUrl } from "./address";
import BrowserTabStrip from "./BrowserTabStrip.vue";
import { closeBrowser, useBrowsersQuery } from "./browsersQuery";
import type { BrowserCommand } from "./keyIntent";
import Omnibox from "./Omnibox.vue";
import { useBrowserView } from "./useBrowserView";
import BrowserSelectMenu from "../capabilities/connect/BrowserSelectMenu.vue";
import { postTurnControl } from "../chat/run/turnStream";
import { useT } from "@intentic/ui/i18n";

// Live view of the agent's Chromium (@playwright/mcp), drawn as a browser application of its own: the view is the
// app's window, full-bleed between the rail and whatever sits beside it, the way a maximized browser fills a desktop.
// The tab strip, the toolbar and the address bar are this pane's, fed by the session and steering the page over the
// view's socket; the picture is the page alone, sized to the box it gets. A route, not a terminal pane, since a browser
// holds several pages and one stream can't show which; asks are cards over the picture, and a finished session keeps
// its tab list as a record rather than dialling a dead socket.

const t = useT();

const route = useRoute();
const { sessions } = useBrowsersQuery();

// The session in the URL, so reload or a shared link reopens it. Falls back to a browser asking for help, else the
// first listed.
const selected = computed<string | undefined>(() => {
    const named = typeof route.params[`session`] === `string` ? route.params[`session`] : undefined;
    if (named !== undefined && sessions.value.some((session) => session.name === named)) {
        return named;
    }
    return (sessions.value.find((session) => session.help !== undefined) ?? sessions.value[0])?.name;
});
const current = computed(() => sessions.value.find((session) => session.name === selected.value));
const running = computed(() => current.value?.running === true);
const pages = computed<readonly BrowserPage[]>(() => current.value?.pages ?? []);

// Only a running browser is dialled; a finished one keeps its tab list as a record, but there's no Chromium behind
// it. Undefined here tears the socket down instead of erroring.
const watchable = computed(() => (running.value ? current.value?.name : undefined));
const view = useBrowserView(watchable);

// The page the user picked; cleared on browser change, since a page id only means something inside its own session.
const pickedPage = ref<string | undefined>();

// Which tab reads as selected: see activePageOf for the rule.
const activePage = computed<BrowserPage | undefined>(() => activePageOf(pages.value, pickedPage.value));

const pickPage = (page: BrowserPage): void => {
    pickedPage.value = page.id;
    view.bindPage(page.id);
};

// The tab beside the selected one, wrapping; what Ctrl+Tab and Ctrl+Shift+Tab pick.
const pickNeighbour = (step: 1 | -1): void => {
    const at = pages.value.findIndex((page) => page.id === activePage.value?.id);
    const next = pages.value[(at + step + pages.value.length) % pages.value.length];
    if (next !== undefined) {
        pickPage(next);
    }
};

// Each browser has its own URL, which is why window rows and the queue are links rather than pushing the router;
// Ctrl/Cmd-click then opens a second browser beside this one.
const sessionAt = (name: string): string => `/browsers/${name}`;

// A tab's text: title, else host, else raw url, the same ladder the daemon uses for the session label, so a tab
// and its window row never disagree. A page with none of them is a fresh tab, and says so.
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

// Whose browser this is: `web` is credential-free, anything else is a capability's own signed-in profile. Undefined
// for the credential-free case, where there's no account to name.
const CREDENTIAL_FREE = `web`;
const accountOf = (session: BrowserSession | undefined): string | undefined =>
    session === undefined || session.server === CREDENTIAL_FREE ? undefined : session.server;
const account = computed(() => accountOf(current.value));

// One dot of liveness; a browser asking for help outranks "running", since that's the one the reader came to find.
const dotOf = (session: BrowserSession): string => (session.help !== undefined ? `bg-warning` : session.running ? `bg-success` : `bg-line-strong`);

// Second line of a window row: account (only when there is one) and its tabs or when it closed; naming "no account"
// on every credential-free row would be noise.
const sessionMeta = (session: BrowserSession): string =>
    [
        accountOf(session),
        session.running
            ? t(`browsers.browsers.pageCount`, { count: session.pages.length }, session.pages.length)
            : session.finishedAt === undefined
              ? t(`browsers.browsers.closedState`)
              : t(`browsers.browsers.closedStateWhen`, { when: timeAgo(session.finishedAt, { days: true }) }),
    ]
        .filter((part) => part !== undefined)
        .join(` · `);

// The window menu, split the way a browser's own history is: what is open, then what closed a moment ago. A group
// with nothing in it has no heading either.
const openCount = computed(() => sessions.value.filter((session) => session.running).length);
const windowGroups = computed(() =>
    [
        { key: `open`, heading: t(`browsers.browsers.openWindows`), sessions: sessions.value.filter((session) => session.running) },
        { key: `closed`, heading: t(`browsers.browsers.recentlyClosed`), sessions: sessions.value.filter((session) => !session.running) },
    ].filter((group) => group.sessions.length > 0),
);

// The address bar shows the active page's address until the owner types into it; Enter sends what they typed
// (address.ts decides whether that is an address or a search), Escape puts the page's own back.
const address = computed(() => activePage.value?.url ?? BLANK);
const omnibox = ref<{ focus: () => void } | undefined>();
const focusAddress = (): void => omnibox.value?.focus();
const submitAddress = (text: string): void => {
    const url = toUrl(text);
    if (url !== undefined) {
        view.navigate(url);
        stageEl.value?.focus();
    }
};

// A new tab is picked and handed the address bar the moment it shows up in the list, the way pressing + in any
// browser leaves you typing into a blank page. The ids already open when + was pressed tell the new one apart; the
// daemon opens it, so it arrives through the list like every other tab.
// Given up on after a while, so a tab the daemon never opened can't make one the agent opens later grab the keyboard.
const OPENING_MS = 10_000;
let openingFrom: ReadonlySet<string> | undefined;
let openingTimer: number | undefined;
const openTab = (): void => {
    openingFrom = new Set(pages.value.map((page) => page.id));
    window.clearTimeout(openingTimer);
    openingTimer = window.setTimeout(() => (openingFrom = undefined), OPENING_MS);
    view.newTab();
};
watch(pages, (listed) => {
    const fresh = openingFrom === undefined ? undefined : listed.find((page) => !openingFrom?.has(page.id));
    if (fresh !== undefined) {
        openingFrom = undefined;
        pickPage(fresh);
        void nextTick(focusAddress);
    }
});

// Closing the tab in front puts its neighbour in front (the one after it, else the one before), as a browser does,
// rather than jumping to wherever the agent last was.
const closeTab = (page: BrowserPage): void => {
    if (page.id === activePage.value?.id) {
        const at = pages.value.findIndex((listed) => listed.id === page.id);
        const neighbour = pages.value[at + 1] ?? pages.value[at - 1];
        if (neighbour !== undefined) {
            pickPage(neighbour);
        }
    }
    view.closeTab(page.id);
};

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

// The button names the state it's in ("You're driving · hand back", not an action-only label); the page rings while
// driving, since a stray keystroke is the one real mistake here. Escape is not an exit, keyIntent forwards it to the
// page.
const takeControl = (): void => {
    view.driving.value = !view.driving.value;
    watchHint.value = false;
    if (view.driving.value) {
        stageEl.value?.focus();
    }
};

// A click on the page while only watching does nothing, which a browser never does; so it says why, once, and offers
// the wheel right where the click landed. Gone by itself, since the click was most likely just a look.
const HINT_MS = 3500;
const watchHint = ref(false);
let hintTimer: number | undefined;
const onStageDown = (event: MouseEvent): void => {
    if (view.driving.value) {
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
const helpNote = ref(``);
// A card on the picture folds to a chip without answering it, so it can stop covering what it's asking about.
const helpOpen = ref(true);

// Other browsers waiting for hands surface as a chip beside the current ask, since the agent can be stuck in
// several at once; the selected browser's own ask is the card above, not counted here.
const queuedHelp = computed(() => sessions.value.filter((session) => session.help !== undefined && session.name !== selected.value));

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

// Everything tied to the browser being left behind (picked page, a tab on its way, draft note, open menus) resets
// with it.
watch(selected, () => {
    pickedPage.value = undefined;
    openingFrom = undefined;
    helpNote.value = ``;
    helpOpen.value = true;
    watchHint.value = false;
    switcherOpen.value = false;
    menuOpen.value = false;
    queueOpen.value = false;
});

const replying = ref(false);
const resolveHelp = async (helped: boolean): Promise<void> => {
    const help = current.value?.help;
    // The ask is cleared by the daemon, not locally, so until the reply lands `help` still reads as open.
    if (help === undefined || replying.value) {
        return;
    }
    replying.value = true;
    const note = helpNote.value.trim();
    // undefined targets this box: a browser session belongs to the machine it runs on, and this view only lists the
    // active sandbox's (see postTurnControl).
    try {
        await postTurnControl(undefined, `reply`, {
            kind: `browser_help`,
            requestId: help.requestId,
            helped,
            ...(note === `` ? {} : { note }),
        });
        helpNote.value = ``;
        // Handing back while still driving would race the owner's keystrokes against the agent's next move.
        if (helped) {
            view.driving.value = false;
        }
    } finally {
        replying.value = false;
    }
};

// The stage's box is what the daemon sizes the page's viewport to, so the picture is the page at 1:1 rather than
// scaled into whatever is left; measured via ResizeObserver, since the chrome's own text-scaled height is part of
// what's left.
const stageWidth = ref(0);
let observer: ResizeObserver | undefined;
watch(stageEl, (stage) => {
    observer?.disconnect();
    observer = undefined;
    // Null, not undefined: the stage lives under `v-if="running"`, and Vue writes null into the ref the moment that
    // element goes. `observe(null)` throws where the picture stops rather than where it is read.
    if (stage === null) {
        return;
    }
    observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
            stageWidth.value = entry.contentRect.width;
            view.requestSize(entry.contentRect.width, entry.contentRect.height);
        }
    });
    observer.observe(stage);
});
onBeforeUnmount(() => {
    observer?.disconnect();
    window.clearTimeout(hintTimer);
    window.clearTimeout(openingTimer);
});

// Read off the measured stage, not a viewport breakpoint, since this pane's width has nothing to do with the
// screen's. Only the account's name and the wheel's long label give way; tabs and address never do.
const compact = computed(() => stageWidth.value > 0 && stageWidth.value < 640);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- Not an error: most turns never open a browser. -->
        <EmptyState
            v-if="sessions.length === 0"
            icon="browsers"
            :title="t(`browsers.browsers.noBrowsersOpen`)"
            :line="t(`browsers.browsers.agentOpensPageBrowser`)"
            class="flex-1"
        />

        <!-- The app's window, maximized: no frame of its own, the view's edges are the browser's. -->
        <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
            <!-- The strip: which window, and its tabs. -->
            <div class="flex shrink-0 items-end bg-canvas pt-1">
                <!-- Only with a second window to go to; one browser has nothing to switch between. -->
                <template v-if="sessions.length > 1">
                    <button
                        ref="switcherTrigger"
                        type="button"
                        class="ui-chip mb-1 ml-1.5 shrink-0 self-center px-2 py-1 text-content"
                        :class="switcherOpen ? `ui-chip-on` : ``"
                        aria-haspopup="menu"
                        :aria-expanded="switcherOpen"
                        :aria-label="t(`browsers.browsers.switchWindow`)"
                        v-tooltip.bottom="{
                            title: t(`browsers.browsers.switchWindow`),
                            rows: [{ label: t(`browsers.browsers.openCount`), value: openCount }],
                        }"
                        @click="switcherOpen = !switcherOpen"
                    >
                        <Icon name="browsers" class="shrink-0 text-2xs" />
                        <span class="tabular-nums">{{ sessions.length }}</span>
                        <!-- Another window is parked on an ask: this is what opens it. -->
                        <Icon v-if="queuedHelp.length > 0" name="exclamation-triangle" class="shrink-0 text-3xs text-warning" />
                        <Icon name="chevron-down" class="shrink-0 text-3xs text-muted" />
                    </button>
                    <AnchoredOverlay v-model="switcherOpen" :anchor="switcherTrigger" side="bottom" cross="start">
                        <div class="flex w-72 flex-col gap-0.5 p-1">
                            <template v-for="group in windowGroups" :key="group.key">
                                <div :class="ui.sectionLabelSm('px-2 pb-0.5 pt-1.5')">{{ group.heading }}</div>
                                <RouterLink
                                    v-for="session in group.sessions"
                                    :key="session.name"
                                    :to="sessionAt(session.name)"
                                    class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-content/5"
                                    :class="{ 'bg-primary-600/15': session.name === selected }"
                                    @click="switcherOpen = false"
                                >
                                    <span class="size-1.5 shrink-0 rounded-full" :class="dotOf(session)" />
                                    <span class="min-w-0 flex-1">
                                        <span class="block truncate text-xs" :class="session.name === selected ? 'text-link' : 'text-content'">{{
                                            session.label
                                        }}</span>
                                        <span class="block truncate text-3xs text-muted">{{ sessionMeta(session) }}</span>
                                    </span>
                                    <Icon v-if="session.help !== undefined" name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
                                </RouterLink>
                            </template>
                        </div>
                    </AnchoredOverlay>
                </template>

                <BrowserTabStrip
                    :pages="pages"
                    :active-id="activePage?.id"
                    :running="running"
                    :label="pageLabel"
                    @pick="pickPage"
                    @close="closeTab"
                    @open="openTab"
                />
            </div>

            <!-- The toolbar: history, the address bar that is also the search box, whose browser, and the wheel. -->
            <div class="flex h-10 shrink-0 items-center gap-0.5 border-b border-line bg-card px-2">
                <button
                    type="button"
                    :class="ui.iconButton('h-7 w-7 rounded-full')"
                    :disabled="!running"
                    :aria-label="t(`browsers.browsers.back`)"
                    v-tooltip.bottom="t(`browsers.browsers.back`)"
                    @click="view.back()"
                >
                    <Icon name="arrow-left" class="text-xs" />
                </button>
                <button
                    type="button"
                    :class="ui.iconButton('h-7 w-7 rounded-full')"
                    :disabled="!running"
                    :aria-label="t(`browsers.browsers.forward`)"
                    v-tooltip.bottom="t(`browsers.browsers.forward`)"
                    @click="view.forward()"
                >
                    <Icon name="arrow-right" class="text-xs" />
                </button>
                <button
                    type="button"
                    :class="ui.iconButton('h-7 w-7 rounded-full')"
                    :disabled="!running"
                    :aria-label="t(`ui.action.reload`)"
                    v-tooltip.bottom="t(`ui.action.reload`)"
                    @click="view.reload()"
                >
                    <Icon name="refresh" class="text-xs" />
                </button>

                <Omnibox
                    ref="omnibox"
                    :editable="running"
                    :value="address === BLANK ? `` : address"
                    :placeholder="running ? t(`browsers.browsers.addressPlaceholder`) : ``"
                    :copy-label="t(`browsers.browsers.copyAddress`)"
                    :secure-label="t(`browsers.browsers.connectionSecure`)"
                    :insecure-label="t(`browsers.browsers.connectionNotSecure`)"
                    class="mx-1.5 flex-1"
                    @submit="submitAddress"
                    @cancel="stageEl?.focus()"
                />

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

                <!-- The wheel, and what stands in its place once the browser is gone. -->
                <button
                    v-if="running"
                    type="button"
                    class="ui-chip ml-1 shrink-0 px-2.5 py-1 font-medium"
                    :class="view.driving.value ? `ui-chip-on` : `text-content`"
                    v-tooltip.bottom="
                        view.driving.value
                            ? { title: t(`browsers.browsers.handBack`), note: t(`browsers.browsers.stopsYourInput`) }
                            : { title: t(`browsers.browsers.takeControl`), note: t(`browsers.browsers.sendsYourInput`) }
                    "
                    @click="takeControl"
                >
                    <span v-if="view.driving.value" class="size-1.5 rounded-full bg-primary-500"></span>
                    <template v-if="view.driving.value">{{
                        compact ? t(`browsers.browsers.driving`) : t(`browsers.browsers.youreDrivingHandBack`)
                    }}</template>
                    <template v-else>{{ compact ? t(`browsers.browsers.control`) : t(`browsers.browsers.takeControl`) }}</template>
                </button>
                <span v-else class="ml-1 shrink-0 whitespace-nowrap px-1 text-2xs text-muted">{{
                    current?.finishedAt === undefined
                        ? t(`browsers.browsers.closed`)
                        : t(`browsers.browsers.closedWhen`, { when: timeAgo(current.finishedAt, { days: true }) })
                }}</span>

                <!-- The browser's own menu: the rare verbs, kept off the toolbar. -->
                <button
                    ref="menuTrigger"
                    type="button"
                    :class="ui.iconButton('h-7 w-7 rounded-full', menuOpen ? 'bg-overlay text-content' : '')"
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
                            v-if="running"
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
                        <a
                            v-if="address !== BLANK"
                            :href="address"
                            target="_blank"
                            rel="noreferrer"
                            class="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                            @click="menuOpen = false"
                        >
                            <Icon name="arrow-up-right" class="shrink-0 text-2xs text-muted" />
                            <span class="min-w-0 flex-1 truncate">{{ t(`browsers.browsers.openAddressYourself`) }}</span>
                        </a>
                        <template v-if="current?.running">
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
                                    <span class="block text-3xs text-muted">{{ t(`browsers.browsers.agentsNextBrowserTool`) }}</span>
                                </span>
                            </button>
                        </template>
                    </div>
                </AnchoredOverlay>
            </div>

            <!-- The page: whatever the stage's box is, the daemon sizes the viewport to it. -->
            <div class="relative min-h-0 flex-1" :class="running ? 'bg-terminal' : 'bg-card'">
                <div
                    v-if="running"
                    ref="stageEl"
                    tabindex="0"
                    class="absolute inset-0 flex select-none items-center justify-center outline-none"
                    :style="view.kind.value === 'video' ? { cursor: view.driving.value ? view.cursor.value : 'default' } : undefined"
                    @mousemove="pictureEl && view.onMouseMove($event, pictureEl)"
                    @mousedown="onStageDown"
                    @mouseup="pictureEl && view.onMouseUp($event, pictureEl)"
                    @wheel="pictureEl && view.onWheel($event, pictureEl)"
                    @keydown="view.onKeyDown($event, onCommand)"
                    @paste="view.onPaste"
                    @contextmenu.prevent
                >
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
                        :style="view.driving.value ? { cursor: view.cursor.value } : undefined"
                        alt=""
                        draggable="false"
                        class="h-full w-full object-contain"
                    />
                    <div v-if="view.status.value" class="absolute inset-0 flex items-center justify-center px-4">
                        <span class="rounded-md bg-card px-2 py-1 text-center text-xs text-muted">{{ view.status.value }}</span>
                    </div>
                    <!-- An open drop-down the picture itself can't show; only happens on the frames path, since a native menu on video is already photographed and clickable. -->
                    <BrowserSelectMenu
                        v-if="view.select.value && view.driving.value"
                        :menu="view.select.value"
                        :frame="pictureEl"
                        :view-width="view.viewWidth.value"
                        :view-height="view.viewHeight.value"
                        @pick="view.chooseOption"
                        @close="view.closeSelect"
                    />
                </div>

                <!-- Every tab closed, the browser still up: a blank window with the one thing to do in it. -->
                <div v-if="running && pages.length === 0" class="absolute inset-0 z-[1] flex items-center justify-center bg-card">
                    <EmptyState icon="browsers" :title="t(`browsers.browsers.noPagesOpen`)">
                        <template #actions>
                            <Button size="small" @click="openTab">
                                <Icon name="plus" class="text-2xs" />
                                {{ t(`browsers.browsers.newTab`) }}
                            </Button>
                        </template>
                    </EmptyState>
                </div>

                <!-- Recorded browser sessions have no live stream. -->
                <EmptyState v-if="!running" icon="browsers" :title="t(`browsers.browsers.browserClosed`)" class="absolute inset-0">
                    <template #line>
                        <template v-if="current?.finishedAt !== undefined"
                            >{{ t(`browsers.browsers.closedWhen`, { when: timeAgo(current.finishedAt, { days: true }) }) }}.
                        </template>
                        {{ t(`browsers.browsers.everyPageOpenedStill`) }}
                    </template>
                </EmptyState>

                <!-- While driving, the page rings: a keystroke now lands in it, not in the agent's way. -->
                <div v-if="running && view.driving.value" class="pointer-events-none absolute inset-0 z-[2] ring-2 ring-inset ring-primary-500" />

                <!-- Said once on a click that went nowhere: watching, not driving, and the way to start. -->
                <Transition
                    enter-active-class="transition duration-150 ease-out"
                    enter-from-class="-translate-y-1 opacity-0"
                    leave-active-class="transition duration-150 ease-in"
                    leave-to-class="-translate-y-1 opacity-0"
                >
                    <div
                        v-if="watchHint && running && !view.driving.value"
                        class="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3"
                    >
                        <div class="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-card py-1 pl-3.5 pr-1 shadow-lg">
                            <span class="text-xs text-content">{{ t(`browsers.browsers.watchingOnly`) }}</span>
                            <button type="button" class="ui-chip ui-chip-on shrink-0 px-2.5 py-1 font-medium" @click="takeControl">
                                {{ t(`browsers.browsers.takeControl`) }}
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
                            <Button v-if="dialog.kind !== `alert`" size="small" severity="secondary" @click="answerDialog(false)">
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
                            class="ui-chip pointer-events-auto gap-2 border-warning-600/40 bg-card px-3 py-1.5 text-xs text-content shadow-lg hover:bg-overlay"
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
                            <div class="flex items-start gap-2">
                                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-sm text-warning" />
                                <!-- Kept on separate lines from the instruction below it: joined, a message ending in a period collides with a clause starting with a colon. -->
                                <div class="min-w-0 flex-1">
                                    <div class="text-xs text-content">
                                        <span class="font-medium">{{ t(`chat.words.agentNeedsHelp`) }}</span>
                                        {{ current.help.message }}
                                    </div>
                                    <div class="text-2xs text-muted">{{ t(`browsers.browsers.takeControlFixStep`) }}</div>
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
                                <Button size="small" class="shrink-0" @click="() => resolveHelp(true)">
                                    {{ t(`chat.words.doneHandBack`) }}
                                </Button>
                                <Button size="small" severity="secondary" class="shrink-0" @click="() => resolveHelp(false)">
                                    {{ t(`chat.words.cantHelpNow`) }}
                                </Button>
                            </div>
                        </div>
                    </template>

                    <!-- Expands inline, not in a popover: an anchored panel here would open right over the ask card it's queued behind. -->
                    <div v-if="queuedHelp.length > 0" class="pointer-events-auto flex w-full max-w-2xl flex-col items-center gap-2">
                        <div v-if="queueOpen" class="flex w-full flex-col gap-0.5 rounded-lg border border-line bg-card p-1 shadow-lg">
                            <RouterLink
                                v-for="session in queuedHelp"
                                :key="session.name"
                                :to="sessionAt(session.name)"
                                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-content/5"
                                @click="queueOpen = false"
                            >
                                <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate font-medium text-content">{{ session.label }}</span>
                                    <span class="block truncate text-3xs text-muted">{{ session.help?.message }}</span>
                                </span>
                                <span class="shrink-0 text-2xs text-link">{{ t(`browsers.browsers.help`) }}</span>
                            </RouterLink>
                        </div>
                        <button
                            type="button"
                            class="ui-chip gap-2 border-line bg-card px-3 py-1 text-content shadow-lg hover:bg-overlay"
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
        </div>
    </div>
</template>
