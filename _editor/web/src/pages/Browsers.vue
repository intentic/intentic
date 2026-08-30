<script setup lang="ts">
import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract";
import { Button, AnchoredOverlay, CopyButton, Icon, ui, vAction } from "@intentic/ui";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { activePageOf } from "../composables/browser/activePage";
import { closeBrowser, useBrowsersQuery } from "../composables/browser/browsersQuery";
import { useBrowserView } from "../composables/browser/useBrowserView";
import BrowserSelectMenu from "../components/BrowserSelectMenu.vue";
import { relativeTime } from "../composables/chat/catalog";
import { postTurnControl } from "../composables/chat/turnStream";

/* THE AGENT'S BROWSER, AS A BROWSER. A live view of the Chromium a turn is driving through its
 * @playwright/mcp tools, with the pages it has open as a tab strip, because the agent's browser IS a browser,
 * and the shape a person already knows how to read is the shape it should be shown in.
 *
 * It is a route rather than a pane in the terminal panel, which is the whole point of the surface: a browser
 * holds several pages at once, and a strip that can only show one stream has no way to ask which. The rail tile
 * appears when a turn starts browsing (ShellDesktop's browserTile) and this is where it lands.
 *
 * ONE ROW OF CHROME, AND IT IS THE WIDTH OF THE PICTURE. This used to be three stacked strips (session pills,
 * page tabs, address line), each with its own border, plus two more when an agent was parked asking for hands:
 * five full-width bands over a shrinking picture, in an app that already spends two bars on its own chrome and
 * sits inside the reader's real browser, which spends two more. So the questions those bands answered are
 * folded into one line: WHICH BROWSER is a chip with a menu behind it (the pills only ever mattered when
 * several existed, and a menu says "several exist" in the width of a caret), WHICH PAGE keeps the tab strip it
 * has earned, and WHERE IT IS rides the same line as an address rather than a band of its own.
 *
 * THE ROWS WERE ALSO WHAT PUT BLACK DOWN BOTH SIDES. The remote picture has a fixed shape whatever this pane's
 * shape is — the browser's whole window when it is grabbed off an X display, one page's surface when it is not
 * (live-view.ts) — and the leftover is a letterbox. Every band removed gives its height back to the picture, and a taller picture is a WIDER one:
 * dropping four of the five bands is most of the gutter gone. What is left is not painted black across the
 * whole pane any more: the chrome and the picture are sized together into one window that sits on the app's
 * canvas, so the space around it reads as the matting of a window rather than as a stream that failed to fill.
 *
 * ASKS RIDE THE PICTURE. The agent parking on `request_help` used to raise a band above the stage, and every
 * OTHER parked browser a second one, so the moment the view had something urgent to say was the moment the
 * thing it was saying it about got smallest. They are cards over the bottom of the picture now: nearer what
 * they are asking about, collapsible when they cover it, and costing the stage nothing when there is no ask.
 *
 * A FINISHED BROWSER IS A RECORD, NOT A BROKEN ONE. The daemon keeps a session listable for a couple of hours
 * after its Chromium goes away, and switches its strip from the tabs it had OPEN to every tab it ever had:
 * which is the answer to the only question left about a browser that has stopped. So the window's body becomes
 * that record rather than a socket dialling something that isn't there. */

const route = useRoute();
const { sessions } = useBrowsersQuery();

// The session in the URL, so a reload (or a shared link) reopens the same browser. Falls back to a browser
// asking for help before the first listed: someone landing here unaddressed almost certainly came for the
// banner (the rail badge, the push, the chat card all point at it), and the plain fallback is live-first.
const selected = computed<string | undefined>(() => {
    const named = typeof route.params[`session`] === `string` ? route.params[`session`] : undefined;
    if (named !== undefined && sessions.value.some((session) => session.name === named)) {
        return named;
    }
    return (sessions.value.find((session) => session.help !== undefined) ?? sessions.value[0])?.name;
});
const current = computed(() => sessions.value.find((session) => session.name === selected.value));

/* ONLY A RUNNING BROWSER IS DIALLED. A finished one is kept listable for a couple of hours because its tab list
 * is the record of where the agent went, but there is no Chromium behind it, so opening a socket could only ask
 * a dead question and get an error chip over a black rectangle back. Passing undefined here is what turns the
 * body into that record instead: the composable tears its socket down and stops trying. */
const watchable = computed(() => (current.value?.running === true ? current.value.name : undefined));
const view = useBrowserView(watchable);

// The page the user picked. Cleared whenever the browser changes: a page id is only meaningful inside its own
// session, and carrying one across would bind to a stranger.
const pickedPage = ref<string | undefined>();

// Which tab reads as selected: see activePageOf for the rule.
const activePage = computed<BrowserPage | undefined>(() => activePageOf(current.value?.pages ?? [], pickedPage.value));

const pickPage = (page: BrowserPage): void => {
    pickedPage.value = page.id;
    view.bindPage(page.id);
};

// Each browser is a URL of its own: that is how a reload, a chat card and the rail all reach one, so the
// switcher's rows and the queue's are links rather than buttons that pushed the router. Ctrl/⌘-click then
// opens a second browser beside the one on screen, which is exactly what a list of them invites.
const sessionAt = (name: string): string => `/browsers/${name}`;

// A tab's text: the page's own title, else its host, else the raw url, the same ladder the daemon uses for the
// session label, so a tab and the chip above it never disagree about what a page is called.
const hostOf = (url: string): string => {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};
const pageLabel = (page: BrowserPage): string => page.title ?? hostOf(page.url);

/* WHOSE BROWSER THIS IS, which the view never used to say out loud. `web` is the credential-free one: anything
 * else is a capability's own profile, signed in as the owner, and that is the single most important thing to
 * know in the seconds before taking the wheel and typing into a page. Undefined for the throwaway browser,
 * where there is no account to name and a chip saying "none" would be furniture. */
const CREDENTIAL_FREE = `web`;
const accountOf = (session: BrowserSession | undefined): string | undefined =>
    session === undefined || session.server === CREDENTIAL_FREE ? undefined : session.server;

// Liveness as one dot, the switcher's whole shorthand: a browser asking for help outranks "running", because
// that is the one the reader came to find.
const dotOf = (session: BrowserSession): string => (session.help !== undefined ? `bg-warning` : session.running ? `bg-success` : `bg-line-strong`);

// The second line of a switcher row: who it is signed in as, and whether it is still open. The account is
// named only when there IS one: "no account" on every row of a list where most browsers are credential-free
// is noise standing where the exception should be.
const sessionMeta = (session: BrowserSession): string =>
    [
        accountOf(session),
        session.running
            ? `${session.pages.length} ${session.pages.length === 1 ? `page` : `pages`}`
            : `closed${session.finishedAt === undefined ? `` : ` ${relativeTime(session.finishedAt)}`}`,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);

/* THE ADDRESS, SPLIT WHERE IT MATTERS. The host is what says which site this is and it is never truncated; the
 * path is context and gives way first. Both are on one line with the tabs now, so the whole thing is also a
 * tooltip and a copy button: nothing about the address is only readable by widening the window. */
const address = computed(() => activePage.value?.url ?? `about:blank`);
const addressParts = computed<{ host: string; rest: string; secure: boolean | undefined }>(() => {
    try {
        const url = new URL(address.value);
        if (url.host === ``) {
            // about:blank, and anything else without an authority: there is no site to vouch for.
            return { host: address.value, rest: ``, secure: undefined };
        }
        return { host: url.host, rest: `${url.pathname === `/` ? `` : url.pathname}${url.search}${url.hash}`, secure: url.protocol === `https:` };
    } catch {
        return { host: address.value, rest: ``, secure: undefined };
    }
});

/* THE ELEMENT THE PICTURE IS IN, whichever picture it is. There are two: a canvas the video is decoded into,
 * and an <img> for the frames a browser with no display to grab falls back to. Pointer coordinates are measured
 * against whichever is painting (viewportCoords), so it has to be that element rather than the stage around it,
 * which is a different shape whenever the two aspect ratios disagree. Both carry `object-contain`, so one
 * geometry rule covers them. */
const frameEl = ref<HTMLElement | undefined>();
const canvasEl = ref<HTMLCanvasElement | undefined>();
const stageEl = ref<HTMLElement | undefined>();
// Whichever of the two is currently painting. Every pointer handler measures against this, so neither kind of
// picture needs its own copy of the geometry.
const pictureEl = computed<HTMLElement | undefined>(() => canvasEl.value ?? frameEl.value);
// The canvas mounts and unmounts with the picture kind; the decoder outlives it, so they are connected here.
watch(canvasEl, (canvas) => view.attachCanvas(canvas));

/* WATCHING AND DRIVING ARE TWO STATES, AND THE BUTTON HAS TO NAME THE ONE IT IS IN. It used to read "Take
 * control" while watching and "Watching only" while driving: an action on one side and a state on the other,
 * so the reader had to work out which of the two it was being told. Driving now says both ("You're driving"
 * and how to stop), in the app's accent, and the window it applies to wears a ring while it lasts, because a
 * keystroke going somewhere unexpected is the one mistake this surface can actually make.
 *
 * Escape is deliberately NOT a way out: keyIntent forwards it to the page (a modal the agent opened is closed
 * with it), and a shortcut that steals it would break the very thing the wheel was taken for. */
const takeControl = (): void => {
    view.driving.value = !view.driving.value;
    if (view.driving.value) {
        stageEl.value?.focus();
    }
};

const close = (name: string): void => void closeBrowser(name);

/* THE HELP REQUEST'S ANSWERING END. The agent parked its turn on `request_help` and the daemon flagged this
 * session; the card over the picture renders that flag, and its two buttons settle the parked card over the
 * same /agent/reply side channel the chat's cards use. The card comes down when the daemon publishes the
 * cleared flag: the same push that raised it, so nothing here mutates the list. `helpNote` rides back to the
 * agent either way ("typed the password, don't touch remember-me"). */
const helpNote = ref(``);
// The ask is a card ON the picture, so it can cover the field it is asking about: this folds it to a chip
// without answering it, which is the one thing a banner in a band never needed and a card always does.
const helpOpen = ref(true);

/* THE QUEUE OF ASKS. One browser's request renders as the card over its own picture, but the agent can be
 * stuck in several browsers at once (two identities mid-signup, each on its own captcha), and the switcher's
 * warning dot is one click away rather than in front of the reader. So every OTHER browser waiting for hands
 * counts on a chip beside that card, one click from its own stage. The selected browser's own ask stays out of
 * it: that one is the card right above. */
const queuedHelp = computed(() => sessions.value.filter((session) => session.help !== undefined && session.name !== selected.value));

const switcherOpen = ref(false);
const switcherTrigger = ref<HTMLElement | undefined>();
const moreOpen = ref(false);
const moreTrigger = ref<HTMLElement | undefined>();
const queueOpen = ref(false);

// Everything that was about the browser being left behind goes with it: a pinned page id, a half-typed note,
// and any menu hanging off a chip that is about to describe something else.
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
    await postTurnControl(`/agent/reply`, { kind: `browser_help`, requestId: help.requestId, helped, ...(note === `` ? {} : { note }) });
    helpNote.value = ``;
    // Handing back while still driving would leave the owner's keystrokes racing the agent's next move.
    if (helped) {
        view.driving.value = false;
    }
};

/* THE WINDOW IS SIZED, NOT STRETCHED. The picture's shape is decided at the far end, so the only question is
 * how big a rectangle of that shape fits in what is left after the chrome, and the answer is the width of
 * BOTH: a chrome bar wider than the picture under it is the thing that made the old strips read as app
 * furniture rather than as this browser's own.
 *
 * THE SHAPE IS NO LONGER A CONSTANT, which is why this reads it off the view. There are two pictures now and
 * they are not the same rectangle: video grabbed off the browser's own X display is the WHOLE WINDOW, chrome
 * included (1280x880), while the CDP frames a display-less browser falls back to are the page alone
 * (1280x800). The daemon says which in its `ready`, so the numbers arrive a moment after the socket does and
 * this recomputes — which is the point, since sizing a window to the wrong rectangle is a letterbox down two
 * sides, the very thing the measuring below exists to remove.
 *
 * Measured rather than derived in CSS: an `aspect-ratio` box can size its width off a definite height, but the
 * height here is "whatever is left after a bar whose own height moves with the reader's text scale", and one
 * observer answering both is less machinery than the layout gymnastics that avoids it. The matte's CONTENT box
 * is what the window has to fit inside (its padding is the matting), and the chrome's BORDER box is what it
 * costs, hence the two different reads below. */
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

// Full width until the first measurement lands: one frame of a too-tall window, clipped by the matte, beats a
// frame of nothing at all.
const windowWidth = computed<string>(() => {
    const { width, height } = matte.value;
    if (width === 0 || height === 0) {
        return `100%`;
    }
    const room = Math.max(0, height - chromeHeight.value);
    return `${Math.floor(Math.min(width, (room * view.viewWidth.value) / view.viewHeight.value))}px`;
});

/* WHEN THE ROW HAS TO GIVE SOMETHING UP. Read off the measured window rather than a viewport breakpoint: this
 * pane is as wide as whatever is left after the icon rail and a docked chat, so a `sm:` class here would keep a
 * chip on a 500px window because the SCREEN behind it is 1600. What goes first is the account chip and the
 * long form of the wheel's label; the tabs and the address never do, they are the row's two questions. */
const compact = computed(() => matte.value.width > 0 && matte.value.width < 640);

/* THE SELECTED TAB IS ALWAYS THE ONE YOU CAN SEE. The strip scrolls, and in a narrow window the agent moving to
 * a new page would otherwise select a tab off the right-hand end: a strip showing three tabs, none of them the
 * one being watched. Nothing to clean up on unmount, `scrollIntoView` is a one-shot. */
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
        <!-- Nothing has browsed yet. Not an error: most turns never open a browser, so this reads as a
             description of the surface rather than as something having gone wrong. -->
        <div v-if="sessions.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <Icon name="globe" class="text-2xl text-muted" />
            <div class="text-sm text-content">No browsers open</div>
            <div class="max-w-sm text-xs text-muted">
                When an agent opens a page with its browser tools, it appears here: live, with every page it has open as a tab.
            </div>
        </div>

        <!-- THE MATTE: the canvas the window sits on, and what the window is measured against. -->
        <div v-else ref="matteEl" class="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
            <div
                class="flex max-h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card shadow-lg transition-colors"
                :class="view.driving.value ? 'border-primary-600 ring-1 ring-primary-600' : 'border-line'"
                :style="{ width: windowWidth }"
            >
                <!-- THE ONE ROW OF CHROME: which browser, which page, where it is, and the wheel. -->
                <div ref="chromeEl" class="flex shrink-0 items-center gap-1 border-b border-line px-1.5 py-1">
                    <!-- WHICH BROWSER. A chip rather than a row of pills: with one browser open it is a label,
                         and with six it is the same label plus a caret, instead of a band that grows a
                         horizontal scrollbar. -->
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
                        <!-- The warning rides the chip when a browser OTHER than this one is parked: the queue
                             chip below says how many, but the switcher is what opens them. -->
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

                    <!-- WHOSE IT IS. Only for a signed-in profile: see accountOf. The switcher's rows carry
                         the same fact, which is where it stays when the row is too narrow to spend on it. -->
                    <span
                        v-if="accountOf(current) && !compact"
                        class="flex shrink-0 items-center gap-1 rounded-md bg-overlay px-1.5 py-0.5 text-3xs text-muted"
                        v-tooltip.bottom="`This browser is signed in as the ${accountOf(current)} account`"
                    >
                        <Icon name="user" class="text-3xs" />
                        <span class="max-w-24 truncate">{{ accountOf(current) }}</span>
                    </span>

                    <span class="h-4 w-px shrink-0 bg-line"></span>

                    <!-- WHICH PAGE. The agent's own tab strip, in the shape a person already reads. Capped at
                         half the row: the address beside it has to stay legible with eight tabs open. -->
                    <div ref="stripEl" class="tabstrip flex min-w-0 max-w-[50%] flex-1 items-center gap-0.5 overflow-x-auto">
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

                    <!-- WHERE IT IS. The host carries the padlock and never truncates; the path gives way. -->
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
                        <!-- No tooltip of its own: the address line above it already carries one, and a
                             tooltipped control inside a tooltipped box opens a second box on the first. -->
                        <CopyButton
                            :text="address"
                            class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label="Copy this address"
                        />
                    </div>

                    <!-- THE WHEEL, and what happens to it when the browser is gone. -->
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
                        <span v-if="view.driving.value" class="size-1.5 animate-pulse rounded-full bg-white"></span>
                        <template v-if="view.driving.value">{{ compact ? "Driving" : "You're driving · hand back" }}</template>
                        <template v-else>{{ compact ? "Control" : "Take control" }}</template>
                    </button>
                    <span v-else class="shrink-0 whitespace-nowrap px-1 text-2xs text-muted">
                        Closed{{ current?.finishedAt === undefined ? "" : ` ${relativeTime(current.finishedAt)}` }}
                    </span>

                    <!-- Everything that is not watching or driving. Closing a browser lives here rather than
                         beside the wheel: it ends work the agent is mid-way through, and a destructive verb
                         does not belong one pixel from the control people click every visit. -->
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

                <!-- THE BODY: exactly the remote viewport's shape, so the picture fills it and the chrome above
                     is the picture's own width. It keeps that shape with nothing to show, so switching between
                     a live browser and a closed one doesn't resize the window under the pointer.

                     The terminal surface (dark in BOTH modes) is for the PICTURE, which is a photograph of
                     someone else's screen and belongs on a dark mat. A closed browser has no photograph: it is
                     a note, and a note on a black slab reads as a stream that failed rather than as a record. -->
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
                        <!-- VIDEO: the whole browser window, decoded from H.264 grabbed off its own X display,
                             so the cursor, an open <select>, the autofill drop-down and the file picker are all
                             IN the picture. Nothing here draws a pointer — the one you see is the X server's
                             own, at the place the owner moved it, in the shape Chromium gave it, so
                             `cursor-none` hides the local arrow rather than showing two half a frame apart. -->
                        <canvas
                            v-if="view.kind.value === 'video'"
                            ref="canvasEl"
                            class="h-full w-full object-contain"
                            :class="view.driving.value ? 'cursor-none' : ''"
                        />
                        <!-- FRAMES: one page's compositor surface, which is all a browser with no display to
                             grab can offer. No cursor in it, so the shape the remote page would have shown is
                             reported separately and worn by the operator's own pointer — and only while
                             driving, since an arrow is the honest shape over a picture you are just watching. -->
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
                        <!-- An open drop-down the picture cannot show, which is only ever the FRAMES path: on
                             video the native menu is on the display, so it is photographed and clickable, and
                             the daemon never sends one of these. See BrowserSelectMenu. -->
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

                    <!-- A browser that has closed. Not a failed stream: there is nothing to stream, so it reads
                         as the record it is, and the strip above it (which lists every tab a finished session
                         ever had, not just the ones open at the end) is the actual content. -->
                    <div v-else class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
                        <Icon name="globe" class="text-2xl text-muted" />
                        <div class="text-sm text-content">This browser has closed</div>
                        <div class="max-w-sm text-xs text-muted">
                            <template v-if="current?.finishedAt !== undefined">Closed {{ relativeTime(current.finishedAt) }}. </template>
                            Every page it opened is still in the strip above, with the one it ended on selected: the record of where the agent went.
                        </div>
                    </div>

                    <!-- THE ASKS, over the picture rather than above it. The stack takes no pointer events of
                         its own, so the page underneath stays clickable everywhere the cards are not. -->
                    <div
                        v-if="current?.help !== undefined || queuedHelp.length > 0"
                        class="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2 p-3"
                    >
                        <template v-if="current?.help !== undefined">
                            <!-- Folded: still says an agent is waiting, covers nothing. -->
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
                                    <!-- The agent's own words first, then what to do about them on a line of
                                         their own: run together they used to collide into "…I can't do. :
                                         take control", since a message ending in a full stop is the norm and
                                         a clause starting with a colon cannot follow one. -->
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
                                        class="min-w-40 flex-1 rounded border border-line bg-canvas px-2 py-1 text-xs text-content placeholder:text-subtle"
                                        @keydown.enter="resolveHelp(true)"
                                    />
                                    <Button size="small" class="shrink-0" @click="() => resolveHelp(true)"> Done: hand back </Button>
                                    <Button size="small" severity="secondary" class="shrink-0" @click="() => resolveHelp(false)">
                                        Can't help now
                                    </Button>
                                </div>
                            </div>
                        </template>

                        <!-- Other browsers waiting for hands: a count, not a list, until it is asked for.
                             Expanded INLINE rather than in a popover: the chip is already at the bottom of the
                             stage with the ask card right above it, so an anchored panel had nowhere to open
                             except over that card, hiding the very buttons it was queued behind. The list
                             grows the stack upward instead, which is the one direction that covers nothing. -->
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

<style scoped>
/* The tab strip scrolls without drawing a bar: it rides a bar barely taller than a line of text, where a
   platform scrollbar is a second horizontal rule under the tabs and eats a third of the row's height. The
   workspace's file tabs suppress it the same way (FileTabs' .ftabs-scroll), and for the same reason. */
.tabstrip {
    scrollbar-width: none;
}
.tabstrip::-webkit-scrollbar {
    display: none;
}
</style>
