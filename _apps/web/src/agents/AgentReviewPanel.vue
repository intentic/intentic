<script setup lang="ts">
import { useDevice } from "@intentic-app/ui";
import type { GitChange } from "@intentic-app/api-contract";
import { computed, ref, toRef } from "vue";
import { useRouter } from "vue-router";
import { useAgentChanges } from "../composables/agents/useAgentChanges";
import { useChat } from "../composables/chat/useChat";
import { useWorkspaceTabs } from "../composables/workspace/useWorkspaceTabs";
import { STATUS_CLASS, STATUS_LETTER } from "../pages/workspace/workspaceTabs";

/* One agent's isolated review: the worktree's cumulative delta vs its bases, grouped by repo — read-only rows
 * (no per-file selection: an agent's work lands or is discarded whole; cherry-picking is the MAIN review's
 * job after a land) — plus the Land / Discard action bar and the conflict report. Diffs open through the
 * workspace tab machinery, same as the Changes panel. */

const props = defineProps<{ agentId: string }>();
const router = useRouter();
const { mobile } = useDevice();
const changes = useAgentChanges(toRef(props, `agentId`));
const { openDiff, activeId } = useWorkspaceTabs();

// Land/discard while the agent is streaming is refused daemon-side (CONFLICT); disable up front when this
// browser is the one streaming.
const { conversations } = useChat();
const streaming = computed(() => conversations.value.find((c) => c.conversationId === props.agentId)?.streaming.value === true);

const changeLabel = (repo: string, change: GitChange): string => (repo === `root` ? change.path : `${repo}/${change.path}`);

const showDiff = (repo: string, change: GitChange): void => {
    void changes.fileDiff(repo, change.path).then((body) => {
        openDiff({
            key: `agent:${props.agentId}:${repo}`,
            scope: repo,
            label: changeLabel(repo, change),
            status: change.status,
            path: change.path,
            ...body,
        });
        // Desktop: the diff tab renders in the workspace main area; mobile: the workspace route's ?diff=
        // full-screen viewer (the WorkspaceMobile pattern).
        void router.push(mobile.value ? { name: `workspace`, params: { path: [] }, query: { diff: activeId.value ?? undefined } } : { name: `workspace` });
    });
};

const pendingDiscard = ref(false);
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <p v-if="changes.error.value" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.bottom="changes.error.value">
            {{ changes.error.value }}
        </p>
        <p v-if="changes.actionError.value" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.bottom="changes.actionError.value">
            {{ changes.actionError.value }}
        </p>

        <!-- Land / Discard bar -->
        <div class="flex shrink-0 flex-col gap-1.5 border-b border-line p-2">
            <div class="flex items-center gap-2">
                <span class="text-2xs text-muted">{{ changes.count.value }} change{{ changes.count.value === 1 ? "" : "s" }} vs base</span>
                <Icon name="spinner" v-if="changes.actionBusy.value" class="text-xs text-muted" spin />
                <span class="flex-1"></span>
                <button
                    type="button"
                    class="inline-flex items-center whitespace-nowrap rounded border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40"
                    :disabled="changes.actionBusy.value || streaming"
                    @click="pendingDiscard = true"
                    v-tooltip.top="'Drop this agent\'s branch and worktree'"
                >
                    <Icon name="trash" class="mr-1 text-2xs" />Discard
                </button>
                <button
                    type="button"
                    class="inline-flex items-center whitespace-nowrap rounded-md bg-success px-2.5 py-1 text-2xs font-medium text-white transition-colors hover:bg-success/85 disabled:opacity-40"
                    :disabled="changes.actionBusy.value || streaming || changes.count.value === 0"
                    @click="changes.land()"
                    v-tooltip.top="streaming ? 'Wait for the agent turn to finish' : 'Merge this agent\'s work into your workspace'"
                >
                    <Icon name="check" class="mr-1 text-2xs" />Land
                </button>
            </div>
            <div v-if="pendingDiscard" class="flex items-center gap-2">
                <span class="flex-1 text-2xs text-warning">Discard this agent's work? Its branch and worktree are deleted.</span>
                <button type="button" class="text-2xs text-muted hover:text-content" @click="pendingDiscard = false">Cancel</button>
                <button
                    type="button"
                    class="rounded border border-danger/50 px-2 py-0.5 text-2xs text-danger transition-colors hover:bg-danger/10"
                    :disabled="changes.actionBusy.value"
                    @click="pendingDiscard = false; void changes.discard()"
                >
                    Discard
                </button>
            </div>
            <!-- Conflict report from the last land attempt: the merge was aborted, nothing lost — resolve the
                 named paths in your workspace (or discard the agent) and land again. -->
            <div v-if="changes.conflicts.value !== undefined && changes.conflicts.value.length > 0" class="flex flex-col gap-1">
                <span class="text-2xs font-medium text-warning">Land conflicts — your workspace's copy of these paths differs:</span>
                <div v-for="conflict in changes.conflicts.value" :key="conflict.repo" class="text-2xs text-muted">
                    <span class="font-medium">{{ conflict.repo }}</span
                    >:
                    <span class="font-mono">{{ conflict.paths.length > 0 ? conflict.paths.join(", ") : "(repo unavailable)" }}</span>
                </div>
            </div>
        </div>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
            <p v-if="changes.loading.value && changes.count.value === 0" class="px-3 py-2 text-2xs text-subtle">Loading the agent's diff…</p>
            <p v-else-if="changes.count.value === 0" class="px-3 py-2 text-2xs text-subtle">
                No changes vs base yet — the agent hasn't edited anything (or its work was already landed).
            </p>
            <div v-for="group in changes.repos.value" :key="group.repo" class="border-b border-line/50">
                <div class="flex items-center gap-2 px-3 py-1.5">
                    <span class="truncate text-xs font-medium text-content">{{ group.repo }}</span>
                    <span v-if="group.branch !== undefined" class="truncate font-mono text-2xs text-subtle">{{ group.branch }}</span>
                    <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ group.changes.length }}</span>
                </div>
                <button
                    v-for="change in group.changes"
                    :key="`${group.repo}/${change.path}`"
                    type="button"
                    class="flex w-full min-w-0 items-center gap-1.5 px-3 py-0.5 text-left transition-colors hover:bg-overlay max-md:min-h-11"
                    @click="showDiff(group.repo, change)"
                    :title="changeLabel(group.repo, change)"
                >
                    <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[change.status]">{{
                        STATUS_LETTER[change.status]
                    }}</span>
                    <span class="truncate text-2xs text-muted max-md:text-xs" dir="rtl">{{ change.path }}</span>
                </button>
            </div>
        </div>
    </div>
</template>
