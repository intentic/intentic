<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import Icon from "@intentic/ui/icon";
import type { IconName } from "@intentic/ui";
import { computed } from "vue";
import { badgeChip, badgeClass, badgeText } from "./viewBadge";

/* Count chips are shared by navigation, runtime, mobile, and sandbox surfaces. */

const { badge } = defineProps<{ badge?: ViewBadge | undefined }>();

// The badge only while it has a chip to draw: `v-if` on the value, so the template narrows and the leave
// transition gets a falsy toggle rather than a changed prop.
const shown = computed<ViewBadge | undefined>(() => (badge !== undefined && badgeChip(badge) ? badge : undefined));
</script>

<template>
<!-- Motion, and the reduced-motion answer for it, live on `.ui-badge` in the design system's utilities.css. -->
    <Transition name="ui-badge" appear>
        <span
            v-if="shown"
            class="ui-badge inline-flex min-w-4 items-center justify-center rounded-full px-1 text-center font-semibold leading-4"
            :class="badgeClass(shown)"
        >
<!-- A mark REPLACES the number rather than sitting beside it: the chip is four pixels of glance. -->
            <Icon v-if="shown.mark !== undefined" :name="shown.mark as IconName" />
            <template v-else>{{ badgeText(shown) }}</template>
        </span>
    </Transition>
</template>
