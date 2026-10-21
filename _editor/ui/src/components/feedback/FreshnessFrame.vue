<!-- A pane that says when what it shows may be out of date: a quiet line along its top edge while a newer answer is slow to come, and how old the shown answer is once that is worth reading. Every read with an answer on screen reports to it (freshness.ts); the content itself is never dimmed or animated. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, provide, type Ref, ref, shallowReactive, watch } from "vue";
import { useNow } from "../../composables/useNow.js";
import { useLoadingReveal } from "../../composables/loadingReveal.js";
import { useT } from "../../i18n/index.js";
import { timeAgo } from "../../lib/format.js";
import { FRESHNESS_SCOPE, type ReadFreshness } from "./freshness.js";
import { vTooltip } from "../../lib/tooltip.js";
import Icon from "../primitives/Icon.vue";

// An answer this young when its refresh began was confirmed a moment ago (a poll, a push right after a write): checking
// it again says nothing about whether it is true, and drawing every poll would draw the line all day.
const ROUTINE_REFRESH_MS = 10_000;
// A refresh shorter than this (plus the reveal's own delay) is never drawn: the answer lands before the eye looks up.
const LINE_AFTER_MS = 300;
// A refresh still out after this has stopped being a blip, and how old the shown answer is becomes worth saying.
const AGE_AFTER_MS = 3_000;
// Younger than this, the age is "just now" and saying it would only add noise.
const STALE_AFTER_MS = 60_000;

const { offline = false, lostAt } = defineProps<{
    /** Nothing can be confirmed: the sandbox is not answering, so every answer shown is the last one it gave. */
    offline?: boolean;
    /**
     * When the sandbox last stopped answering this session. Until then the live stream kept what was shown true, so an
     * answer fetched earlier is still as of that moment, not as of when it was fetched.
     */
    lostAt?: number | undefined;
}>();

const t = useT();

const reads = shallowReactive(new Set<() => ReadFreshness>());
provide(FRESHNESS_SCOPE, { join: (read) => reads.add(read), leave: (read) => reads.delete(read) });

const shown = computed(() => [...reads].map((read) => read()).filter((read) => read.shown));
// Answers being checked that were not just confirmed: the ones a slow refresh leaves in doubt.
const checking = computed(() =>
    shown.value.filter((read) => read.refreshingSince !== undefined && read.refreshingSince - (read.updatedAt ?? 0) >= ROUTINE_REFRESH_MS),
);
const checkingSince = computed(() =>
    checking.value.length === 0 ? undefined : Math.min(...checking.value.map((read) => read.refreshingSince ?? Date.now())),
);
const failed = computed(() => shown.value.filter((read) => read.refreshError !== undefined));

// True once `after` has passed since `since`, false again the moment `since` is gone or moves.
const dueAfter = (since: () => number | undefined, after: number): Ref<boolean> => {
    const due = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    watch(
        since,
        (start) => {
            clearTimeout(timer);
            due.value = false;
            if (start === undefined) {
                return;
            }
            const wait = start + after - Date.now();
            if (wait <= 0) {
                due.value = true;
                return;
            }
            timer = setTimeout(() => (due.value = true), wait);
        },
        { immediate: true },
    );
    onBeforeUnmount(() => clearTimeout(timer));
    return due;
};

const slow = dueAfter(() => checkingSince.value, LINE_AFTER_MS);
const long = dueAfter(() => checkingSince.value, AGE_AFTER_MS);
// The reveal's floor holds the line long enough to register once drawn, so a refresh ending just after it never blinks.
// Only for a refresh under way: a sandbox that is not answering is not being asked, and the shell already says so.
const line = useLoadingReveal(
    slow,
    computed(() => ``),
);

// A sandbox that stops answering for a moment (a page waking up, a tunnel reconnecting) is not worth a word: only once
// it has stayed silent past the same blip is everything shown in doubt.
const offlineSince = ref<number | undefined>(undefined);
watch(
    () => offline,
    (silent) => {
        offlineSince.value = silent ? Date.now() : undefined;
    },
    { immediate: true },
);
const unanswered = dueAfter(() => offlineSince.value, AGE_AFTER_MS);

// What is in doubt, and as of when it was last known true.
const doubted = computed((): readonly ReadFreshness[] => (unanswered.value ? shown.value : [...(long.value ? checking.value : []), ...failed.value]));
const asOf = computed((): number | undefined => {
    const known = doubted.value.flatMap((read) => (read.updatedAt === undefined ? [] : [Math.max(read.updatedAt, lostAt ?? 0)]));
    return known.length === 0 ? undefined : Math.min(...known);
});
const now = useNow(() => asOf.value !== undefined, 60_000);
const age = computed(() => (asOf.value !== undefined && now.value - asOf.value >= STALE_AFTER_MS ? timeAgo(asOf.value, { now: now.value }) : undefined));

const failure = computed(() => failed.value[0]?.refreshError);
const warned = computed(() => unanswered.value || failure.value !== undefined);
const why = computed(() => {
    if (unanswered.value) {
        return t(`ui.freshness.offline`);
    }
    return failure.value === undefined ? t(`ui.freshness.checking`) : t(`ui.freshness.failed`, { error: failure.value });
});
</script>

<template>
    <slot />
    <!-- Over the pane, never in its flow: drawing either must not move a pixel of what the reader is looking at. -->
    <div v-if="line || age !== undefined" class="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center">
        <div v-if="line" class="relative h-0.5 w-full self-stretch overflow-hidden" aria-hidden="true">
            <div class="ui-freshness-sweep absolute inset-y-0 w-1/3" :class="warned ? `bg-warning` : `bg-primary-500`" />
        </div>
        <!-- Centred under the edge: a page's header keeps its title at the left and its actions at the right. -->
        <p
            v-if="age !== undefined"
            v-tooltip.bottom="why"
            role="status"
            class="pointer-events-auto mt-1.5 flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-0.5 text-2xs text-muted shadow-sm"
        >
            <Icon :name="warned ? `exclamation-circle` : `refresh`" :spin="!warned" :class="warned ? `text-warning` : ``" aria-hidden="true" />
            <span class="tabular-nums">{{ t(`ui.freshness.updated`, { ago: age }) }}</span>
        </p>
    </div>
</template>
