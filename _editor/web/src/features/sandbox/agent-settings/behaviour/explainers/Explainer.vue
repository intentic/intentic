<script setup lang="ts">
import { Icon, InfoHint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// The (i) beside a Tools section's name: how the mechanism works, drawn rather than told, then the two things a reader
// weighs it by, what they notice in the chat and what it does to the tokens a turn costs. The diagram is a picture of
// the mechanism, not of this sandbox's numbers (those are the section's own chips and tables), and says so.

const t = useT();
const { label, title, experience, tokens } = defineProps<{
    /** The icon's accessible name: "How code search works". */
    label: string;
    title: string;
    /** What the reader notices in the chat. */
    experience: string;
    /** What it does to the tokens a turn costs. */
    tokens: string;
}>();
</script>

<template>
    <InfoHint :label wide>
        <div class="flex flex-col gap-3 text-xs">
            <p class="font-medium text-content">{{ title }}</p>
            <!-- The diagram on a ground of its own, so its boxes read as one figure rather than as more of the card. -->
            <figure class="m-0 flex flex-col gap-2 rounded-lg border border-line-subtle bg-canvas/60 p-3">
                <slot />
                <figcaption class="text-2xs text-subtle">{{ t(`sandbox.explainers.schematic`) }}</figcaption>
            </figure>
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1.5">
                <dt><Icon name="comments" class="text-subtle" :aria-label="t(`sandbox.explainers.inTheChat`)" role="img" /></dt>
                <dd class="m-0 text-muted">{{ experience }}</dd>
                <dt><Icon name="usage" class="text-subtle" :aria-label="t(`sandbox.explainers.tokens`)" role="img" /></dt>
                <dd class="m-0 text-muted">{{ tokens }}</dd>
            </dl>
        </div>
    </InfoHint>
</template>
