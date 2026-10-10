<!-- The getting-started checklist's door on the desktop rail: a ring that fills one arc per settled step, opening the
     list beside it. On every route, so the next step is one press away from wherever a first run wandered to. Closed
     unless pressed: the beacons do the pointing, and a list that opened by itself would sit on whatever they point at. -->
<script setup lang="ts">
import { AnchoredOverlay, SegmentRing } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import GettingStartedList from "./GettingStartedList.vue";
import { useGettingStarted } from "./useGettingStarted";

const t = useT();
const tour = useGettingStarted();

const trigger = ref<HTMLButtonElement>();
const open = ref(false);

const label = computed(() => t(`gettingStarted.ring.label`, { settled: tour.progress.value.settled, total: tour.progress.value.total }));

// The one time the list opens unasked: the last step just settled here, which is worth saying while it is fresh.
watch(
    () => tour.finished.value,
    (finished) => {
        if (finished) {
            open.value = true;
        }
    },
);
</script>

<template>
    <template v-if="tour.visible.value">
        <button
            ref="trigger"
            type="button"
            class="icon-rail-tile flex items-center justify-center rounded-lg text-primary-500 transition-colors hover:bg-overlay"
            :class="{ 'bg-primary-600/15': open }"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :aria-label="label"
            v-tooltip.right="open ? undefined : label"
            data-tour="ring"
            @click="open = !open"
        >
            <!-- The glyph says what the ring counts: a bare ring of empty arcs reads as something loading. -->
            <span class="relative flex size-7 items-center justify-center">
                <SegmentRing
                    :segments="tour.progress.value.total"
                    :filled="tour.progress.value.settled"
                    :size="28"
                    :stroke="2.5"
                    class="absolute inset-0"
                />
                <Icon name="list-check" class="text-xs" />
            </span>
        </button>
        <AnchoredOverlay v-model="open" :anchor="trigger" side="right" cross="end">
            <GettingStartedList @done="open = false" />
        </AnchoredOverlay>
    </template>
</template>
