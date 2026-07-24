<!-- One row inside a <RowGroup>: a leading icon, a title + description, and a trailing #control (toggle,
     segmented, button, badge). #below drops full-width content beneath the header on the SAME row — a live
     preview, an expanded sub-form — so it stays inside the row's hairline boundary instead of spawning its
     own boxed inset. Set `as="label"` so a wrapped control toggles on a full-row click; set `interactive`
     (+ `chevron`) or `href` for navigational rows. Purely presentational — no router dependency, so
     internal-nav rows wrap this in the app's <RouterLink class="block">. -->
<script setup lang="ts">
import { type IconName } from "../icons/iconSets.js";
import Icon from "./Icon.vue";

const {
    as = `div`,
    interactive = false,
    chevron = false,
    tone = `default`,
} = defineProps<{
    icon?: IconName;
    title?: string;
    description?: string;
    href?: string;
    as?: `div` | `label`;
    interactive?: boolean;
    chevron?: boolean;
    tone?: `default` | `danger`;
}>();
</script>

<template>
    <component
        :is="href !== undefined ? `a` : as"
        :href="href"
        :target="href !== undefined ? `_blank` : undefined"
        :rel="href !== undefined ? `noopener` : undefined"
        class="block px-4 py-3"
        :class="interactive || href !== undefined || as === `label` ? `cursor-pointer transition-colors hover:bg-content/5` : ``"
    >
        <div class="flex items-center justify-between gap-4">
            <div class="flex min-w-0 items-center gap-2.5">
                <Icon v-if="icon !== undefined" :name="icon" class="text-lg" :class="tone === `danger` ? `text-danger` : `text-muted`" />
                <div class="min-w-0">
                    <div v-if="title !== undefined || $slots[`title`]" class="font-semibold leading-tight text-content">
                        <slot name="title">{{ title }}</slot>
                    </div>
                    <p v-if="description !== undefined || $slots[`description`]" class="text-xs text-muted">
                        <slot name="description">{{ description }}</slot>
                    </p>
                </div>
            </div>
            <div v-if="$slots[`control`] || chevron || href !== undefined" class="flex shrink-0 items-center gap-2">
                <slot name="control" />
                <Icon v-if="chevron || href !== undefined" name="chevron-right" class="text-2xs text-subtle" />
            </div>
        </div>
        <div v-if="$slots[`below`]" class="mt-3">
            <slot name="below" />
        </div>
    </component>
</template>
