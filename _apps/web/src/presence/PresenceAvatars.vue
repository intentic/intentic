<script setup lang="ts">
import { computed } from "vue";
import { type PresenceMember, presenceHue, presenceInitials } from "../composables/usePresence";

/* Inline mini-avatar row for co-presence on a specific thing (a file-tree row, the viewer breadcrumb, a chat
 * session): the members currently viewing it, at 16px. Renders nothing when no one else is there. */

const props = defineProps<{
    viewers: readonly PresenceMember[];
    // Tooltip context, e.g. "viewing this file" — prefixed with the member names.
    label?: string;
}>();

const MAX_AVATARS = 3;
const shown = computed(() => props.viewers.slice(0, MAX_AVATARS));
const overflow = computed(() => props.viewers.length - shown.value.length);
const tooltip = computed(() => {
    const names = props.viewers.map((member) => member.name ?? member.email).join(`, `);
    return props.label === undefined ? names : `${names} — ${props.label}`;
});

// A dead picture URL degrades to the initials rendered underneath it.
const hideBrokenImage = (event: Event): void => {
    (event.target as HTMLImageElement).style.display = `none`;
};
</script>

<template>
    <span v-if="shown.length > 0" class="inline-flex shrink-0 items-center -space-x-1" v-tooltip.bottom="tooltip">
        <span
            v-for="member in shown"
            :key="member.email"
            class="relative flex h-4 w-4 items-center justify-center overflow-hidden rounded-full ring-1 ring-card"
            :class="{ 'opacity-50 grayscale': member.idle }"
            :style="{ backgroundColor: `hsl(${presenceHue(member.email)} 55% 42%)` }"
        >
            <span class="text-[0.45rem] font-semibold leading-none text-white">{{ presenceInitials(member) }}</span>
            <img
                v-if="member.picture"
                :src="member.picture"
                alt=""
                referrerpolicy="no-referrer"
                class="absolute inset-0 h-full w-full object-cover"
                @error="hideBrokenImage"
            />
        </span>
        <span v-if="overflow > 0" class="pl-1.5 text-[0.6rem] font-medium text-muted">+{{ overflow }}</span>
    </span>
</template>
