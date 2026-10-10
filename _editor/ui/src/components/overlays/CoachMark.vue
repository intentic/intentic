<!-- THE COACH MARK: a short hint hung off a real control, for a guided first run. Non-modal on purpose: nothing behind
     it dims or stops working, because the way to finish a step is to press the thing it points at, not "Next". It is
     an AnchoredOverlay, so a press outside, Escape or the window losing focus closes it like any panel; `dismiss` is
     only for a reader saying "not now" to the hint itself. Copy is the caller's: a title, a line or two, and at most
     one action that does what the step asks (open the page, focus the field). -->
<script setup lang="ts">
import { useT } from "../../i18n/index.js";
import type { Cross, Side } from "../../lib/anchorPlacement.js";
import Button from "../primitives/Button.vue";
import AnchoredOverlay from "./AnchoredOverlay.vue";

const t = useT();

const {
    anchor,
    title,
    side = `bottom`,
    cross = `start`,
    eyebrow,
    action,
    dismissLabel,
} = defineProps<{
    anchor: HTMLElement | undefined;
    title: string;
    side?: Side;
    cross?: Cross;
    // A quiet line above the title, such as where in a sequence this hint sits ("Step 2 of 4").
    eyebrow?: string;
    // The one press that does what the hint asks; absent when the anchor itself is the press.
    action?: string;
    // What the quiet way out says; the kit's "Not now" unless the caller has a truer word.
    dismissLabel?: string;
}>();

const open = defineModel<boolean>({ required: true });

const emit = defineEmits<{ act: []; dismiss: [] }>();

const act = (): void => {
    open.value = false;
    emit(`act`);
};

const dismiss = (): void => {
    open.value = false;
    emit(`dismiss`);
};
</script>

<template>
    <!-- Not handed back focus: a hint that opened by itself took none, and pulling the keyboard to its anchor would move
         the reader's place on the tour's say-so. -->
    <AnchoredOverlay v-model="open" :anchor="anchor" :side="side" :cross="cross" :restore-focus="false" :gap="10">
        <div class="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 p-3.5" :aria-label="title">
            <p v-if="eyebrow" class="text-2xs font-medium text-primary-400">{{ eyebrow }}</p>
            <p class="text-sm font-semibold text-content">{{ title }}</p>
            <div class="text-xs leading-relaxed text-muted"><slot /></div>
            <div class="mt-2 flex items-center justify-end gap-2">
                <Button size="small" tier="quiet" @click="dismiss">{{ dismissLabel ?? t(`ui.coachMark.notNow`) }}</Button>
                <Button v-if="action" size="small" tier="loud" @click="act">{{ action }}</Button>
            </div>
        </div>
    </AnchoredOverlay>
</template>
