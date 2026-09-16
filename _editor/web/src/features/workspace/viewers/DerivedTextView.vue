<script setup lang="ts">
import { Button, CopyButton, formatTokens, Markdown, timeAgo } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, onUnmounted, ref, watch } from "vue";
import { formatElapsed } from "../../agents/fleet/agentStatus";
import { changeEpochOf, derivedEpochOf, sidecarQueue } from "../changes/live/useWorkspaceLive";
import { firstDeriveAttempt, rememberedDerivedText } from "../files/derivedCache";
import { deriveText, readDerivedText, type WorkspaceDerived } from "../files/derivedText";

/* Derived text is the agent-readable rendering of a file. */

// `downloadable`: the parent can hand over the bytes, so the empty state and the band can offer that too.
const { path, downloadable = false } = defineProps<{ path: string; downloadable?: boolean }>();
const emit = defineEmits<{ download: [] }>();

const shadow = ref<WorkspaceDerived | undefined>(undefined);
const loading = ref(false);
// Split from `loading`: one is the file opening, the other is work this reader asked for and is waiting on.
const deriving = ref(false);
const error = ref<string | null>(null);

/* HOW LONG THIS HAS BEEN GOING. A derivation runs in a child process this pane cannot see into, so there is no
   progress to report — only elapsed time, which is the one thing that distinguishes working from hung. */

// Ticks only while something is in flight, so an idle pane holds no timer.
const busySince = ref(0);
const now = ref(0);
let ticker: ReturnType<typeof setInterval> | undefined;

const startClock = (): void => {
    busySince.value = Date.now();
    now.value = busySince.value;
    ticker ??= setInterval(() => (now.value = Date.now()), 250);
};
const clearTicker = (): void => {
    clearInterval(ticker);
    ticker = undefined;
};
// Called when either the read or the derivation lands, so it has to check the other: a re-read finishing under a
// running derivation must not freeze the count the reader is watching.
const stopClock = (): void => {
    if (!loading.value && !deriving.value) {
        clearTicker();
    }
};
// Unconditional, unlike the above: a pane closed mid-derivation would otherwise leave its timer running for the tab.
onUnmounted(clearTicker);

const waitedMs = computed(() => (busySince.value === 0 ? 0 : now.value - busySince.value));
const waited = computed(() => (busySince.value === 0 ? `` : formatElapsed(busySince.value, now.value)));
// Reading an existing shadow is a round trip, usually a few frames: labelling it instantly would flash a sentence at
// a reader who never waited for anything.
const slowRead = computed(() => waitedMs.value >= 400);
// Past this, the wait is long enough that a reader wants to know they are allowed to walk away from it.
const longDerive = computed(() => waitedMs.value >= 20_000);

// Reads are cheap and idempotent; a stale one landing after a newer one is the only hazard, so the sequence wins.
let seq = 0;
const settle = (id: number, result: WorkspaceDerived): void => {
    if (id !== seq) {
        return;
    }
    shadow.value = result;
    error.value = null;
};

const derive = (target: string): void => {
    const id = ++seq;
    deriving.value = true;
    startClock();
    deriveText(target).then(
        (result) => {
            settle(id, result);
            deriving.value = false;
            stopClock();
        },
        (err: unknown) => {
            if (id !== seq) {
                return;
            }
            deriving.value = false;
            stopClock();
            error.value = errorMessage(err, `Could not render this file as text.`);
        },
    );
};

// Whether this file is about to be read by someone else, closely enough that asking for it again would only put two
// child processes on the same work. A named batch is seconds away, so it is; a whole-tree sweep converges hundreds of
// files and can run for minutes, and the file in front of a reader should not wait behind all of them.
const handledSoon = (result: Extract<WorkspaceDerived, { present: false }>): boolean =>
    result.state === `deriving` || (result.state === `queued` && !result.queue.sweeping);

// A reader looking at this pane has already asked for this file's text; a button asking them to confirm it is a step,
// not a choice, and one ordinary document costs a few hundred milliseconds to read — a load, not a job.
const deriveIfNothingElseWill = (target: string, result: WorkspaceDerived): void => {
    if (result.present || !result.derivable || result.state === `broken` || result.state === `undeliverable` || handledSoon(result)) {
        return;
    }
    // Once per version of the file: one that renders to nothing has answered, and this pane re-reads often.
    if (firstDeriveAttempt(target, changeEpochOf(target))) {
        derive(target);
    }
};

const load = (target: string): void => {
    const id = ++seq;
    // What this path answered last, painted before the read that confirms it. A file whose text exists is not being
    // read again — the daemon keys shadows by content hash — and a spinner over it says otherwise.
    shadow.value = rememberedDerivedText(target);
    loading.value = true;
    startClock();
    readDerivedText(target).then(
        (result) => {
            settle(id, result);
            loading.value = false;
            stopClock();
            deriveIfNothingElseWill(target, result);
        },
        (err: unknown) => {
            if (id !== seq) {
                return;
            }
            loading.value = false;
            stopClock();
            error.value = errorMessage(err, `Could not read this file's text.`);
        },
    );
};

// Two triggers, because the file and its text move independently: the file changing makes this text stale, and the
// text landing is what a reader staring at an empty pane is waiting for. The second is not a workspace change —
// shadows are written where the watcher deliberately does not look — so without it this pane never learns.
watch(
    () => [path, changeEpochOf(path), derivedEpochOf(path)] as const,
    ([target]) => load(target),
    { immediate: true },
);

// The live count beats the one this response was built with: frames keep arriving while a reader looks at a wait.
const queue = computed(() => sidecarQueue.value ?? shadow.value?.queue);
// Whether this file is waiting on the background pass rather than on someone pressing a button.
const waiting = computed(() => shadow.value?.state === `queued` || shadow.value?.state === `deriving`);
const waitLabel = computed(() => {
    if (shadow.value?.state === `deriving`) {
        return `Being read now…`;
    }
    const ahead = queue.value?.queued ?? 0;
    if (queue.value?.sweeping === true) {
        return `Waiting: every file is being checked`;
    }
    return ahead > 1 ? `Waiting, with ${ahead - 1} other ${ahead === 2 ? `file` : `files`} ahead` : `Waiting its turn`;
});

// A format nothing reads cannot be rendered by asking harder, and a sandbox with no renderer would fail the same way
// for every file; everything else is worth offering, including a file whose turn simply has not come.
const canDerive = computed(() => shadow.value !== undefined && shadow.value.state !== `undeliverable` && shadow.value.state !== `broken`);

const emptyIcon = computed(() => {
    if (waiting.value) {
        return `spinner`;
    }
    return shadow.value?.state === `undeliverable` || shadow.value?.state === `broken` ? `box` : `align-left`;
});

// The answer's absent half, where `derivable` and `reason` live. Everything below the text is about this one; the
// template narrows it for itself, a computed has to be told.
const absent = computed(() => (shadow.value?.present === false ? shadow.value : undefined));

const emptyMessage = computed(() => {
    switch (shadow.value?.state) {
        case `deriving`:
        case `queued`:
            return `This file is in line to be read. Its text will appear here on its own.`;
        case `broken`:
            return `This sandbox has no renderer installed, so nothing can be turned into text here.`;
        case `undeliverable`:
            return `Nothing here can turn this file into text.`;
        default:
            // `reason` is set exactly when a derivation was just attempted and produced nothing, which is now the
            // common way to arrive here: opening the file already tried. Saying "nothing has read this" over a file
            // this pane just had read would be the same lie the queued state used to tell.
            return absent.value?.reason === undefined
                ? `Nothing has read this file yet. Rendering it gives you its text — and gives an agent the same.`
                : `This file was read, but no text came out of it.`;
    }
});

</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <template v-if="shadow?.present === true">
            <!-- Provenance first: what made this text, how much of an agent's context it costs, and how old it is. -->
            <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5 text-2xs text-muted">
                <Icon name="robot" class="shrink-0 text-[0.7rem]" />
                <span class="shrink-0" v-tooltip.bottom="'Not the file itself: the text this sandbox rendered from it, and what an agent reads here instead of the bytes.'">
                    Derived text
                </span>
                <span class="shrink-0 text-subtle">{{ shadow.deriver }}</span>
                <span class="shrink-0 text-subtle">{{ formatTokens(shadow.tokens) }} tokens</span>
                <span v-if="shadow.derivedAt !== undefined" class="shrink-0 text-subtle">{{ timeAgo(Date.parse(shadow.derivedAt), { days: true }) }}</span>
                <span class="flex-1"></span>
                <!-- The text below is the previous reading while this runs; without the count it looks like nothing is. -->
                <span v-if="deriving" class="shrink-0 text-subtle">Reading it again… {{ waited }}</span>
                <CopyButton :text="shadow.content" aria-label="Copy derived text" v-tooltip.bottom="'Copy this text'" />
                <Button
                    size="small"
                    severity="secondary"
                    :text="true"
                    class="shrink-0"
                    :disabled="deriving"
                    @click="derive(path)"
                    v-tooltip.bottom="'Read the file again and rewrite this text'"
                >
                    <Icon :name="deriving ? `spinner` : `refresh`" :spin="deriving" class="text-[0.7rem]" /> Derive again
                </Button>
                <Button v-if="downloadable" size="small" severity="secondary" :text="true" class="shrink-0" @click="emit(`download`)">
                    <Icon name="download" class="text-[0.7rem]" /> Download
                </Button>
            </div>
            <!-- The file moved on under its text. Said plainly, since everything below is then about an older file, and
                 saying whether a fix is already on its way is the difference between a warning and a chore. -->
            <div v-if="shadow.stale" class="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-2xs text-warning">
                <Icon :name="waiting ? `spinner` : `exclamation-triangle`" :spin="waiting" class="shrink-0 text-[0.7rem]" />
                <span>
                    This file changed after its text was made, so this is a reading of an older version.
                    <template v-if="waiting">{{ waitLabel }}</template>
                </span>
            </div>
<!-- Every cap and degradation the derivation hit, shown rather than stored. -->
            <ul v-if="shadow.notes.length > 0" class="shrink-0 space-y-0.5 border-b border-line bg-overlay px-3 py-1.5 text-2xs text-muted">
                <li v-for="note of shadow.notes" :key="note" class="flex items-start gap-2">
                    <Icon name="info-circle" class="mt-px shrink-0 text-[0.7rem]" />
                    <span>{{ note }}</span>
                </li>
            </ul>
            <div class="ui-softscroll min-h-0 flex-1 overflow-auto bg-canvas px-6 py-5">
                <Markdown v-if="shadow.content !== ''" :source="shadow.content" class="mx-auto max-w-3xl" />
                <p v-else class="mx-auto max-w-3xl text-sm text-muted">
                    This file rendered to nothing at all. The notes above say what was read; the file itself may simply hold no text.
                </p>
                <p v-if="shadow.truncated" class="mx-auto mt-6 max-w-3xl border-t border-line pt-3 text-2xs text-subtle">
                    Long rendering: only its first part is shown here.
                </p>
            </div>
        </template>

        <!-- A bare spinner over a wait that can legitimately run for a minute is indistinguishable from a failure, so
             this says what is running, why it takes what it takes, and how long it has been going. -->
        <div v-else-if="loading || deriving" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            <Icon name="spinner" class="text-xl" spin />
            <template v-if="deriving">
                <p class="text-sm">Reading this file and writing its text…</p>
                <!-- What actually takes time, which is not what a reader assumes: a document is a few hundred
                     milliseconds, and OCR is the one case that runs long. Recordings are read for duration and tags,
                     not transcribed, so this must not imply otherwise. -->
                <p class="max-w-sm text-2xs text-subtle">
                    Most documents take a moment. A scanned PDF has to be recognised a page at a time, which is the one that can run to a minute or more.
                </p>
                <p class="text-2xs tabular-nums text-subtle">{{ waited }}</p>
                <p v-if="longDerive" class="max-w-sm text-2xs text-subtle">
                    Still going — nothing has failed. The text is written to disk when it lands, so you can leave this file or come back to it and it will be
                    here.
                </p>
            </template>
            <p v-else-if="slowRead" class="text-2xs text-subtle">Looking for this file's text…</p>
        </div>

        <div v-else-if="error" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Icon name="exclamation-triangle" class="text-3xl text-danger" />
            <p class="text-sm text-danger">{{ error }}</p>
        </div>

        <!-- No text yet, which is five different situations. Saying "nothing has read this" over a file already in the
             queue is the failure this pane used to have: the reader is told to act when waiting was the right answer. -->
        <div v-else class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Icon :name="emptyIcon" :spin="waiting" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">{{ emptyMessage }}</p>
            <p v-if="waiting" class="max-w-sm text-2xs text-subtle">{{ waitLabel }}</p>
            <p v-if="shadow?.reason !== undefined" class="max-w-sm text-2xs text-subtle">{{ shadow.reason }}</p>
            <div class="mt-1 flex items-center gap-2">
                <!-- Offered even while queued: this is the way to jump the queue for the file in front of you. -->
                <Button v-if="canDerive" severity="secondary" :disabled="deriving" @click="derive(path)">
                    <Icon name="align-left" class="text-xs" />
                    {{ waiting ? `Read it now` : `Render as text` }}
                </Button>
                <Button v-if="downloadable" severity="secondary" @click="emit(`download`)">
                    <Icon name="download" class="text-xs" />
                    Download
                </Button>
            </div>
            <!-- Only where it is actually actionable: pointing at a switch that is already on is how this misled before. -->
            <p v-if="shadow?.state === `off`" class="max-w-sm text-2xs text-subtle">
                Settings → Agent → Document shadows keeps every document, picture, recording and archive rendered as files change.
            </p>
        </div>
    </div>
</template>
