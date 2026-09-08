<script setup lang="ts">
import { Avatar } from "@intentic/ui";
import { computed } from "vue";
import { identityHue } from "../../lib/identityHue";
import { type PresenceMember, presenceActivity } from "./usePresence";

// Co-presence roster, unified into one component (was PresenceAvatars + PresenceStack) with an axis instead of
// two files:
//
// 1. column, 28px — the rail's live roster under the sandbox switcher
// 2. row, 16px — who's on this file-tree row or chat session
//
// Renders nothing when empty; callers pass `presenceOthers` (never themselves), so empty means alone.

const {
    members,
    direction = `row`,
    size = 16,
    label,
} = defineProps<{
    members: readonly PresenceMember[];
    direction?: `row` | `column`;
    size?: number;
    // What the roster is of ("viewing this file"); the rail leaves it out since there's nothing single to name.
    label?: string;
}>();

const MAX_AVATARS = 3;
const shown = computed(() => members.slice(0, MAX_AVATARS));
const overflow = computed(() => members.length - shown.value.length);

const nameOf = (member: PresenceMember): string => member.name ?? member.email;
// Per-avatar, so a stack of three still answers "who is that one", not just "who is here".
const tooltipFor = (member: PresenceMember): string =>
    label === undefined ? `${nameOf(member)}, ${presenceActivity(member)}${member.idle ? ` · away` : ``}` : `${nameOf(member)}, ${label}`;
const overflowNames = computed(() => members.slice(MAX_AVATARS).map(nameOf).join(`, `));
</script>

<template>
    <span
        v-if="shown.length > 0"
        class="inline-flex shrink-0"
        :class="direction === `column` ? `flex-col items-center -space-y-1.5` : `items-center -space-x-1`"
    >
        <Avatar
            v-for="member in shown"
            :key="member.email"
            :size="size"
            :name="nameOf(member)"
            :src="member.picture"
            :hue="identityHue(member.email)"
            :idle="member.idle"
            :ring="size >= 24 ? 2 : 1"
            v-tooltip="tooltipFor(member)"
        />
        <!-- Neutral chrome, never a member's hue: the count stands for several people, not one. -->
        <span
            v-if="overflow > 0"
            class="flex shrink-0 items-center justify-center font-semibold text-muted"
            :class="direction === `column` ? `rounded-full bg-overlay ring-2 ring-card` : `pl-1.5`"
            :style="
                direction === `column`
                    ? { width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(7, size * 0.375)}px` }
                    : { fontSize: `${Math.max(7, size * 0.375)}px` }
            "
            v-tooltip="overflowNames"
            >+{{ overflow }}</span
        >
    </span>
</template>
