<script setup lang="ts">
import { Button, CopyButton, EmptyState, formatElapsed, formatTokens, Markdown, timeAgo } from "@intentic/ui";
import { messageOr, useLatest, useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { changeEpochOf, derivedEpochOf } from "../changes/live/useWorkspaceLive";
import { firstDeriveAttempt, rememberedDerivedText } from "../files/derivedCache";
import { deriveText, readDerivedText, type WorkspaceDerived } from "../files/derivedText";
import ConversionNotes from "./ConversionNotes.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

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

// Follows the shared clock only while something is in flight, so an idle pane holds no timer.
const busySince = ref(0);
const ticking = ref(false);
const now = useNow(ticking, 250);

const startClock = (): void => {
    busySince.value = Date.now();
    ticking.value = true;
};
// Called when either the read or the derivation lands, so it has to check the other: a re-read finishing under a
// running derivation must not freeze the count the reader is watching.
const stopClock = (): void => {
    if (!loading.value && !deriving.value) {
        ticking.value = false;
    }
};

// Never below zero: the shared clock may not have ticked since this wait began.
const waitedMs = computed(() => (busySince.value === 0 ? 0 : Math.max(0, now.value - busySince.value)));
const waited = computed(() => (busySince.value === 0 ? `` : formatElapsed(waitedMs.value / 1000)));
// Reading an existing shadow is a round trip, usually a few frames: labelling it instantly would flash a sentence at
// a reader who never waited for anything.
const slowRead = computed(() => waitedMs.value >= 400);
// Past this, the wait is long enough that a reader wants to know they are allowed to walk away from it.
const longDerive = computed(() => waitedMs.value >= 20_000);

// Reads are cheap and idempotent; a stale one landing after a newer one is the only hazard, so the latest wins.
const latest = useLatest();
const settle = (isLatest: () => boolean, result: WorkspaceDerived): void => {
    if (!isLatest()) {
        return;
    }
    shadow.value = result;
    error.value = null;
};

const derive = (target: string): void => {
    const isLatest = latest();
    deriving.value = true;
    startClock();
    deriveText(target).then(
        (result) => {
            settle(isLatest, result);
            deriving.value = false;
            stopClock();
        },
        (err: unknown) => {
            if (!isLatest()) {
                return;
            }
            deriving.value = false;
            stopClock();
            error.value = messageOr(err, t(`workspace.derivedTextView.renderFailed`));
        },
    );
};

// A reader looking at this pane has already asked for this file's text; a button asking them to confirm it is a step,
// not a choice, and one ordinary document costs a few hundred milliseconds to read — a load, not a job. Nothing renders
// in the background, so a stale rendering is refreshed here too, or it stays stale. Another reader's run in flight
// (`deriving`) is left alone: its landing re-reads this pane.
const deriveIfNothingElseWill = (target: string, result: WorkspaceDerived): void => {
    const current = result.present ? !result.stale : !result.derivable || result.state === `broken` || result.state === `undeliverable`;
    if (current || result.state === `deriving`) {
        return;
    }
    // Once per version of the file: one that renders to nothing has answered, and this pane re-reads often.
    if (firstDeriveAttempt(target, changeEpochOf(target))) {
        derive(target);
    }
};

const load = (target: string): void => {
    const isLatest = latest();
    // What this path answered last, painted before the read that confirms it. A file whose text exists is not being
    // read again — the daemon keys shadows by content hash — and a spinner over it says otherwise.
    shadow.value = rememberedDerivedText(target);
    loading.value = true;
    startClock();
    readDerivedText(target).then(
        (result) => {
            settle(isLatest, result);
            loading.value = false;
            stopClock();
            deriveIfNothingElseWill(target, result);
        },
        (err: unknown) => {
            if (!isLatest()) {
                return;
            }
            loading.value = false;
            stopClock();
            error.value = messageOr(err, t(`workspace.derivedTextView.readFailed`));
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

// Whether someone else's rendering of this file is under way, rather than this pane's own.
const waiting = computed(() => shadow.value?.state === `deriving`);

// A format nothing reads cannot be rendered by asking harder, and a sandbox with no renderer would fail the same way
// for every file; everything else is worth offering.
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
            return t(`workspace.derivedTextView.deriving`);
        case `broken`:
            return t(`workspace.derivedTextView.noRenderer`);
        case `undeliverable`:
            return t(`workspace.derivedTextView.undeliverable`);
        default:
            // `reason` is set exactly when a derivation was just attempted and produced nothing, which is the common
            // way to arrive here: opening the file already tried, so "nothing has read this" would be untrue.
            return absent.value?.reason === undefined ? t(`workspace.derivedTextView.notReadYet`) : t(`workspace.derivedTextView.noTextCameOut`);
    }
});
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <template v-if="shadow?.present === true">
            <!-- Provenance first: what made this text, how much of an agent's context it costs, and how old it is. -->
            <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5 text-2xs text-muted">
                <Icon name="robot" class="shrink-0 text-[0.7rem]" />
                <span class="shrink-0" v-tooltip.bottom="{ title: t(`workspace.words.renderedText`), note: t(`workspace.words.whatAgentsRead`) }">
                    {{ t(`workspace.derivedTextView.derivedText`) }}
                </span>
                <span class="shrink-0 text-subtle">{{ shadow.deriver }}</span>
                <span class="shrink-0 text-subtle">{{ t(`workspace.derivedTextView.tokens`, { tokens: formatTokens(shadow.tokens) }) }}</span>
                <span v-if="shadow.derivedAt !== undefined" class="shrink-0 text-subtle">{{
                    timeAgo(Date.parse(shadow.derivedAt), { days: true })
                }}</span>
                <span class="flex-1"></span>
                <!-- The text below is the previous reading while this runs; without the count it looks like nothing is. -->
                <span v-if="deriving" class="shrink-0 text-subtle">{{ t(`workspace.derivedTextView.readingAgain`, { waited }) }}</span>
                <CopyButton
                    :text="shadow.content"
                    :aria-label="t(`workspace.derivedTextView.copyDerivedText`)"
                    v-tooltip.bottom="t(`workspace.derivedTextView.copyText`)"
                />
                <Button
                    size="small"
                    severity="secondary"
                    :text="true"
                    class="shrink-0"
                    :disabled="deriving"
                    @click="derive(path)"
                    v-tooltip.bottom="t(`workspace.derivedTextView.rereadFile`)"
                >
                    <Icon :name="deriving ? `spinner` : `refresh`" :spin="deriving" class="text-[0.7rem]" />
                    {{ t(`workspace.derivedTextView.deriveAgain`) }}
                </Button>
                <Button v-if="downloadable" size="small" severity="secondary" :text="true" class="shrink-0" @click="emit(`download`)">
                    <Icon name="download" class="text-[0.7rem]" /> {{ t(`ui.action.download`) }}
                </Button>
            </div>
            <!-- The file moved on under its text. Said plainly, since everything below is then about an older file, and
                 saying whether a fix is already on its way is the difference between a warning and a chore. -->
            <div
                v-if="shadow.stale"
                class="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-2xs text-warning"
            >
                <Icon :name="waiting ? `spinner` : `exclamation-triangle`" :spin="waiting" class="shrink-0 text-[0.7rem]" />
                <span>
                    {{ t(`workspace.derivedTextView.fileChangedAfterText`) }}
                    <template v-if="waiting">{{ t(`workspace.derivedTextView.beingReadNow`) }}</template>
                </span>
            </div>
            <!-- Every cap and degradation the derivation hit, shown rather than stored. -->
            <ConversionNotes :notes="shadow.notes.map((text) => ({ text }))" />
            <div class="ui-softscroll min-h-0 flex-1 overflow-auto bg-canvas px-6 py-5">
                <Markdown v-if="shadow.content !== ''" :source="shadow.content" class="mx-auto max-w-3xl" />
                <p v-else class="mx-auto max-w-3xl text-sm text-muted">
                    {{ t(`workspace.derivedTextView.fileRenderedToNothing`) }}
                </p>
                <p v-if="shadow.truncated" class="mx-auto mt-6 max-w-3xl border-t border-line pt-3 text-2xs text-subtle">
                    {{ t(`workspace.derivedTextView.longRenderingOnlyFirst`) }}
                </p>
            </div>
        </template>

        <!-- A bare spinner over a wait that can legitimately run for a minute is indistinguishable from a failure, so
             this says what is running, why it takes what it takes, and how long it has been going. -->
        <div v-else-if="loading || deriving" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            <Icon name="spinner" class="text-xl" spin />
            <template v-if="deriving">
                <p class="text-sm">{{ t(`workspace.derivedTextView.readingFileWritingText`) }}</p>
                <!-- What actually takes time, which is not what a reader assumes: a document is a few hundred
                     milliseconds, and OCR is the one case that runs long. Recordings are read for duration and tags,
                     not transcribed, so this must not imply otherwise. -->
                <p class="max-w-sm text-2xs text-subtle">
                    {{ t(`workspace.derivedTextView.mostDocumentsTakeMoment`) }}
                </p>
                <p class="text-2xs tabular-nums text-subtle">{{ waited }}</p>
                <p v-if="longDerive" class="max-w-sm text-2xs text-subtle">
                    {{ t(`workspace.derivedTextView.stillGoingNothingFailed`) }}
                </p>
            </template>
            <p v-else-if="slowRead" class="text-2xs text-subtle">{{ t(`workspace.derivedTextView.lookingFilesText`) }}</p>
        </div>

        <EmptyState v-else-if="error" tone="danger" :title="error" class="h-full" />

        <!-- No text yet, which is four different situations: being read, never read, read to nothing, or unreadable here. -->
        <EmptyState v-else :icon="emptyIcon" :spin="waiting" :title="emptyMessage" :line="shadow?.reason ?? ``" class="h-full">
            <template v-if="canDerive || downloadable" #actions>
                <Button v-if="canDerive" severity="secondary" :disabled="deriving || waiting" @click="derive(path)">
                    <Icon name="align-left" class="text-xs" />
                    {{ t(`workspace.derivedTextView.renderText`) }}
                </Button>
                <Button v-if="downloadable" severity="secondary" @click="emit(`download`)">
                    <Icon name="download" class="text-xs" />
                    {{ t(`ui.action.download`) }}
                </Button>
            </template>
        </EmptyState>
    </div>
</template>
