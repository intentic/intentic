<script setup lang="ts">
import { AnchoredOverlay, Icon, useHoverIntent } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { type ProofMark, sealOf } from "./proofSeal";
import SealGlyph from "./SealGlyph.vue";

// THE CARD'S SEAL: one glyph for what its last turn showed of its own work (SealGlyph), and, under a pointer that stays,
// a small card that says it in full: what the agent ran, whether it passed, what it changed without looking. Not a
// tooltip: a reading is a sentence and a command, which a one-line tooltip clips. A mark, never a press, so a click on
// it is the card's, which opens the card; on the rail the row is a button of its own. Nothing here is a gate: it is
// read off the checks the agent chose to run, and CI checks everything once the work is pushed.

const t = useT();

const props = defineProps<{
    proof: ProofMark;
    // A receipt card (AgentCard): a closed seal is history there, so it takes the row's ink instead of green.
    quiet?: boolean;
    // The status this glyph stands in for in the card's corner (Landed, Idle), said first in the card so the corner
    // still says what it said before the seal took it.
    status?: string;
}>();

const kind = computed(() => sealOf(props.proof));

const tone = computed(() => {
    if (kind.value === `broke`) {
        return `text-danger`;
    }
    return kind.value === `closed` && props.quiet !== true ? `text-success` : `text-muted`;
});
// The overlay's own glyph always wears the verdict's colour: it is read, not scanned past.
const headTone = computed(() => (kind.value === `broke` ? `text-danger` : kind.value === `closed` ? `text-success` : `text-warning`));

const unviewed = computed(() =>
    props.proof.unviewed === undefined ? undefined : t(`agents.cardSeal.unviewed`, { count: props.proof.unviewed }, props.proof.unviewed),
);

// The one sentence the card leads with, and the line under it.
const reading = computed((): { head: string; detail: string } => {
    const verification = props.proof.verification;
    if (verification === `verified`) {
        return { head: t(`agents.cardSeal.verified`), detail: t(`agents.cardSeal.verifiedDetail`) };
    }
    if (verification === `failing`) {
        return { head: t(`agents.cardSeal.failed`), detail: t(`agents.cardSeal.failedDetail`) };
    }
    if (verification === `unproven`) {
        return { head: t(`agents.cardSeal.unproven`), detail: t(`agents.cardSeal.unprovenDetail`) };
    }
    // Only an interface changed unseen: the count is the whole story.
    return { head: t(`agents.cardSeal.unviewedHead`), detail: unviewed.value ?? `` };
});

// The glyph's accessible name: the same readings as the card, one a line.
const label = computed(() =>
    [
        ...(props.status === undefined ? [] : [props.status]),
        reading.value.head,
        ...(props.proof.check === undefined ? [] : [props.proof.check]),
        ...(props.proof.verification !== undefined && unviewed.value !== undefined ? [unviewed.value] : []),
    ].join(`\n`),
);

// Opens for a pointer that stays and waits for one that overshoots onto the card, as DevRebuild's card does.
const anchor = ref<HTMLElement>();
const hover = useHoverIntent({ open: 200, close: 150, warm: 300 });
const open = computed({
    get: () => hover.shown.value,
    set: (value: boolean) => (value ? hover.show() : hover.hide()),
});
const onEnter = (event: PointerEvent): void => {
    if (event.pointerType === `mouse`) {
        hover.enter();
    }
};
const onLeave = (): void => hover.leave();
const onCardEnter = (): void => hover.cancel();
</script>

<template>
    <span
        ref="anchor"
        class="inline-flex shrink-0 items-center"
        :class="tone"
        data-seal
        :data-seal-kind="kind"
        role="img"
        :aria-label="label"
        @pointerenter="onEnter"
        @pointerleave="onLeave"
    >
        <SealGlyph :kind="kind" aria-hidden="true" />
        <AnchoredOverlay v-model="open" :anchor="anchor" side="top" cross="end">
            <div class="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2.5 p-3 text-left" data-seal-card @pointerenter="onCardEnter" @pointerleave="onLeave">
                <p v-if="status" class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ status }}</p>
                <div class="flex items-start gap-2">
                    <SealGlyph :kind="kind" class="mt-px text-base" :class="headTone" />
                    <div class="flex min-w-0 flex-col gap-0.5">
                        <p class="text-xs font-medium text-content">{{ reading.head }}</p>
                        <p class="text-2xs leading-relaxed text-muted">{{ reading.detail }}</p>
                    </div>
                </div>
                <div v-if="proof.check" class="flex flex-col gap-1">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`agents.cardSeal.ran`) }}</span>
                    <code class="break-all rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-2xs leading-relaxed text-content">{{
                        proof.check
                    }}</code>
                </div>
                <p v-if="proof.verification !== undefined && unviewed" class="flex items-start gap-1.5 text-2xs leading-relaxed text-muted">
                    <Icon name="eye-slash" class="mt-0.5 shrink-0 text-warning" />{{ unviewed }}
                </p>
                <p class="border-t border-line pt-2 text-2xs leading-relaxed text-subtle">{{ t(`agents.cardSeal.note`) }}</p>
            </div>
        </AnchoredOverlay>
    </span>
</template>
