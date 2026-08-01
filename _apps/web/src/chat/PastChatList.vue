<script setup lang="ts">
import { relativeTime } from "../composables/chat/catalog";
import type { ChatSession } from "../composables/chat/useChat";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";

/* THE PAST-CHATS LIST — the sandbox's stored sessions, as rows you can reopen. One body, two hosts: the
 * desktop strip raises it in an <AnchoredOverlay> under the history button, the mobile strip in a
 * <BottomSheet>. That split is the pattern the design system's own Picker already uses (one PickerPanel,
 * a Popover on desktop and a sheet on touch); these two strips had instead each written the list out.
 *
 * Which mattered, because the row is not trivial: it carries the derived title, who else has the session open
 * right now, the SNIPPET explaining why a search matched — the line of the user's own prompt the query hit,
 * shown only when the title isn't the match — and the relative time. Two copies meant two places for the
 * snippet rule to drift, and both files carried a comment insisting the two boxes must not come to mean
 * different things. Now they cannot.
 *
 * `touch` is the only difference left, and it is a real one rather than a style preference: a thumb needs a
 * 48px row and a `:active` tint (there is no hover to give it), where a pointer wants a dense row that
 * responds on hover. It is a prop rather than a `useDevice` read because the HOST already knows — the two
 * strips are mutually exclusive by device — and a list that consulted a global could disagree with the
 * component that mounted it. */

defineProps<{ sessions: readonly ChatSession[]; query: string; touch?: boolean }>();
const emit = defineEmits<{ open: [id: string] }>();
</script>

<template>
    <template v-if="sessions.length > 0">
        <button
            v-for="session in sessions"
            :key="session.id"
            type="button"
            class="ui-row-select flex flex-col gap-0.5 text-left"
            :class="touch ? `min-h-12 justify-center rounded-lg px-2 py-1.5` : `rounded-md px-2 py-1.5`"
            @click="emit(`open`, session.id)"
        >
            <span class="flex items-center gap-1.5">
                <span class="min-w-0 flex-1 truncate text-content" :class="touch ? `text-sm` : `text-xs`">{{ session.title }}</span>
                <!-- Members with this session open right now. -->
                <PresenceAvatars :members="viewersOfSession(session.id)" label="in this chat" />
            </span>
            <!-- Why this row matched, when it wasn't the title: the line of the user's own prompt the query
                 hit. Absent on an unfiltered list and on a title match, so it never repeats the row above it. -->
            <span v-if="session.snippet !== undefined" class="line-clamp-2 text-2xs italic text-muted">{{ session.snippet }}</span>
            <span class="text-2xs text-subtle">{{ relativeTime(session.updatedAt) }}</span>
        </button>
    </template>
    <!-- "No matching chats" and "no chats" are different facts, and the query is what tells them apart. -->
    <p v-else class="px-2 py-3 text-center text-2xs text-subtle">{{ query ? "No matching chats." : "No previous chats." }}</p>
</template>
