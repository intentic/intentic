<script setup lang="ts">
import type { WorkspaceFileWindow } from "@intentic/api-contract";
import { Button, formatBytes, vAction } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { FILE_WINDOW_BYTES, readFileWindow } from "../files/fileWindow";
import { changeEpochOf } from "../changes/useWorkspaceLive";
import { RAW_MAX_BYTES } from "../explorer/fileType";
import CodeView from "./CodeView.vue";

// Read-only, windowed surface for text too big for an editable buffer (a build log, data dump, generated bundle).
// Monaco itself can hold 120MB; the daemon and wire can't, so text arrives one window at a time (head, `Load more`,
// `Follow`). Following appends only the bytes added since the last read, not a full re-read on every change.

// `first`: window the dispatcher already fetched for the file's size; reusing it saves a second read.
const { path, first, lang } = defineProps<{ path: string; first: WorkspaceFileWindow; lang?: string }>();
const emit = defineEmits<{ download: [] }>();

// Text kept while following; past this it reseeds from the tail instead of growing the model unbounded.
const RETAIN_BYTES = 24 * 1024 * 1024;

// Text CodeView mounts/reseeds with; later appends go through its append(), which preserves scroll position.
const seed = ref(first.content);
// Byte range currently shown, and the newest size seen (a growing file reports it on every read).
const start = ref(first.offset);
const end = ref(first.offset + first.bytes);
const size = ref(first.size);
const following = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const view = ref<InstanceType<typeof CodeView>>();

// One in-flight window at a time; an overlapping tick is dropped, not queued, since the next one reads fresh.
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
        // Deleted while being followed: view keeps what it already holds rather than blanking on the reader.
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

// Replaces what's shown with `window`: a tail jump, or a reseed after rotation or past RETAIN_BYTES.
const reseed = (window: WorkspaceFileWindow): void => {
    seed.value = window.content;
    start.value = window.offset;
    end.value = window.offset + window.bytes;
    size.value = window.size;
};

// Starts over from one end of the file (tail if following, else head), when what's held is stale (rotated) or
// past retention.
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
    // File shrank below the read point (rotated/rewritten): restart from an end instead of appending stale text.
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

// File changed on disk: only a follower re-reads, since a windowed view is a snapshot the user asked for, not
// something to refetch on every write. Fetches only the appended bytes from `end`; dropped if one is already running.
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
            <span class="shrink-0">Read-only: {{ position }}</span>
            <span v-if="error" class="min-w-0 flex-1 truncate text-danger">{{ error }}</span>
            <span v-else class="flex-1"></span>
            <Button
                v-if="!atEnd"
                size="small"
                severity="secondary"
                :text="true"
                class="shrink-0"
                :disabled="busy"
                @click="loadMore"
                v-tooltip.bottom="`Read the next ${formatBytes(Math.min(remaining, FILE_WINDOW_BYTES))}`"
            >
                <Icon :name="busy ? `spinner` : `download`" :spin="busy" class="text-[0.7rem]" /> Load more
            </Button>
            <Button
                size="small"
                severity="secondary"
                :text="true"
                class="shrink-0"
                :class="following ? `text-primary-500` : ``"
                @click="toggleFollow"
                v-tooltip.bottom="'Jump to the end and append new lines as they are written'"
            >
                <Icon :name="following ? `wave-pulse` : `chevron-down`" class="text-[0.7rem]" /> Follow
            </Button>
            <!--
                Shown only when download would work: /workspace/raw 413s past RAW_MAX_BYTES, and a button whose only job is
                to fail is worse than none.
            -->
            <Button
                v-if="size <= RAW_MAX_BYTES"
                size="small"
                severity="secondary"
                :text="true"
                class="shrink-0"
                @click="emit(`download`)"
                v-tooltip.bottom="'Download the whole file'"
            >
                <Icon name="download" class="text-[0.7rem]" /> Download
            </Button>
        </div>
        <div class="min-h-0 flex-1">
            <CodeView ref="view" :path="path" :code="seed" :lang="lang" />
        </div>
    </div>
</template>
