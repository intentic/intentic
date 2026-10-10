<!-- One place a getting-started step points from: a beacon where the reader should press, and the hint it opens. Drawn
     only while its step is the current one and this place leads it (tourMarks.ts), so one beacon is on screen at a time.
     Its hint opens by itself once per place on this device, a moment after the place appears, and after that only when
     the beacon is pressed. Inside a control that is itself a press (a rail tile, a link), it is `still`: a dot, no button
     of its own, its hint hung off that control, since a button inside a link is neither. -->
<script setup lang="ts">
import { Beacon, CoachMark } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { runTourAction, tourMoment, tourProgress, tourTrial } from "./tourState";
import { hintWords, type MarkPlace } from "./tourCopy";
import { type MarkStep, markHinted, registerMark, wasHinted } from "./tourMarks";
import { trackTour } from "./tourEvents";

const t = useT();
const router = useRouter();

const {
    step,
    place,
    priority = 1,
    side = `bottom`,
    still = false,
} = defineProps<{
    step: MarkStep;
    place: MarkPlace;
    // Which of a step's places leads when several are on screen: where the step is done outranks the way there.
    priority?: number;
    side?: `top` | `bottom` | `left` | `right`;
    still?: boolean;
}>();

// Only while the one beacon on screen is this step's (the published `moment`, tourState.ts), and only where this place leads it.
const active = computed(() => tourMoment.value === step);

const mark = registerMark(step, place, priority);
onBeforeUnmount(mark.release);
const shown = computed(() => active.value && mark.lead.value);

const dot = ref<HTMLElement>();
const open = ref(false);
const anchor = computed(() => (still ? (dot.value?.parentElement ?? undefined) : dot.value));

// Whether a first agent would run on the free trial, which is worth saying: it means nothing needs connecting first.
const words = computed(() => hintWords(step, place, tourTrial.value));
const position = computed(() => {
    if (step === `board`) {
        return undefined;
    }
    const rows = tourProgress.value?.rows ?? [];
    const at = rows.findIndex((row) => row.id === step);
    return at < 0 ? undefined : t(`gettingStarted.eyebrow`, { n: at + 1, total: rows.length });
});

const reveal = (): void => {
    open.value = true;
    trackTour(`tour_step_shown`, { step, place });
};

// The one unasked opening per place: a beat after it comes on screen, so the hint lands on a settled layout rather
// than chasing a panel still sliding in.
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
    shown,
    (now) => {
        clearTimeout(timer);
        if (!now) {
            open.value = false;
            return;
        }
        if (!wasHinted(step, place)) {
            timer = setTimeout(() => {
                if (shown.value && !wasHinted(step, place)) {
                    markHinted(step, place);
                    reveal();
                }
            }, 700);
        }
    },
    { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));

const toggle = (): void => {
    if (open.value) {
        open.value = false;
        return;
    }
    reveal();
};

const act = (): void => {
    const action = words.value.action;
    if (action?.to !== undefined) {
        void router.push(action.to);
    }
    if (action?.run !== undefined) {
        runTourAction(action.run);
    }
};
</script>

<template>
    <!-- One root, so the caller's placement classes land on it. The hint teleports to the body whatever the root is. -->
    <span v-if="shown" ref="dot" class="inline-flex" :class="still ? 'pointer-events-none' : ''">
        <Beacon v-if="still" size="sm" />
        <button
            v-else
            type="button"
            class="inline-flex size-5 items-center justify-center rounded-full"
            :aria-label="t(`gettingStarted.markLabel`, { title: words.title })"
            :aria-expanded="open"
            @click.stop="toggle"
        >
            <Beacon />
        </button>
        <CoachMark v-model="open" :anchor="anchor" :side="side" :eyebrow="position" :title="words.title" :action="words.action?.label" @act="act">
            {{ words.line }}
        </CoachMark>
    </span>
</template>
