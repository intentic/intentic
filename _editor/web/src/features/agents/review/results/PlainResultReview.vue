<script setup lang="ts">
import { deliverableKindOf } from "@intentic/sandbox-contract";
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, provide, ref, watch } from "vue";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { CHAT_SURFACE } from "../../../chat/tools/chatToolSurface";
import ChatTurnDeliverables from "../../../chat/transcript/deliverables/ChatTurnDeliverables.vue";
import type { ChatDeliverable } from "../../../chat/transcript/deliverables/deliverables";
import type { useAgentChanges } from "../useAgentChanges";

// The review in plain words (AgentReviewPanel's place for a reader who does not write code): what the conversation
// made, first, as the documents its calls recorded writing, each to open, download or print right here; then, folded
// away, the names of whatever else it changed. No branch, no status letters, no line counts, no diff: the Accept above
// says in a sentence what accepting does (AgentLandPress).

// Only what it reads of the review's state: the changed files by name, and what went wrong reading or landing them.
const props = defineProps<{ agentId: string; at?: string; changes: Pick<ReturnType<typeof useAgentChanges>, `count` | `files` | `error` | `conflicts`> }>();
const t = useT();

// The chips open each document over this page rather than in Files, through the conversation's own results.
provide(CHAT_SURFACE, { imageUrl: () => undefined, resultConversation: () => props.agentId, resultBox: () => props.at });

const paths = ref<readonly string[]>([]);
const failed = ref(false);
// Bumped per read, so a slow answer for an earlier conversation never lands on this one.
let generation = 0;
// Read again whenever the change count moves: a turn that wrote another document changed a file too.
watch(
    () => [props.agentId, props.at, props.changes.count.value],
    async () => {
        const current = ++generation;
        failed.value = false;
        try {
            const { paths: recorded } = await sandboxRpc.agents.documents({ id: props.agentId }, { context: { at: props.at } });
            if (current === generation) {
                paths.value = recorded;
            }
        } catch {
            if (current === generation) {
                failed.value = true;
            }
        }
    },
    { immediate: true },
);

const documents = computed<readonly ChatDeliverable[]>(() =>
    paths.value.flatMap((path) => {
        const kind = deliverableKindOf(path);
        return kind === undefined ? [] : [{ path, kind, turnId: 0 }];
    }),
);
// Everything else it changed, by name; a document listed above is not named twice.
const others = computed(() => {
    const listed = new Set(paths.value);
    return props.changes.files.value.filter((file) => !listed.has(file.label));
});
</script>

<template>
    <section class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
        <h2 class="text-sm font-medium text-content">{{ t(`workspace.results.heading`) }}</h2>
        <Notice v-if="failed" tone="danger" size="sm">{{ t(`workspace.results.listFailed`) }}</Notice>
        <ChatTurnDeliverables v-if="documents.length > 0" :deliverables="documents" :label="t(`workspace.results.heading`)" class="!px-0" />
        <p v-else-if="!failed" class="text-sm text-muted">{{ t(`workspace.results.noDocuments`) }}</p>
        <Notice v-if="changes.error.value" tone="danger" size="sm">{{ changes.error.value }}</Notice>
        <Notice v-if="(changes.conflicts.value?.length ?? 0) > 0" tone="warning" size="sm">{{ t(`workspace.results.conflict`) }}</Notice>
        <details v-if="others.length > 0" class="rounded-md border border-line px-3 py-2">
            <summary class="cursor-pointer text-xs text-muted">{{ t(`workspace.results.otherChanges`, { count: others.length }, others.length) }}</summary>
            <ul class="mt-2 space-y-1 text-xs text-muted">
                <li v-for="file in others" :key="file.key" class="truncate" v-tooltip.top="file.label">{{ file.label }}</li>
            </ul>
        </details>
    </section>
</template>
