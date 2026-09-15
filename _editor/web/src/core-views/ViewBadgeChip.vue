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
<!-- EVERY MEASURE IS AN `em` OF THE CHIP'S OWN TYPE, so a surface sets one font-size and the whole object follows
     it — box, padding, ring and glyph together. Sized in `rem` they drifted apart under the text-size setting,
     which is how a 16px plate ended up around a 9.6px number on a tile whose box does not scale at all. -->
        <span
            v-if="shown"
            class="ui-badge inline-flex h-[1.6em] min-w-[1.6em] items-center justify-center rounded-full px-[0.3em] font-semibold leading-none tabular-nums ring-2 ring-[color:var(--ui-tile-ground)]"
            :class="badgeClass(shown)"
        >
<!-- A mark REPLACES the number rather than sitting beside it: the chip is four pixels of glance. -->
            <Icon v-if="shown.mark !== undefined" :name="shown.mark as IconName" class="text-[0.9em]" />
            <template v-else>{{ badgeText(shown) }}</template>
        </span>
    </Transition>
</template>
