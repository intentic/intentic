<script setup lang="ts">
import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract";
import { Button, AnchoredOverlay, CopyButton, Icon, ui, vAction } from "@intentic/ui";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { activePageOf } from "./activePage";
import { closeBrowser, useBrowsersQuery } from "./browsersQuery";
import { useBrowserView } from "./useBrowserView";
import BrowserSelectMenu from "../capabilities/connect/BrowserSelectMenu.vue";
import { relativeTime } from "../chat/models/catalog";
import { postTurnControl } from "../chat/run/turnStream";

// Live view of the agent's Chromium (@playwright/mcp) with open pages as a tab strip; a route, not a terminal pane,
// since a browser holds several pages and one stream can't show which. One line of chrome (browser chip, tabs,
// address) leaves the rest of the height to the picture; asks are cards over it, and a finished session keeps its
// tab list as a record rather than dialling a dead socket.

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

// Only a running browser is dialled; a finished one keeps its tab list as a record, but there's no Chromium behind
// it. Undefined here tears the socket down instead of erroring.
const watchable = computed(() => (current.value?.running === true ? current.value.name : undefined));
const view = useBrowserView(watchable);

// The page the user picked; cleared on browser change, since a page id only means something inside its own session.
const pickedPage = ref<string | undefined>();

// Which tab reads as selected: see activePageOf for the rule.
const activePage = computed<BrowserPage | undefined>(() => activePageOf(current.value?.pages ?? [], pickedPage.value));

const pickPage = (page: BrowserPage): void => {
    pickedPage.value = page.id;
    view.bindPage(page.id);
};

// Each browser has its own URL, which is why switcher rows and the queue are links rather than pushing the router;
// Ctrl/Cmd-click then opens a second browser beside this one.
const sessionAt = (name: string): string => `/browsers/${name}`;

// A tab's text: title, else host, else raw url, the same ladder the daemon uses for the session label, so a tab
// and its chip never disagree.
const hostOf = (url: string): string => {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};
const pageLabel = (page: BrowserPage): string => page.title ?? hostOf(page.url);

// Whose browser this is: `web` is credential-free, anything else is a capability's own signed-in profile. Undefined
// for the credential-free case, where there's no account to name.
const CREDENTIAL_FREE = `web`;
const accountOf = (session: BrowserSession | undefined): string | undefined =>
    session === undefined || session.server === CREDENTIAL_FREE ? undefined : session.server;

// One dot of liveness; a browser asking for help outranks "running", since that's the one the reader came to find.
const dotOf = (session: BrowserSession): string => (session.help !== undefined ? `bg-warning` : session.running ? `bg-success` : `bg-line-strong`);

// Second line of a switcher row: account (only when there is one) and open/closed state; naming "no account" on
// every credential-free row would be noise.
const sessionMeta = (session: BrowserSession): string =>
    [
        accountOf(session),
        session.running
            ? `${session.pages.length} ${session.pages.length === 1 ? `page` : `pages`}`
            : `closed${session.finishedAt === undefined ? `` : ` ${relativeTime(session.finishedAt)}`}`,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);

// The host (never truncated, names the site) and the path (gives way first) share one line with the tabs, so the
// address doubles as its own tooltip and copy target.
const address = computed(() => activePage.value?.url ?? `about:blank`);
const addressParts = computed<{ host: string; rest: string; secure: boolean | undefined }>(() => {
    try {
        const url = new URL(address.value);
        if (url.host === ``) {
            // about:blank, or anything else without an authority: no site to vouch for.
            return { host: address.value, rest: ``, secure: undefined };
        }
        return { host: url.host, rest: `${url.pathname === `/` ? `` : url.pathname}${url.search}${url.hash}`, secure: url.protocol === `https:` };
    } catch {
        return { host: address.value, rest: ``, secure: undefined };
    }
});

// Two picture elements: canvas for decoded video, img for frames when there's no display to grab. Pointer
// coordinates measure against whichever is painting (viewportCoords), not the stage around it; both use
// `object-contain`.
const frameEl = ref<HTMLElement | undefined>();
const canvasEl = ref<HTMLCanvasElement | undefined>();
const stageEl = ref<HTMLElement | undefined>();
// Whichever of the two is painting; every pointer handler measures against this instead of its own copy.
const pictureEl = computed<HTMLElement | undefined>(() => canvasEl.value ?? frameEl.value);
// The canvas mounts/unmounts with the picture kind; the decoder outlives it, so they're connected here.
watch(canvasEl, (canvas) => view.attachCanvas(canvas));

// The button names the state it's in ("You're driving · hand back", not an action-only label); the window rings
// while driving, since a stray keystroke is the one real mistake here. Escape is not an exit, keyIntent forwards
// it to the page.
const takeControl = (): void => {
    view.driving.value = !view.driving.value;
    if (view.driving.value) {
        stageEl.value?.focus();
    }
};

const close = (name: string): void => void closeBrowser(name);

// The card renders the daemon's `help` flag and answers over the same /agent/reply channel the chat cards use; it
// closes when the daemon clears the flag, not from any local mutation. `helpNote` goes back to the agent either way.
const helpNote = ref(``);
// A card on the picture folds to a chip without answering it, so it can stop covering what it's asking about.
const helpOpen = ref(true);

// Other browsers waiting for hands surface as a chip beside the current ask, since the agent can be stuck in
// several at once; the selected browser's own ask is the card above, not counted here.
const queuedHelp = computed(() => sessions.value.filter((session) => session.help !== undefined && session.name !== selected.value));

const switcherOpen = ref(false);
const switcherTrigger = ref<HTMLElement | undefined>();
const moreOpen = ref(false);
const moreTrigger = ref<HTMLElement | undefined>();
const queueOpen = ref(false);

// Everything tied to the browser being left behind (picked page, draft note, open menus) resets with it.
watch(selected, () => {
    pickedPage.value = undefined;
    helpNote.value = ``;
    helpOpen.value = true;
    switcherOpen.value = false;
    moreOpen.value = false;
    queueOpen.value = false;
});

const resolveHelp = async (helped: boolean): Promise<void> => {
    const help = current.value?.help;
    if (help === undefined) {
        return;
    }
    const note = helpNote.value.trim();
    // undefined targets this box: a browser session belongs to the machine it runs on, and this view only lists the
    // active sandbox's (see postTurnControl).
    await postTurnControl(undefined, `/agent/reply`, { kind: `browser_help`, requestId: help.requestId, helped, ...(note === `` ? {} : { note }) });
    helpNote.value = ``;
    // Handing back while still driving would race the owner's keystrokes against the agent's next move.
    if (helped) {
        view.driving.value = false;
    }
};

// The window is sized to fit the matte, matching the video's actual shape, which differs by capture mode (an
// X-display grab is the whole window at 1280x880; CDP frames are the page alone at 1280x800) and arrives with the
// daemon's `ready`. Measured via ResizeObserver rather than CSS `aspect-ratio`, since the available height depends
// on the chrome bar's own text-scaled height.
const matteEl = ref<HTMLElement | undefined>();
const chromeEl = ref<HTMLElement | undefined>();
const matte = ref<{ width: number; height: number }>({ width: 0, height: 0 });
const chromeHeight = ref(0);
let observer: ResizeObserver | undefined;

watch([matteEl, chromeEl], ([matteNow, chromeNow]) => {
    observer?.disconnect();
    observer = undefined;
    if (matteNow === undefined) {
        return;
    }
    observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
            if (entry.target === matteEl.value) {
                matte.value = { width: entry.contentRect.width, height: entry.contentRect.height };
            } else {
                chromeHeight.value = (entry.target as HTMLElement).offsetHeight;
            }
        }
    });
    observer.observe(matteNow);
    if (chromeNow !== undefined) {
        observer.observe(chromeNow);
    }
});
onBeforeUnmount(() => observer?.disconnect());

// Full width until the first measurement lands: a too-tall frame clipped by the matte beats showing nothing.
const windowWidth = computed<string>(() => {
    const { width, height } = matte.value;
    if (width === 0 || height === 0) {
        return `100%`;
    }
    const room = Math.max(0, height - chromeHeight.value);
    return `${Math.floor(Math.min(width, (room * view.viewWidth.value) / view.viewHeight.value))}px`;
});

// Read off the measured window, not a viewport breakpoint, since this pane's width has nothing to do with the
// screen's. Only the account chip and the wheel's long label give way; tabs and address never do.
const compact = computed(() => matte.value.width > 0 && matte.value.width < 640);

// Keeps the selected tab scrolled into view, so a narrow strip can't leave the active page off-screen when the
// agent switches pages. `scrollIntoView` is one-shot; nothing to clean up.
const stripEl = ref<HTMLElement | undefined>();
watch(
    () => activePage.value?.id,
    async () => {
        await nextTick();
        stripEl.value?.querySelector(`[data-selected="true"]`)?.scrollIntoView({ block: `nearest`, inline: `nearest` });
    },
    { immediate: true },
);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- Not an error: most turns never open a browser. -->
        <div v-if="sessions.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <Icon name="globe" class="text-2xl text-muted" />
            <div class="text-sm text-content">No browsers open</div>
            <div class="max-w-sm text-xs text-muted">
                When an agent opens a page with its browser tools, it appears here: live, with every page it has open as a tab.
            </div>
        </div>

        <!-- The canvas the window sits on and is measured against. -->
        <div v-else ref="matteEl" class="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
            <div
                class="flex max-h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card shadow-lg transition-colors"
                :class="view.driving.value ? 'border-primary-600 ring-1 ring-primary-600' : 'border-line'"
                :style="{ width: windowWidth }"
            >
                <!-- Which browser, which page, where it is, and the wheel. -->
                <div ref="chromeEl" class="flex shrink-0 items-center gap-1 border-b border-line px-1.5 py-1">
                    <!--
                        A chip instead of a row of pills: with several browsers it's a label plus caret rather than a
                        band with its own
                        scrollbar.
                    -->
                    <button
                        ref="switcherTrigger"
                        type="button"
                        class="ui-chip shrink-0 rounded-md px-1.5 py-1 text-content"
                        :class="switcherOpen ? `ui-chip-on` : ``"
                        :aria-haspopup="sessions.length > 1 ? 'menu' : undefined"
                        :aria-expanded="sessions.length > 1 ? switcherOpen : undefined"
                        :disabled="sessions.length < 2"
                        v-tooltip.bottom="sessions.length > 1 ? `Switch browser: ${sessions.length} open` : current?.name"
                        @click="switcherOpen = !switcherOpen"
                    >
                        <span v-if="current" class="size-1.5 shrink-0 rounded-full" :class="dotOf(current)" />
                        <span class="max-w-32 truncate">{{ current?.label }}</span>
                        <!--
                            Rides here when a browser other than this one is parked; the queue chip below says how
                            many, this is what opens
                            them.
                        -->
                        <Icon v-if="queuedHelp.length > 0" name="exclamation-triangle" class="shrink-0 text-3xs text-warning" />
                        <Icon v-if="sessions.length > 1" name="chevron-down" class="shrink-0 text-3xs text-muted" />
                    </button>
                    <AnchoredOverlay v-model="switcherOpen" :anchor="switcherTrigger" side="bottom" cross="start">
                        <div class="flex w-72 flex-col gap-0.5 p-1">
                            <RouterLink
                                v-for="session in sessions"
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
                        </div>
                    </AnchoredOverlay>

                    <!--
                        Only for a signed-in profile (see accountOf); the switcher's rows carry the same fact when this
                        is too narrow
                        for it.
                    -->
                    <span
                        v-if="accountOf(current) && !compact"
                        class="flex shrink-0 items-center gap-1 rounded-md bg-overlay px-1.5 py-0.5 text-3xs text-muted"
                        v-tooltip.bottom="`This browser is signed in as the ${accountOf(current)} account`"
                    >
                        <Icon name="user" class="text-3xs" />
                        <span class="max-w-24 truncate">{{ accountOf(current) }}</span>
                    </span>

                    <span class="h-4 w-px shrink-0 bg-line"></span>

                    <!--
                        The agent's own tab strip; capped at half the row so the address stays legible with many tabs
                        open.
                    -->
                    <div ref="stripEl" class="scrollbar-none flex min-w-0 max-w-[50%] flex-1 items-center gap-0.5 overflow-x-auto">
                        <button
                            v-for="page in current?.pages ?? []"
                            :key="page.id"
                            type="button"
                            :data-selected="page.id === activePage?.id"
                            class="ui-chip min-w-0 shrink-0 rounded-md px-1.5 py-1"
                            :class="page.id === activePage?.id ? `ui-chip-on` : ``"
                            v-tooltip.bottom="page.url"
                            @click="pickPage(page)"
                        >
                            <Icon name="globe" class="shrink-0 text-3xs" />
                            <span class="max-w-40 truncate">{{ pageLabel(page) }}</span>
                        </button>
                        <span v-if="(current?.pages.length ?? 0) === 0" class="px-1 text-2xs text-muted">No pages open</span>
                    </div>

                    <span class="h-4 w-px shrink-0 bg-line"></span>

                    <!-- The host carries the padlock and never truncates; the path gives way first. -->
                    <div class="group flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-0.5" v-tooltip.bottom="address">
                        <Icon
                            v-if="addressParts.secure !== undefined"
                            :name="addressParts.secure ? 'lock' : 'unlock'"
                            class="shrink-0 text-3xs"
                            :class="addressParts.secure ? 'text-muted' : 'text-warning'"
                        />
                        <span class="min-w-0 truncate font-mono text-2xs">
                            <span class="text-content">{{ addressParts.host }}</span
                            ><span class="text-muted">{{ addressParts.rest }}</span>
                        </span>
                        <!--
                            No tooltip of its own: the address line above already has one, and nesting tooltips would
                            open a second box on
                            the first.
                        -->
                        <CopyButton
                            :text="address"
                            class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label="Copy this address"
                        />
                    </div>

                    <!-- The wheel, and what happens to it when the browser is gone. -->
                    <button
                        v-if="current?.running"
                        type="button"
                        class="ui-chip shrink-0 px-2 py-1 font-medium"
                        :class="view.driving.value ? `ui-chip-on` : ``"
                        v-tooltip.bottom="
                            view.driving.value
                                ? 'Stop sending your clicks and keystrokes to the agent\'s browser'
                                : 'Send your clicks and keystrokes to the agent\'s browser'
                        "
                        @click="takeControl"
                    >
                        <span v-if="view.driving.value" class="size-1.5 rounded-full bg-white"></span>
                        <template v-if="view.driving.value">{{ compact ? "Driving" : "You're driving · hand back" }}</template>
                        <template v-else>{{ compact ? "Control" : "Take control" }}</template>
                    </button>
                    <span v-else class="shrink-0 whitespace-nowrap px-1 text-2xs text-muted">
                        Closed{{ current?.finishedAt === undefined ? "" : ` ${relativeTime(current.finishedAt)}` }}
                    </span>

                    <!--
                        Everything besides watching/driving; closing lives here, not beside the wheel, since it ends
                        the agent's work
                        and shouldn't sit next to an everyday control.
                    -->
                    <button
                        ref="moreTrigger"
                        type="button"
                        :class="ui.iconButton(moreOpen ? 'bg-overlay text-content' : '')"
                        aria-haspopup="menu"
                        :aria-expanded="moreOpen"
                        aria-label="More"
                        @click="moreOpen = !moreOpen"
                    >
                        <Icon name="ellipsis" class="text-2xs" />
                    </button>
                    <AnchoredOverlay v-model="moreOpen" :anchor="moreTrigger" side="bottom" cross="end">
                        <div class="flex w-56 flex-col gap-0.5 p-1">
                            <a
                                :href="address"
                                target="_blank"
                                rel="noreferrer"
                                class="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                                @click="moreOpen = false"
                            >
                                <Icon name="arrow-up-right" class="shrink-0 text-2xs text-muted" />
                                <span class="min-w-0 flex-1 truncate">Open this address yourself</span>
                            </a>
                            <button
                                v-if="current?.running"
                                type="button"
                                class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-danger-600/10 hover:text-danger"
                                @click="
                                    moreOpen = false;
                                    close(current.name);
                                "
                            >
                                <Icon name="trash" class="shrink-0 text-2xs text-muted" />
                                <span class="min-w-0 flex-1">
                                    <span class="block">Close this browser</span>
                                    <span class="block text-3xs text-muted">The agent's next browser tool call will fail</span>
                                </span>
                            </button>
                        </div>
                    </AnchoredOverlay>
                </div>

                <!--
                    Exactly the remote viewport's shape, so switching between a live and closed browser doesn't resize
                    the window
                    under the pointer. The dark terminal surface is for the photograph; a closed browser has no
                    photograph, just a
                    note.
                -->
                <div
                    class="relative min-h-0 w-full"
                    :class="current?.running ? 'bg-terminal' : ''"
                    :style="{ aspectRatio: `${view.viewWidth.value} / ${view.viewHeight.value}` }"
                >
                    <div
                        v-if="current?.running"
                        ref="stageEl"
                        tabindex="0"
                        class="absolute inset-0 flex select-none items-center justify-center outline-none"
                        @mousemove="pictureEl && view.onMouseMove($event, pictureEl)"
                        @mousedown="pictureEl && view.onMouseDown($event, pictureEl)"
                        @mouseup="pictureEl && view.onMouseUp($event, pictureEl)"
                        @wheel="pictureEl && view.onWheel($event, pictureEl)"
                        @keydown="view.onKeyDown"
                        @paste="view.onPaste"
                        @contextmenu.prevent
                    >
                        <!--
                            The whole browser window, decoded off its own X display, so selects/autofill/file-pickers
                            are all in the
                            picture. No pointer is drawn here; `cursor-none` just hides the local arrow so it doesn't
                            sit next to the X
                            server's own.
                        -->
                        <canvas
                            v-if="view.kind.value === 'video'"
                            ref="canvasEl"
                            class="h-full w-full object-contain"
                            :class="view.driving.value ? 'cursor-none' : ''"
                        />
                        <!--
                            One page's compositor surface, all a display-less browser can offer; no cursor in it, so
                            the operator's own
                            pointer wears the remote shape, only while driving.
                        -->
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
                        <!--
                            An open drop-down the picture itself can't show; only happens on the frames path, since a
                            native menu on video
                            is already photographed and clickable. See BrowserSelectMenu.
                        -->
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

                    <!--
                        Not a failed stream, there's nothing to stream: this reads as the record it is, and the strip
                        above (every tab
                        the session ever had) is the real content.
                    -->
                    <div v-else class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
                        <Icon name="globe" class="text-2xl text-muted" />
                        <div class="text-sm text-content">This browser has closed</div>
                        <div class="max-w-sm text-xs text-muted">
                            <template v-if="current?.finishedAt !== undefined">Closed {{ relativeTime(current.finishedAt) }}. </template>
                            Every page it opened is still in the strip above, with the one it ended on selected: the record of where the agent went.
                        </div>
                    </div>

                    <!--
                        Cards over the picture, not above it; the stack itself takes no pointer events, so the page
                        stays clickable
                        around them.
                    -->
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
                                <span class="shrink-0 text-link">Answer</span>
                            </button>
                            <div
                                v-else
                                class="pointer-events-auto flex w-full max-w-2xl flex-col gap-2 rounded-lg border border-warning-600/40 bg-card p-3 shadow-lg"
                            >
                                <div class="flex items-start gap-2">
                                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-sm text-warning" />
                                    <!--
                                        Kept on separate lines from the instruction below it: joined, a message ending
                                        in a period collides with a
                                        clause starting with a colon.
                                    -->
                                    <div class="min-w-0 flex-1">
                                        <div class="text-xs text-content">
                                            <span class="font-medium">The agent needs your help:</span>
                                            {{ current.help.message }}
                                        </div>
                                        <div class="text-2xs text-muted">Take control, fix that step, then hand back.</div>
                                    </div>
                                    <button
                                        type="button"
                                        :class="ui.iconButton()"
                                        aria-label="Fold this out of the way"
                                        v-tooltip.top="`Fold this out of the way`"
                                        @click="helpOpen = false"
                                    >
                                        <Icon name="chevron-down" class="text-2xs" />
                                    </button>
                                </div>
                                <div class="flex flex-wrap items-center gap-2">
                                    <input
                                        v-model="helpNote"
                                        type="text"
                                        placeholder="Optional note back to the agent"
                                        class="ui-field-box ui-field-sm min-w-40 flex-1"
                                        @keydown.enter="resolveHelp(true)"
                                    />
                                    <Button size="small" class="shrink-0" @click="() => resolveHelp(true)"> Done: hand back </Button>
                                    <Button size="small" severity="secondary" class="shrink-0" @click="() => resolveHelp(false)">
                                        Can't help now
                                    </Button>
                                </div>
                            </div>
                        </template>

                        <!--
                            Expands inline, not in a popover: an anchored panel here would open right over the ask card
                            it's queued behind.
                            Growing the stack upward is the one direction that covers nothing.
                        -->
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
                                    <span class="shrink-0 text-2xs text-link">Help →</span>
                                </RouterLink>
                            </div>
                            <button
                                type="button"
                                class="ui-chip gap-2 border-line bg-card px-3 py-1 text-content shadow-lg hover:bg-overlay"
                                :aria-expanded="queueOpen"
                                @click="queueOpen = !queueOpen"
                            >
                                <Icon name="exclamation-triangle" class="shrink-0 text-3xs text-warning" />
                                {{ queuedHelp.length }} other {{ queuedHelp.length === 1 ? "browser" : "browsers" }} waiting for you
                                <Icon :name="queueOpen ? 'chevron-down' : 'chevron-up'" class="shrink-0 text-3xs text-muted" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

