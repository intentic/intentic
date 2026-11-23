<script setup lang="ts">
import type { ChatSession } from "../../../models/conversations/run/useChat-sessions";
import MatchLine from "../../../components/MatchLine.vue";
import { viewersOfSession } from "../../../workbench/presence/usePresence";
import PresenceAvatars from "../../../workbench/presence/PresenceAvatars.vue";
import { useT } from "@intentic/ui/i18n";
import { timeAgo } from "@intentic/ui";

// The past-chats list, stored sessions as reopenable rows. One body, two hosts (desktop AnchoredOverlay, mobile
// BottomSheet), so the title/presence/snippet/time rule lives once instead of drifting between two copies. `touch`
// is a real difference (a 48px row with an `:active` tint vs. a dense hover row), passed as a prop since the
// mounting strip already knows its own device.

const t = useT();

// `failure`: why the last read failed; it replaces the rows, which answer an earlier question if any.
defineProps<{ sessions: readonly ChatSession[]; query: string; failure?: string | undefined; touch?: boolean }>();
const emit = defineEmits<{ open: [id: string] }>();
</script>

<template>
    <p v-if="failure !== undefined" role="alert" class="px-2 py-3 text-center text-2xs text-danger">{{ failure }}</p>
    <template v-else-if="sessions.length > 0">
        <button
            v-for="session in sessions"
            :key="session.id"
            type="button"
            class="ui-row-select flex flex-col gap-0.5 text-left"
            :class="touch ? `min-h-12 justify-center rounded-lg px-2 py-1.5` : `rounded-lg py-1.5 pr-2.5 pl-10.5`"
            @click="emit(`open`, session.id)"
        >
            <!-- On a pointer the row is inset to an open chat's title (the switcher's rows: 10px of padding, a 24px mark, an
                 8px gap), so every title in the sheet starts on one line. -->
            <!-- On a pointer the age ends the title's own line, as an open chat's does above it in the switcher: one line a row,
                 read down the left and dated down the right. A thumb's row has the height, so the age keeps a line there. -->
            <span class="flex items-center gap-1.5">
                <span class="min-w-0 flex-1 truncate text-content" :class="touch ? `text-sm` : `text-xs`">{{ session.title }}</span>
                <!-- Members with this session open right now. -->
                <PresenceAvatars :members="viewersOfSession(session.id)" :label="t(`chat.words.inChat`)" />
                <span v-if="!touch" class="shrink-0 text-2xs text-subtle">{{ timeAgo(session.updatedAt, { days: true }) }}</span>
            </span>
            <!-- Why this row matched, when it wasn't the title: the line the query hit and which side said it. -->
            <MatchLine
                v-if="session.snippet !== undefined"
                :snippet="session.snippet"
                :needle="query.trim().toLowerCase()"
                class="line-clamp-2 text-2xs text-muted"
            />
            <span v-if="touch" class="text-2xs text-subtle">{{ timeAgo(session.updatedAt, { days: true }) }}</span>
        </button>
    </template>
    <!-- "No matching chats" and "no chats" are different facts, and the query is what tells them apart. -->
    <p v-else class="px-2 py-3 text-center text-2xs text-subtle">
        {{ query ? t(`chat.pastChatList.noMatchingChats`) : t(`chat.pastChatList.noPreviousChats`) }}
    </p>
</template>
