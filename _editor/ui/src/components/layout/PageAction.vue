<!--
    The one control allowed in <PageHeader #actions>: a labelled button for an action that commits something (`primary` marks the page's one call to
    action), or a quiet icon-only button for one that doesn't (Refresh, a link). `hint` is the why, not the what; `href` renders an anchor carrying
    the destination's own icon.
-->

<script setup lang="ts">
import Button from "../primitives/Button.vue";
import { computed } from "vue";
import { ui } from "../../lib/ui.js";
import Icon from "../primitives/Icon.vue";
import type { IconName } from "../../icons/iconSets.js";

// `primary` lives only in the non-link half: a link is never the call to action, so this is a type error.
const { href, hint, label, quiet } = defineProps<
    {
        // What the action does, imperative; on a quiet control it's the tooltip and accessible name, not a word.
        label: string;
        // On a link, the destination's own mark (GitHub's mark for GitHub, etc.), not a generic arrow.
        icon: IconName;
        // What the label has no room for. Absent is the common case: a self-explaining action earns no tooltip.
        hint?: string;
        disabled?: boolean;
    } & (
        | {
              // Draw the icon alone. Implied by `href`, since leaving is never the loud thing a page does.
              quiet?: boolean;
              // The page's one call to action; everything else is secondary.
              primary?: boolean;
              href?: never;
          }
        // Leaves the app; opens in a new tab since the page behind it is the one the user is working in.
        | { href: string; quiet?: never; primary?: never }
    )
>();

const iconOnly = computed(() => quiet === true || href !== undefined);
// With no visible label the tooltip carries both halves, because it is the only place either one is said.
const tooltip = computed(() => {
    if (!iconOnly.value) {
        return hint;
    }
    return hint === undefined ? label : `${label}, ${hint}`;
});
</script>

<template>
    <component
        :is="href === undefined ? `button` : `a`"
        v-if="iconOnly"
        :type="href === undefined ? `button` : undefined"
        :class="ui.iconButton(`h-8 w-8 text-base disabled:pointer-events-none`)"
        :disabled="disabled"
        :aria-label="label"
        v-tooltip.bottom="tooltip"
        :href="href"
        :target="href === undefined ? undefined : `_blank`"
        :rel="href === undefined ? undefined : `noopener`"
    >
        <Icon :name="icon" />
    </component>
    <Button v-else :label="label" size="small" :severity="primary ? undefined : `secondary`" :disabled="disabled" v-tooltip.bottom="tooltip">
        <template #icon><Icon :name="icon" /></template>
    </Button>
</template>
