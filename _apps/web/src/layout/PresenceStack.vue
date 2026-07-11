<script setup lang="ts">
import { computed } from "vue";
import { type PresenceMember, presenceActivity, presenceHue, presenceInitials, presenceOthers } from "../composables/usePresence";

/* The rail's live roster: the OTHER members connected to this sandbox right now, stacked under the sandbox
 * switcher. Renders nothing while solo — a single user sees zero presence chrome. Up to three overlapping
 * avatars plus a "+N" chip; each tooltip names the member and what they're doing; idle (all tabs hidden)
 * renders dimmed + grayscale, never removed. */

const MAX_AVATARS = 3;
const shown = computed(() => presenceOthers.value.slice(0, MAX_AVATARS));
const overflow = computed(() => presenceOthers.value.length - shown.value.length);
const overflowNames = computed(() =>
    presenceOthers.value
        .slice(MAX_AVATARS)
        .map((member) => member.name ?? member.email)
        .join(`, `),
);

const tooltipFor = (member: PresenceMember): string => `${member.name ?? member.email} — ${presenceActivity(member)}${member.idle ? ` · away` : ``}`;

// A dead picture URL degrades to the initials rendered underneath it.
const hideBrokenImage = (event: Event): void => {
    (event.target as HTMLImageElement).style.display = `none`;
};
</script>

<template>
    <div v-if="shown.length > 0" class="flex flex-col items-center -space-y-1.5">
        <span
            v-for="member in shown"
            :key="member.email"
            class="relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-full ring-2 ring-card transition-opacity"
            :class="{ 'opacity-50 grayscale': member.idle }"
            :style="{ backgroundColor: `hsl(${presenceHue(member.email)} 55% 42%)` }"
            v-tooltip.right="tooltipFor(member)"
        >
            <span class="text-[0.6rem] font-semibold text-white">{{ presenceInitials(member) }}</span>
            <img
                v-if="member.picture"
                :src="member.picture"
                alt=""
                referrerpolicy="no-referrer"
                class="absolute inset-0 h-full w-full object-cover"
                @error="hideBrokenImage"
            />
        </span>
        <span
            v-if="overflow > 0"
            class="flex h-7 w-7 items-center justify-center rounded-full bg-overlay text-[0.6rem] font-semibold text-muted ring-2 ring-card"
            v-tooltip.right="overflowNames"
            >+{{ overflow }}</span
        >
    </div>
</template>
