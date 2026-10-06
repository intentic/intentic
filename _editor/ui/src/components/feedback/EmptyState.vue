<!-- The centred block a surface shows in place of its content: nothing here yet, a read that failed, a wait. -->
<script lang="ts">
export type EmptyStateSize = `panel` | `page`;
export type EmptyStateTone = `neutral` | `danger`;

// `panel`: a pane, a tab, an overlay inside a region the shell framed. `page`: the whole of a page or a viewer,
// read first and from further away, so it speaks a step louder.
const ROOT: Record<EmptyStateSize, string> = {
    panel: `gap-2`,
    page: `gap-3`,
};
const ICON: Record<EmptyStateSize, string> = {
    panel: `text-2xl`,
    page: `text-4xl`,
};
const TEXT: Record<EmptyStateSize, string> = {
    panel: `gap-2`,
    page: `gap-1.5`,
};
const TITLE: Record<EmptyStateTone, Record<EmptyStateSize, string>> = {
    neutral: { panel: `text-sm text-muted`, page: `text-base font-semibold text-content` },
    danger: { panel: `text-sm text-danger`, page: `text-base font-semibold text-danger` },
};
const LINE: Record<EmptyStateSize, string> = {
    panel: `max-w-sm text-2xs text-subtle`,
    page: `max-w-md text-xs text-muted`,
};
</script>

<script setup lang="ts">
import { twMerge } from "tailwind-merge";
import { computed, useAttrs } from "vue";
import type { IconName } from "../../icons/iconSets.js";
import Icon from "../primitives/Icon.vue";

const {
    icon,
    spin = false,
    title = ``,
    line = ``,
    size = `panel`,
    tone = `neutral`,
} = defineProps<{
    // A failure without an icon of its own gets the warning glyph; anything else draws none unless given one.
    icon?: IconName;
    spin?: boolean;
    // What happened, in one sentence; `#title` for one that carries markup (a path in mono, an i18n-t).
    title?: string;
    // What to do about it, or why; `#line` for markup.
    line?: string;
    size?: EmptyStateSize;
    tone?: EmptyStateTone;
}>();

// The fill (flex-1, h-full, absolute inset-0) is the caller's, since it depends on the box around it; twMerge so a
// caller's class overrides the block's own rather than racing it in the stylesheet.
defineOptions({ inheritAttrs: false });
const slots = defineSlots<{
    icon?: () => unknown;
    title?: () => unknown;
    line?: () => unknown;
    actions?: () => unknown;
    default?: () => unknown;
}>();
const attrs = useAttrs();
const rootClass = (): string =>
    twMerge(`flex flex-col items-center justify-center px-6 text-center`, ROOT[size], attrs[`class`] as string | undefined);
const shownIcon = computed(() => icon ?? (tone === `danger` ? `exclamation-triangle` : undefined));
</script>

<template>
    <div v-bind="{ ...attrs, class: undefined }" :class="rootClass()">
        <slot name="icon">
            <Icon
                v-if="shownIcon !== undefined"
                :name="shownIcon"
                :spin="spin"
                :class="[ICON[size], tone === `danger` ? `text-danger` : `text-subtle`]"
                aria-hidden="true"
            />
        </slot>
        <div v-if="title !== `` || line !== `` || slots.title || slots.line" class="flex flex-col items-center" :class="TEXT[size]">
            <div v-if="title !== `` || slots.title" :class="TITLE[tone][size]">
                <slot name="title">{{ title }}</slot>
            </div>
            <div v-if="line !== `` || slots.line" :class="LINE[size]">
                <slot name="line">{{ line }}</slot>
            </div>
        </div>
        <div v-if="slots.actions" class="mt-1 flex flex-wrap items-center justify-center gap-2">
            <slot name="actions" />
        </div>
        <!-- Anything the block holds besides its sentences and its way out: a list to pick from, a note under the buttons. -->
        <slot />
    </div>
</template>
