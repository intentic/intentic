<script setup lang="ts">
import { relativeTime } from "../models/catalog";
import type { ChatSession } from "../run/useChat-sessions";
import MatchLine from "../../../components/MatchLine.vue";
import { viewersOfSession } from "../../../shell/presence/usePresence";
import PresenceAvatars from "../../../shell/presence/PresenceAvatars.vue";

// The past-chats list, stored sessions as reopenable rows. One body, two hosts (desktop AnchoredOverlay, mobile
// BottomSheet), so the title/presence/snippet/time rule lives once instead of drifting between two copies. `touch`
// is a real difference (a 48px row with an `:active` tint vs. a dense hover row), passed as a prop since the
// mounting strip already knows its own device.

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
            <!--
                Why this row matched, when it wasn't the title: the line the query hit and which side said it. Absent on an
                unfiltered list or a title match, so it never repeats the row above.
            -->
            <MatchLine
                v-if="session.snippet !== undefined"
                :snippet="session.snippet"
                :needle="query.trim().toLowerCase()"
                class="line-clamp-2 text-2xs text-muted"
            />
            <span class="text-2xs text-subtle">{{ relativeTime(session.updatedAt) }}</span>
        </button>
    </template>
    <!-- "No matching chats" and "no chats" are different facts, and the query is what tells them apart. -->
    <p v-else class="px-2 py-3 text-center text-2xs text-subtle">{{ query ? "No matching chats." : "No previous chats." }}</p>
</template>
