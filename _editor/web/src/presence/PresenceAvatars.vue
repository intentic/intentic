<script setup lang="ts">
import { Avatar } from "@intentic/ui";
import { computed } from "vue";
import { identityHue } from "../composables/identityHue";
import { type PresenceMember, presenceActivity } from "../composables/usePresence";

/* WHO ELSE IS HERE: the app's one co-presence roster, in both the shapes it is needed in.
 *
 * This was two components (`PresenceAvatars` and `PresenceStack`) that had the same body: take up to three
 * members, overlap their avatars, hang a "+N" off the end, name everyone in a tooltip. They differed in size,
 * in whether they ran down or across, and in nothing else: including a character-identical copy of the
 * broken-image handler, comment and all. So they are one component with an axis, and the two call shapes are
 * two prop sets rather than two files:
 *
 *   column · 28px  the rail's live roster under the sandbox switcher (was PresenceStack)
 *   row    · 16px  who is on THIS thing: a file-tree row, a chat session (was PresenceAvatars)
 *
 * Renders nothing when the list is empty, which is what keeps a solo user's screen free of presence chrome:
 * the callers pass `presenceOthers` (never themselves), so "empty" and "alone" are the same state. */

const {
    members,
    direction = `row`,
    size = 16,
    label,
} = defineProps<{
    members: readonly PresenceMember[];
    direction?: `row` | `column`;
    size?: number;
    /* What the roster is a roster OF ("viewing this file", "in this chat"), appended to the names. The rail's
     * roster leaves it out and lets each member's own activity speak instead: it is the whole sandbox, so
     * there is no one thing to name. */
    label?: string;
}>();

const MAX_AVATARS = 3;
const shown = computed(() => members.slice(0, MAX_AVATARS));
const overflow = computed(() => members.length - shown.value.length);

const nameOf = (member: PresenceMember): string => member.name ?? member.email;
// Per-avatar, so a stack of three answers "who is that one" rather than only "who is here".
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
        <!-- The tail count wears the neutral chrome, never a member's hue: it stands for several people, and
             borrowing one of their colours would say it stands for that one. -->
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
