<script setup lang="ts">
import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/base/errors";
import { AnchoredOverlay, Button, EmptyState, Icon, ui } from "@intentic/ui";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { activePageOf } from "./activePage";
import { toUrl } from "./address";
import BrowserTabStrip from "./BrowserTabStrip.vue";
import { closeBrowser, openBrowser, useBrowsersQuery } from "./browsersQuery";
import type { BrowserCommand } from "./keyIntent";
import Omnibox from "./Omnibox.vue";
import { useBrowserView } from "./useBrowserView";
import { agentTitle, agentTurnRunning } from "./agentTurns";
import BrowserSelectMenu from "../capabilities/connect/BrowserSelectMenu.vue";
import { postTurnControl } from "../chat/run/turnStream";
import { useT } from "@intentic/ui/i18n";

// The browser, as an application of the workspace: full-bleed between the rail and whatever sits beside it, the way a
// maximized browser fills a desktop. It is the person's own to use. Their window (opened here, on the first address they
// type) takes every click and key; an agent's window does too once its turn is over, and only while that agent's turn
// runs is it watched instead, with Take over to step in. The tab strip, the toolbar and the address bar are this
// pane's, steering the page over the view's socket; the picture is the page alone, sized to the box it gets. Closed
// windows are not shown: a browser forgets a window once it's closed.

const t = useT();

const route = useRoute();
const router = useRouter();
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

// The window in front: the one the URL names, else one asking for help, else the person's own, else one an agent is
// busy in, else whichever moved last. None open is the start page.
const selected = computed<string | undefined>(() => {
    const named = typeof route.params[`session`] === `string` ? route.params[`session`] : undefined;
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
const view = useBrowserView(watchable);

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

// The tab beside the selected one, wrapping; what Ctrl+Tab and Ctrl+Shift+Tab pick.
const pickNeighbour = (step: 1 | -1): void => {
    const at = pages.value.findIndex((page) => page.id === activePage.value?.id);
    const next = pages.value[(at + step + pages.value.length) % pages.value.length];
    if (next !== undefined) {
        pickPage(next);
    }
};

// Each window has its own URL, which is why window rows and the queue are links rather than pushing the router;
// Ctrl/Cmd-click then opens a second browser view beside this one.
const sessionAt = (name: string): string => `/browsers/${name}`;

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

// The start page's one tab: not a page anywhere yet, just where the first address will go.
const START_TAB: BrowserPage = { id: `start`, url: ``, active: true };
const stripPages = computed<readonly BrowserPage[]>(() => (current.value === undefined ? [START_TAB] : pages.value));

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

// Yours first, then the agents' by who moved last.
const windowList = computed(() => [
    ...(ownWindow.value === undefined ? [] : [ownWindow.value]),
    ...windows.value.filter((session) => session.own !== true).toSorted((left, right) => right.activityAt - left.activityAt),
]);

// The address bar shows the active page's address until the owner types into it; Enter sends what they typed
// (address.ts decides whether that is an address or a search), Escape puts the page's own back.
const address = computed(() => activePage.value?.url ?? BLANK);
const omnibox = ref<{ focus: () => void } | undefined>();
const focusAddress = (): void => omnibox.value?.focus();

// Opening in the person's own window: the window starts on the first call, and every call answers which tab it opened,
// which goes in front once the list carries it. A blank tab hands the keyboard to the address bar, as a new tab does.
const opening = ref(false);
const openError = ref<string | undefined>();
// What the last open asked for, so Try again asks for it again whichever field it came from.
let lastOpen: string | undefined;
let pendingTab: { readonly name: string; readonly pageId: string; readonly blank: boolean } | undefined;
const openOwn = async (url?: string): Promise<void> => {
    if (opening.value) {
        return;
    }
    lastOpen = url;
    opening.value = true;
    openError.value = undefined;
    try {
        const opened = await openBrowser(url);
        pendingTab = opened.pageId === undefined ? undefined : { name: opened.name, pageId: opened.pageId, blank: url === undefined };
        if (selected.value !== opened.name) {
            await router.push(sessionAt(opened.name));
        }
        takePendingTab();
    } catch (error) {
        openError.value = errorMessage(error);
    } finally {
        opening.value = false;
    }
};
const takePendingTab = (): void => {
    const pending = pendingTab;
    const page = pending === undefined || pending.name !== selected.value ? undefined : pages.value.find((listed) => listed.id === pending.pageId);
    if (pending === undefined || page === undefined) {
        return;
    }
    pendingTab = undefined;
    pickPage(page);
    if (pending.blank) {
        void nextTick(focusAddress);
    }
};
watch(pages, takePendingTab);

// A new tab in an agent's window the person may use goes over that window's own socket; the tab arrives through the
// list like any other, told apart by the ids already open, then picked and handed the address bar. Given up on after
// a while, so a tab that never came can't make one the agent opens later grab the keyboard.
const OPENING_MS = 10_000;
let openingFrom: ReadonlySet<string> | undefined;
let openingTimer: number | undefined;
watch(pages, (listed) => {
    const fresh = openingFrom === undefined ? undefined : listed.find((page) => !openingFrom?.has(page.id));
    if (fresh !== undefined) {
        openingFrom = undefined;
        pickPage(fresh);
        void nextTick(focusAddress);
    }
});

// +, Ctrl+T and the menu's New tab: a tab in this window when it's the person's to use, otherwise one in their own
// window, so a window an agent is busy in never stands between them and the web.
const openTab = (): void => {
    const here = current.value;
    if (here === undefined) {
        focusAddress();
        return;
    }
    if (here.own === true) {
        void openOwn();
        return;
    }
    if (!interactive.value) {
        void openOwn();
        return;
    }
    openingFrom = new Set(pages.value.map((page) => page.id));
    window.clearTimeout(openingTimer);
    openingTimer = window.setTimeout(() => (openingFrom = undefined), OPENING_MS);
    view.newTab();
};

// The address bar's Enter: here when the window is the person's to use; with nothing open, or an agent at the wheel,
// in their own window instead, the way typing into a browser always goes somewhere.
const submitAddress = (text: string): void => {
    const url = toUrl(text);
    if (url === undefined) {
        return;
    }
    if (current.value !== undefined && interactive.value) {
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
    openingFrom = undefined;
    tookOver.value = false;
    helpNote.value = ``;
    helpOpen.value = true;
    watchHint.value = false;
    switcherOpen.value = false;
    menuOpen.value = false;
    queueOpen.value = false;
    takePendingTab();
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
    // Null, not undefined: the stage lives under `v-if="current"`, and Vue writes null into the ref the moment that
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
// search box, the way a new browser window opens ready to type.
const onStart = computed(() => current.value === undefined);
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
    window.clearTimeout(hintTimer);
    window.clearTimeout(openingTimer);
});

// Read off the measured stage, not a viewport breakpoint, since this pane's width has nothing to do with the
// screen's. Only the account's name and the take-over chip's words give way; tabs and address never do.
const compact = computed(() => stageWidth.value > 0 && stageWidth.value < 640);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col overflow-hidden bg-card">
        <!-- The strip: tabs, the +, and at its far end the list of open windows when there is more than one. -->
        <div class="flex shrink-0 items-end bg-canvas pt-1">
            <BrowserTabStrip
                :pages="stripPages"
                :active-id="current === undefined ? START_TAB.id : activePage?.id"
                :closable="current !== undefined && interactive"
                :label="pageLabel"
                @pick="(page) => (current === undefined ? focusAddress() : pickPage(page))"
                @close="closeTab"
                @open="openTab"
            >
                <template #end>
                    <template v-if="windowList.length > 1">
                        <button
                            ref="switcherTrigger"
                            type="button"
                            class="ui-chip mb-1 mr-1.5 shrink-0 self-center px-2 py-1 text-content"
                            :class="switcherOpen ? `ui-chip-on` : ``"
                            aria-haspopup="menu"
                            :aria-expanded="switcherOpen"
                            :aria-label="t(`browsers.browsers.switchWindow`)"
                            v-tooltip.bottom="{
                                title: t(`browsers.browsers.switchWindow`),
                                rows: [{ label: t(`browsers.browsers.openCount`), value: windowList.length }],
                            }"
                            @click="switcherOpen = !switcherOpen"
                        >
                            <!-- Another window is parked on an ask: this is what opens it. -->
                            <Icon v-if="queuedHelp.length > 0" name="exclamation-triangle" class="shrink-0 text-3xs text-warning" />
                            <Icon name="browsers" class="shrink-0 text-2xs" />
                            <span class="tabular-nums">{{ windowList.length }}</span>
                            <Icon name="chevron-down" class="shrink-0 text-3xs text-muted" />
                        </button>
                        <AnchoredOverlay v-model="switcherOpen" :anchor="switcherTrigger" side="bottom" cross="end">
                            <div class="flex w-72 flex-col gap-0.5 p-1">
                                <RouterLink
                                    v-for="session in windowList"
                                    :key="session.name"
                                    :to="sessionAt(session.name)"
                                    class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-content/5"
                                    :class="{ 'bg-primary-600/15': session.name === selected }"
                                    @click="switcherOpen = false"
                                >
                                    <span class="size-1.5 shrink-0 rounded-full" :class="dotOf(session)" />
                                    <span class="min-w-0 flex-1">
                                        <span class="block truncate text-xs" :class="session.name === selected ? 'text-link' : 'text-content'">{{
                                            windowName(session)
                                        }}</span>
                                        <span class="block truncate text-3xs text-muted">{{ windowMeta(session) }}</span>
                                    </span>
                                    <Icon v-if="session.help !== undefined" name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
                                </RouterLink>
                            </div>
                        </AnchoredOverlay>
                    </template>
                </template>
            </BrowserTabStrip>
        </div>

        <!-- The toolbar: history, the address bar that is also the search box, whose browser, and who has the wheel. -->
        <div class="flex h-10 shrink-0 items-center gap-0.5 border-b border-line bg-card px-2">
            <button
                type="button"
                :class="ui.iconButton('h-7 w-7 rounded-full')"
                :disabled="!interactive"
                :aria-label="t(`browsers.browsers.back`)"
                v-tooltip.bottom="t(`browsers.browsers.back`)"
                @click="view.back()"
            >
                <Icon name="arrow-left" class="text-xs" />
            </button>
            <button
                type="button"
                :class="ui.iconButton('h-7 w-7 rounded-full')"
                :disabled="!interactive"
                :aria-label="t(`browsers.browsers.forward`)"
                v-tooltip.bottom="t(`browsers.browsers.forward`)"
                @click="view.forward()"
            >
                <Icon name="arrow-right" class="text-xs" />
            </button>
            <button
                type="button"
                :class="ui.iconButton('h-7 w-7 rounded-full')"
                :disabled="!interactive"
                :aria-label="t(`ui.action.reload`)"
                v-tooltip.bottom="t(`ui.action.reload`)"
                @click="view.reload()"
            >
                <Icon name="refresh" class="text-xs" />
            </button>

            <Omnibox
                ref="omnibox"
                editable
                :value="address === BLANK ? `` : address"
                :placeholder="t(`browsers.browsers.addressPlaceholder`)"
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

            <!-- Only while an agent drives this window: who has it, and the one press to change that. -->
            <template v-if="agentDriving">
                <button
                    v-if="steppedIn"
                    type="button"
                    class="ui-chip ui-chip-on ml-1 shrink-0 px-2.5 py-1 font-medium"
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
                        class="ui-chip ml-1 shrink-0 px-2.5 py-1 font-medium text-content"
                        v-tooltip.bottom="{ title: t(`browsers.browsers.takeOver`), note: t(`browsers.browsers.sendsYourInput`) }"
                        @click="takeOver"
                    >
                        {{ t(`browsers.browsers.takeOver`) }}
                    </button>
                </template>
            </template>

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
                    <!-- From an agent's window to your own: a link when it is open, a start when it isn't. -->
                    <template v-if="current !== undefined && current.own !== true">
                        <RouterLink
                            v-if="ownWindow"
                            :to="sessionAt(ownWindow.name)"
                            class="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                            @click="menuOpen = false"
                        >
                            <Icon name="browsers" class="shrink-0 text-2xs text-muted" />
                            <span class="min-w-0 flex-1 truncate">{{ t(`browsers.browsers.yourBrowser`) }}</span>
                        </RouterLink>
                        <button
                            v-else
                            type="button"
                            class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                            @click="
                                menuOpen = false;
                                openOwn();
                            "
                        >
                            <Icon name="browsers" class="shrink-0 text-2xs text-muted" />
                            <span class="min-w-0 flex-1 truncate">{{ t(`browsers.browsers.yourBrowser`) }}</span>
                        </button>
                    </template>
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
                    <template v-if="current !== undefined">
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
                                <span v-if="current.own !== true" class="block text-3xs text-muted">{{
                                    t(`browsers.browsers.agentsNextBrowserTool`)
                                }}</span>
                            </span>
                        </button>
                    </template>
                </div>
            </AnchoredOverlay>
        </div>

        <!-- The page: whatever the stage's box is, the daemon sizes the viewport to it. -->
        <div class="relative min-h-0 flex-1" :class="current ? 'bg-terminal' : 'bg-card'">
            <div
                v-if="current"
                ref="stageEl"
                tabindex="0"
                class="absolute inset-0 flex select-none items-center justify-center outline-none"
                :style="view.kind.value === 'video' ? { cursor: interactive ? view.cursor.value : 'default' } : undefined"
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
                    :style="interactive ? { cursor: view.cursor.value } : undefined"
                    alt=""
                    draggable="false"
                    class="h-full w-full object-contain"
                />
                <div v-if="view.status.value" class="absolute inset-0 flex items-center justify-center px-4">
                    <span class="rounded-md bg-card px-2 py-1 text-center text-xs text-muted">{{ view.status.value }}</span>
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

            <!-- Nothing open: a new tab's page, whose search box (like the address bar above it) starts the person's own window. -->
            <div v-else class="absolute inset-0 flex items-center justify-center overflow-y-auto p-6">
                <div class="flex w-full max-w-xl flex-col items-center gap-5">
                    <Icon name="browsers" class="text-3xl text-subtle" />
                    <form class="ui-field-shell flex h-11 w-full items-center gap-3 rounded-full px-4" @submit.prevent="submitStart">
                        <Icon name="search" class="shrink-0 text-xs text-subtle" />
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
                        <button type="button" :class="ui.linkButton('my-0 min-h-0')" @click="openOwn(lastOpen)">{{ t(`ui.action.tryAgain`) }}</button>
                    </p>
                    <p v-else class="max-w-md text-center text-2xs text-muted">
                        {{ opening ? t(`browsers.browsers.starting`) : t(`browsers.browsers.startCaption`) }}
                    </p>
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

            <!-- Opening in your own window from another one: the window comes up behind this. -->
            <div v-if="current && (opening || openError)" class="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
                <div class="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-card px-3.5 py-1.5 text-xs shadow-lg">
                    <template v-if="opening">
                        <Icon name="spinner" spin class="text-2xs text-muted" />
                        <span class="text-content">{{ t(`browsers.browsers.starting`) }}</span>
                    </template>
                    <template v-else>
                        <span class="text-danger">{{ openError }}</span>
                        <button type="button" :class="ui.iconButton()" :aria-label="t(`ui.action.dismiss`)" @click="openError = undefined">
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
                        <button type="button" class="ui-chip ui-chip-on shrink-0 px-2.5 py-1 font-medium" @click="takeOver">
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
                                <span class="block truncate font-medium text-content">{{ windowName(session) }}</span>
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
</template>
