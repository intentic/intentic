<!-- The centred block a surface shows in place of its content: nothing here yet, a read that failed, a wait. -->
<script lang="ts">
import { tv } from "tailwind-variants";
import { toneInk } from "../../lib/tone.js";

export type EmptyStateSize = `panel` | `page`;
export type EmptyStateTone = `neutral` | `danger`;

// `panel`: a pane, a tab, an overlay inside a region the shell framed. `page`: the whole of a page or a viewer,
// read first and from further away, so it speaks a step louder. The fill (flex-1, h-full, absolute inset-0) is the
// caller's, since it depends on the box around it.
const block = tv({
    slots: {
        root: `flex flex-col items-center justify-center px-6 text-center`,
        icon: ``,
        text: `flex flex-col items-center`,
        title: ``,
        line: ``,
    },
    variants: {
        size: {
            panel: { root: `gap-2`, icon: `text-2xl`, text: `gap-2`, title: `text-sm`, line: `max-w-sm text-2xs text-subtle` },
            page: { root: `gap-3`, icon: `text-4xl`, text: `gap-1.5`, title: `text-base font-semibold`, line: `max-w-md text-xs text-muted` },
        },
        tone: {
            neutral: { icon: `text-subtle` },
            danger: { icon: toneInk(`danger`), title: toneInk(`danger`) },
        },
    },
    // A neutral title is muted in a panel and the content colour on a page, where it is the headline.
    compoundVariants: [
        { tone: `neutral`, size: `panel`, class: { title: `text-muted` } },
        { tone: `neutral`, size: `page`, class: { title: `text-content` } },
    ],
    defaultVariants: { size: `panel`, tone: `neutral` },
});
</script>

<script setup lang="ts">
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

// twMerge (through the recipe) so a caller's class overrides the block's own rather than racing it in the stylesheet.
defineOptions({ inheritAttrs: false });
const slots = defineSlots<{
    icon?: () => unknown;
    title?: () => unknown;
    line?: () => unknown;
    actions?: () => unknown;
    default?: () => unknown;
}>();
const attrs = useAttrs();
const look = computed(() => block({ size, tone }));
const rootClass = (): string => look.value.root({ class: attrs[`class`] as string | undefined });
const shownIcon = computed(() => icon ?? (tone === `danger` ? `exclamation-triangle` : undefined));
</script>

<template>
    <div v-bind="{ ...attrs, class: undefined }" :class="rootClass()">
        <slot name="icon">
            <Icon v-if="shownIcon !== undefined" :name="shownIcon" :spin="spin" :class="look.icon()" aria-hidden="true" />
        </slot>
        <div v-if="title !== `` || line !== `` || slots.title || slots.line" :class="look.text()">
            <div v-if="title !== `` || slots.title" :class="look.title()">
                <slot name="title">{{ title }}</slot>
            </div>
            <div v-if="line !== `` || slots.line" :class="look.line()">
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
