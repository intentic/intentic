<script setup lang="ts">
import type { WorkspaceFileWindow } from "@intentic-app/api-contract";
import { formatBytes } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { FILE_WINDOW_BYTES, readFileWindow } from "../../../composables/workspace/fileWindow";
import { errorMessage } from "../../../composables/useAsyncAction";
import { changeEpochOf } from "../../../composables/workspace/useWorkspaceLive";
import { RAW_MAX_BYTES } from "../fileType";
import CodeView from "./CodeView.vue";

/* The read-only, WINDOWED surface for text too big to hold as an editable buffer — a build log, a data dump, a
 * generated bundle. It exists because the alternative was a dead end: over the cap the viewer used to offer
 * nothing but Download, and Download went to /workspace/raw, which 413s above 25MB. A 120MB log could not be
 * read and could not be saved.
 *
 * The editor is not the constraint here (Monaco builds a 120MB, 1M-line model in ~150ms and types in 2ms) —
 * the daemon and the wire are, so text arrives one window at a time: the head to begin with, `Load more` for
 * the next slice, and `Follow` to jump to the end and stay there.
 *
 * Following appends ONLY the bytes that were added since the last read. That is the whole point: the editable
 * path re-reads the file on every change epoch, which for a log an agent or a build is still writing means the
 * whole file, four times a second, forever. */

// `first` is the window the dispatcher already fetched to learn the file's size — reusing it means opening a
// huge file costs exactly one read, not two.
const { path, first, lang } = defineProps<{ path: string; first: WorkspaceFileWindow; lang?: string }>();
const emit = defineEmits<{ download: [] }>();

/* How much text the view keeps while following. Appending forever would grow the model without bound over a
 * long-running log; past this it reseeds from the tail, which is the part a follower is reading anyway. */
const RETAIN_BYTES = 24 * 1024 * 1024;

// The text CodeView is mounted/reseeded with. Appends after that go through its exposed append(), which keeps
// the reader's scroll position where setValue() would have thrown it away.
const seed = ref(first.content);
// The byte range currently shown, and the newest size we have seen (a growing file reports it on every read).
const start = ref(first.offset);
const end = ref(first.offset + first.bytes);
const size = ref(first.size);
const following = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const view = ref<InstanceType<typeof CodeView>>();

// One in-flight window at a time, aborted on unmount — a follow tick that arrives while the last one is still
// running is dropped rather than queued, because the next tick will read from wherever this one lands.
let inFlight: AbortController | undefined;
onBeforeUnmount(() => inFlight?.abort());

const shown = computed(() => end.value - start.value);
const atEnd = computed(() => end.value >= size.value);
const remaining = computed(() => size.value - end.value);
// What the reader is looking at, in one line: how much of the file, from where.
const position = computed(() =>
    start.value === 0 && atEnd.value
        ? `All ${formatBytes(size.value)}`
        : `${formatBytes(shown.value)} of ${formatBytes(size.value)}${start.value === 0 ? ` from the start` : atEnd.value ? ` at the end` : ``}`,
);

const read = async (offset: number, limit?: number): Promise<WorkspaceFileWindow | undefined> => {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    busy.value = true;
    try {
        const window = await readFileWindow(path, { offset, limit, signal: controller.signal });
        // Deleted while being followed — the honest thing to say, and the view keeps whatever it already holds
        // rather than blanking a log the reader may still be reading.
        if (!window.present) {
            error.value = `That file is no longer there.`;
            return undefined;
        }
        return window;
    } catch (err) {
        // An abort is this component replacing its own request, never a failure to report.
        if (!controller.signal.aborted) {
            error.value = errorMessage(err, `Could not read the file.`);
        }
        return undefined;
    } finally {
        if (inFlight === controller) {
            inFlight = undefined;
            busy.value = false;
        }
    }
};

// Replace what's shown with `window` (a tail jump, or a reseed after the file rotated or grew past RETAIN_BYTES).
const reseed = (window: WorkspaceFileWindow): void => {
    seed.value = window.content;
    start.value = window.offset;
    end.value = window.offset + window.bytes;
    size.value = window.size;
};

// Start over from one end of the file: its tail while following, otherwise its head. Used when what we hold
// stopped being true (the file rotated) or grew past what the view retains.
const restartFrom = async (offset: number): Promise<void> => {
    const window = await read(offset);
    if (window !== undefined) {
        reseed(window);
    }
};

const loadMore = async (): Promise<void> => {
    error.value = null;
    const window = await read(end.value);
    if (window === undefined) {
        return;
    }
    // The file shrank below where we were reading — rotated, or rewritten from scratch. Nothing we hold is
    // still true, so read one end of the new file instead of appending to the old one's text.
    if (window.size < end.value) {
        await restartFrom(following.value ? -FILE_WINDOW_BYTES : 0);
        return;
    }
    size.value = window.size;
    if (window.bytes === 0) {
        return;
    }
    // Past the retention cap, keep the tail rather than the whole history of a log that never ends.
    if (shown.value + window.bytes > RETAIN_BYTES) {
        await restartFrom(-FILE_WINDOW_BYTES);
        return;
    }
    view.value?.append(window.content);
    end.value += window.bytes;
};

// Jump to the end and stay there; turning it off just stops the appends, leaving what's on screen alone.
const toggleFollow = async (): Promise<void> => {
    following.value = !following.value;
    if (!following.value) {
        return;
    }
    error.value = null;
    await restartFrom(-FILE_WINDOW_BYTES);
    view.value?.revealEnd();
};

/* The file changed on disk. Only a follower reads anything: a windowed view is a snapshot of a range the user
 * asked for, and re-reading it on every write is what made an open log a per-batch full re-read. A follow tick
 * fetches from `end` — the appended bytes and nothing else — and is dropped while one is already running. */
watch(
    () => changeEpochOf(path),
    async () => {
        if (!following.value || busy.value) {
            return;
        }
        await loadMore();
        view.value?.revealEnd();
    },
);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-2xs text-muted">
            <Icon name="eye" class="shrink-0 text-[0.7rem]" />
            <span class="shrink-0">Read-only — {{ position }}</span>
            <span v-if="error" class="min-w-0 flex-1 truncate text-danger">{{ error }}</span>
            <span v-else class="flex-1"></span>
            <button
                v-if="!atEnd"
                type="button"
                class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-overlay hover:text-content disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="busy"
                @click="loadMore"
                v-tooltip.bottom="`Read the next ${formatBytes(Math.min(remaining, FILE_WINDOW_BYTES))}`"
            >
                <Icon :name="busy ? `spinner` : `download`" :spin="busy" class="text-[0.7rem]" /> Load more
            </button>
            <button
                type="button"
                class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-overlay hover:text-content"
                :class="following ? `text-primary-500` : ``"
                @click="toggleFollow"
                v-tooltip.bottom="'Jump to the end and append new lines as they are written'"
            >
                <Icon :name="following ? `wave-pulse` : `chevron-down`" class="text-[0.7rem]" /> Follow
            </button>
            <!-- Only when a download would actually work: /workspace/raw serves to RAW_MAX_BYTES and 413s above
                 it, and a button whose whole job is to fail is worse than no button — reading is covered here. -->
            <button
                v-if="size <= RAW_MAX_BYTES"
                type="button"
                class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-overlay hover:text-content"
                @click="emit(`download`)"
                v-tooltip.bottom="'Download the whole file'"
            >
                <Icon name="download" class="text-[0.7rem]" /> Download
            </button>
        </div>
        <div class="min-h-0 flex-1">
            <CodeView ref="view" :path="path" :code="seed" :lang="lang" />
        </div>
    </div>
</template>
