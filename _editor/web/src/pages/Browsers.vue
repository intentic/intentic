<script setup lang="ts">
import type { BrowserPage } from "@intentic/sandbox-contract";
import { Icon } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { activePageOf } from "../composables/browser/activePage";
import { closeBrowser, useBrowsersQuery } from "../composables/browser/browsersQuery";
import { useBrowserView } from "../composables/browser/useBrowserView";
import { relativeTime } from "../composables/chat/catalog";
import { postTurnControl } from "../composables/chat/turnStream";

/* THE AGENT'S BROWSER, AS A BROWSER. A live screencast of the Chromium a turn is driving through its
 * @playwright/mcp tools, with the pages it has open as a tab strip across the top — because the agent's browser
 * IS a browser, and the shape a person already knows how to read is the shape it should be shown in.
 *
 * It is a route rather than a pane in the terminal panel, which is the whole point of the surface: a browser
 * holds several pages at once, and a strip that can only show one stream has no way to ask which. The rail tile
 * appears when a turn starts browsing (ShellDesktop's browserTile) and this is where it lands.
 *
 * TWO STRIPS, TWO QUESTIONS. The session pills answer "which browser?" — there is one per conversation that has
 * browsed, and they only render when more than one exists, since a row of one pill is furniture. The page tabs
 * answer "which page?" and are always there while a browser has any.
 *
 * A FINISHED BROWSER IS A RECORD, NOT A BROKEN ONE. The daemon keeps a session listable for a couple of hours
 * after its Chromium goes away, and switches its strip from the tabs it had OPEN to every tab it ever had —
 * which is the answer to the only question left about a browser that has stopped. So the stage below becomes
 * that record rather than a socket dialling something that isn't there. */

const route = useRoute();
const router = useRouter();
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
 * is the record of where the agent went — but there is no Chromium behind it, so opening a socket could only ask
 * a dead question and get an error chip over a black rectangle back. Passing undefined here is what turns the
 * stage into that record instead: the composable tears its socket down and stops trying. */
const watchable = computed(() => (current.value?.running === true ? current.value.name : undefined));
const view = useBrowserView(watchable);

// The page the user picked. Cleared whenever the browser changes — a page id is only meaningful inside its own
// session, and carrying one across would bind to a stranger.
const pickedPage = ref<string | undefined>();
watch(selected, () => (pickedPage.value = undefined));

// Which tab reads as selected — see activePageOf for the rule.
const activePage = computed<BrowserPage | undefined>(() => activePageOf(current.value?.pages ?? [], pickedPage.value));

const pickPage = (page: BrowserPage): void => {
    pickedPage.value = page.id;
    view.bindPage(page.id);
};

const selectSession = (name: string): void => void router.push(`/browsers/${name}`);

// A tab's text: the page's own title, else its host, else the raw url — the same ladder the daemon uses for the
// session label, so a tab and its pill never disagree about what a page is called.
const hostOf = (url: string): string => {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};
const pageLabel = (page: BrowserPage): string => page.title ?? hostOf(page.url);

const frameEl = ref<HTMLElement | undefined>();
const stageEl = ref<HTMLElement | undefined>();

const takeControl = (): void => {
    view.driving.value = !view.driving.value;
    if (view.driving.value) {
        stageEl.value?.focus();
    }
};

const close = (name: string): void => void closeBrowser(name);

/* THE HELP REQUEST'S ANSWERING END. The agent parked its turn on `request_help` and the daemon flagged this
 * session; the banner below renders that flag, and these two buttons settle the parked card over the same
 * /agent/reply side channel the chat's cards use. The banner comes down when the daemon publishes the cleared
 * flag — the same push that raised it — so nothing here mutates the list. `helpNote` rides back to the agent
 * either way ("typed the password, don't touch remember-me"). */
const helpNote = ref(``);
watch(selected, () => (helpNote.value = ``));
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
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- Nothing has browsed yet. Not an error — most turns never open a browser — so this reads as a
             description of the surface rather than as something having gone wrong. -->
        <div v-if="sessions.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <Icon name="globe" class="text-2xl text-muted" />
            <div class="text-sm text-content">No browsers open</div>
            <div class="max-w-sm text-xs text-muted">
                When an agent opens a page with its browser tools, it appears here — live, with every page it has open as a tab.
            </div>
        </div>

        <template v-else>
            <!-- Which browser. One pill per conversation that has browsed; hidden entirely when there is only
                 one, since a single pill is furniture rather than a choice. -->
            <div v-if="sessions.length > 1" class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1">
                <button
                    v-for="session in sessions"
                    :key="session.name"
                    type="button"
                    class="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors"
                    :class="session.name === selected ? 'bg-primary-600/15 text-link' : 'text-muted hover:text-content'"
                    @click="selectSession(session.name)"
                >
                    <!-- A dot rather than a word: liveness is the only thing that separates two otherwise
                         identical pills, and it has to read at a glance. A browser asking for help outranks
                         "running" — that pill is the one the reader came to find. -->
                    <span
                        class="size-1.5 rounded-full"
                        :class="session.help !== undefined ? 'bg-warning' : session.running ? 'bg-success' : 'bg-muted'"
                    />
                    <span class="max-w-40 truncate">{{ session.label }}</span>
                </button>
            </div>

            <!-- Which page. The agent's own tab strip, in the shape a person already reads. -->
            <div class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-card px-2 py-1">
                <button
                    v-for="page in current?.pages ?? []"
                    :key="page.id"
                    type="button"
                    class="flex min-w-0 shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors"
                    :class="page.id === activePage?.id ? 'bg-primary-600/15 text-link' : 'text-muted hover:text-content'"
                    v-tooltip.bottom="page.url"
                    @click="pickPage(page)"
                >
                    <Icon name="globe" class="shrink-0 text-2xs" />
                    <span class="max-w-48 truncate">{{ pageLabel(page) }}</span>
                </button>
                <span v-if="(current?.pages.length ?? 0) === 0" class="px-1 text-xs text-muted">No pages open</span>
            </div>

            <!-- The address line, and the two things that can be done to a browser you are watching. -->
            <div class="flex shrink-0 items-center gap-2 border-b border-line bg-card px-2 py-1 text-2xs text-muted">
                <span class="truncate font-mono">{{ activePage?.url ?? "about:blank" }}</span>
                <button
                    type="button"
                    class="ml-auto shrink-0 rounded border border-line px-1.5 py-0.5 transition-colors hover:text-content"
                    :class="{ 'text-link': view.driving.value }"
                    v-tooltip.bottom="
                        view.driving.value
                            ? 'Stop sending your clicks and keystrokes to the agent\'s browser'
                            : 'Send your clicks and keystrokes to the agent\'s browser'
                    "
                    :disabled="current?.running !== true"
                    @click="takeControl"
                >
                    {{ view.driving.value ? "Watching only" : "Take control" }}
                </button>
                <button
                    v-if="current?.running"
                    type="button"
                    class="shrink-0 rounded border border-line px-1.5 py-0.5 transition-colors hover:text-danger"
                    v-tooltip.bottom="`Close this browser — the agent's next browser tool call will fail`"
                    @click="close(current.name)"
                >
                    Close
                </button>
            </div>

            <!-- The agent asked for hands. The banner sits between the controls and the picture — over the very
                 stage the user is about to act on — and its buttons settle the parked request; it comes down on
                 the daemon's own push, the same one that raised it. -->
            <div v-if="current?.help" class="flex shrink-0 flex-col gap-2 border-b border-line bg-warning/10 px-3 py-2">
                <div class="flex items-start gap-2">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-sm text-warning" />
                    <div class="min-w-0 flex-1 text-xs text-content">
                        <span class="font-medium">The agent needs your help:</span>
                        {{ current.help.message }}
                        <span class="text-muted"> — take control, fix that step, then hand back.</span>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <input
                        v-model="helpNote"
                        type="text"
                        placeholder="Optional note back to the agent"
                        class="min-w-40 flex-1 rounded border border-line bg-card px-2 py-1 text-xs text-content placeholder:text-subtle"
                        @keydown.enter="resolveHelp(true)"
                    />
                    <button
                        type="button"
                        class="shrink-0 rounded bg-primary-600 px-2 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
                        @click="resolveHelp(true)"
                    >
                        Done — hand back
                    </button>
                    <button
                        type="button"
                        class="shrink-0 rounded border border-line px-2 py-1 text-xs text-muted transition-colors hover:text-content"
                        @click="resolveHelp(false)"
                    >
                        Can't help now
                    </button>
                </div>
            </div>

            <!-- The picture. Keeps the terminal surface (dark in BOTH modes) so a page that doesn't fill the box
                 letterboxes into black rather than sitting in a bright rectangle. -->
            <div
                v-if="current?.running"
                ref="stageEl"
                tabindex="0"
                class="relative flex min-h-0 flex-1 select-none items-center justify-center bg-terminal outline-none"
                @mousemove="frameEl && view.onMouseMove($event, frameEl)"
                @mousedown="frameEl && view.onMouseDown($event, frameEl)"
                @mouseup="frameEl && view.onMouseUp($event, frameEl)"
                @wheel="frameEl && view.onWheel($event, frameEl)"
                @keydown="view.onKeyDown"
                @paste="view.onPaste"
                @contextmenu.prevent
            >
                <img v-show="view.frame.value" ref="frameEl" :src="view.frame.value" alt="" draggable="false" class="h-full w-full object-contain" />
                <div v-if="view.status.value" class="absolute inset-0 flex items-center justify-center px-4">
                    <span class="rounded-md bg-card px-2 py-1 text-center text-xs text-muted">{{ view.status.value }}</span>
                </div>
            </div>

            <!-- A browser that has closed. Not a failed stream — there is nothing to stream — so it reads as the
                 record it is, and the strip above it (which lists every tab a finished session ever had, not just
                 the ones open at the end) is the actual content. -->
            <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
                <Icon name="globe" class="text-2xl text-muted" />
                <div class="text-sm text-content">This browser has closed</div>
                <div class="max-w-sm text-xs text-muted">
                    <template v-if="current?.finishedAt !== undefined">Closed {{ relativeTime(current.finishedAt) }}. </template>
                    Every page it opened is still listed above, with the one it ended on selected — the record of where the agent went.
                </div>
            </div>
        </template>
    </div>
</template>
