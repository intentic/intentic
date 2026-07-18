<script setup lang="ts">
import { Segmented, useDevice } from "@intentic-app/ui";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChatPanel from "../chat/ChatPanel.vue";
import { createTitleEdit } from "../composables/agents/titleEdit";
import { useAgents } from "../composables/agents/useAgents";
import { useChat } from "../composables/chat/useChat";
import AgentReviewPanel from "./AgentReviewPanel.vue";

/* Drill-in for one agent (/agents/:id) — one canonical chat surface per form factor (the fleet-UX rule that
 * kills the duplicated-conversation problem):
 * - MOBILE: this IS the chat surface (no dock exists) — Chat | Changes segmented, chat default.
 * - DESKTOP: the conversation lives ONLY in the docked ChatPanel (focused by the binding below); this view is
 *   review-only — the isolated diff + Land/Discard, the one job the dock can't host. A draft/unknown id has
 *   nothing to review → back to the board. */

const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const { fleet, open, markSeen } = useAgents();
const { conversations, setActive } = useChat();

const agentId = computed(() => (typeof route.params[`id`] === `string` ? route.params[`id`] : ``));
const fleetAgent = computed(() => fleet.value.find((agent) => agent.id === agentId.value));
// Registered = has run a turn (a worktree + diff exist). Drafts are fleet-only client cards.
const registered = computed(() => fleetAgent.value !== undefined && fleetAgent.value.status !== `draft`);
const conversation = computed(() => conversations.value.find((candidate) => candidate.conversationId === agentId.value));

// Bind the shared chat singleton to this agent's tab: open/create from the fleet entry, else focus the
// already-open conversation. Desktop additionally requires a REGISTERED agent (there must be a diff to
// review); a draft or unknown id bounces back to the board. Keyed on the id + the roster SIZE, not the
// fleetAgent computed — its per-recompute object identity (and markSeen's write into the fleet source)
// would refire this watch forever.
watch(
    [agentId, () => fleet.value.length],
    ([id], [previousId] = [undefined, 0]) => {
        if (id === `` || (id === previousId && conversation.value !== undefined && (mobile.value || registered.value))) {
            return;
        }
        if (!mobile.value && !registered.value) {
            void router.replace(`/agents`);
            return;
        }
        if (fleetAgent.value !== undefined) {
            open(fleetAgent.value);
            return;
        }
        if (conversation.value !== undefined) {
            setActive(conversation.value.id);
            markSeen(id);
            return;
        }
        void router.replace(`/agents`);
    },
    { immediate: true },
);

// Mobile-only mode switch; desktop always renders the review.
const view = ref<`chat` | `changes`>(mobile.value ? `chat` : `changes`);
const viewOptions: { label: string; value: `chat` | `changes` }[] = [
    { label: `Chat`, value: `chat` },
    { label: `Changes`, value: `changes` },
];

const title = computed(() => fleetAgent.value?.title ?? conversation.value?.title.value ?? `Agent`);

const edit = createTitleEdit(
    () => agentId.value,
    () => fleetAgent.value?.title ?? conversation.value?.title.value ?? undefined,
);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
            <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="router.push('/agents')"
                aria-label="Back to agents"
            >
                <Icon name="arrow-left" class="text-sm" />
            </button>
            <input
                v-if="edit.editing"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                aria-label="Agent title"
                class="min-w-0 flex-1 rounded bg-overlay px-1 text-xs font-medium text-content outline-none ring-1 ring-primary-500/50"
                @keydown.enter.prevent="edit.commit()"
                @keydown.esc.prevent="edit.cancel()"
                @blur="edit.blurCommit()"
                @vue:mounted="edit.focusInput"
            />
            <template v-else>
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{ title }}</span>
                <button
                    type="button"
                    aria-label="Rename agent"
                    v-tooltip.bottom="'Rename'"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                    @click="edit.begin()"
                >
                    <Icon name="pencil" class="text-xs" />
                </button>
            </template>
            <span v-if="fleetAgent?.branch !== undefined" class="truncate font-mono text-2xs text-subtle">{{ fleetAgent.branch }}</span>
            <Segmented v-if="mobile" v-model="view" :options="viewOptions" />
            <span v-else class="text-2xs uppercase tracking-wide text-subtle">Review</span>
        </div>
        <p v-if="edit.error !== undefined" class="border-b border-line px-3 py-1 text-2xs text-danger">{{ edit.error }}</p>
        <ChatPanel v-if="mobile && view === 'chat'" class="min-h-0 flex-1" />
        <AgentReviewPanel v-else-if="agentId !== ''" :agent-id="agentId" class="min-h-0 flex-1" />
    </div>
</template>
