<!-- WHAT A HOME'S LAND WENT INTO HISTORY AS, after the row's sentence (models/home/homeCommits.ts): the commit's subject
     and short shas once its card files it, and for a maintainer the press that takes it back. The commit follows the row
     by the seconds its subject takes to draft, so until then the row says it is being written; a land older than the
     few the card keeps says nothing more than its sentence. -->
<script setup lang="ts">
import { ConfirmDialog, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watchEffect } from "vue";
import { useAudience } from "../../../../app/useAudience";
import { useRole } from "../../../../client/sandbox/useRole";
import { useAgents } from "../../../../models/fleet/useAgents";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { commitShas, homeCommitOf, landOfRow, type RevertRefusal, revertHomeCommit, reverted } from "../../../../models/home/homeCommits";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";

const { message } = defineProps<{ message: ChatMessage }>();

const t = useT();
const { conversation } = usePaneView();
const { agentById } = useAgents();
const { canShip } = useRole();
const { maker } = useAudience();

const commit = computed(() => homeCommitOf(agentById(conversation.value.conversationId), landOfRow(message)));

// How long a land's commit may take to be filed before the row stops saying it is coming: the draft is a model call
// (the daemon's perf `landing.subject`, 18 s at most), with room for a slow one.
const COMMIT_WAIT_MS = 120_000;
const lapsed = ref(true);
watchEffect((onCleanup) => {
    const left = message.openedAt === undefined ? 0 : message.openedAt + COMMIT_WAIT_MS - Date.now();
    lapsed.value = left <= 0;
    if (left > 0) {
        const timer = setTimeout(() => (lapsed.value = true), left);
        onCleanup(() => clearTimeout(timer));
    }
});
const writing = computed(() => commit.value === undefined && !lapsed.value);

const confirming = ref(false);
const reverting = ref(false);
const refused = ref<readonly RevertRefusal[]>([]);
const revert = async (): Promise<void> => {
    const landed = commit.value;
    if (reverting.value || landed === undefined) {
        return;
    }
    reverting.value = true;
    refused.value = await revertHomeCommit(landed, conversation.value.box.value);
    reverting.value = false;
    confirming.value = false;
};
const refusedLine = (refusal: RevertRefusal): string =>
    refusal.reason === ``
        ? t(`chat.noticeHomeCommit.revertFailed`, { repo: refusal.repo })
        : t(`chat.noticeHomeCommit.revertFailedWhy`, { repo: refusal.repo, reason: refusal.reason });
const count = computed(() => commit.value?.commits.length ?? 0);
</script>

<template>
    <template v-if="commit !== undefined">
        <span class="min-w-0 break-words text-muted"
            >{{ t(`chat.noticeHomeCommit.subject`, { subject: commit.subject })
            }}<template v-if="!maker">
                · <span class="font-mono">{{ commitShas(commit) }}</span></template
            ></span
        >
        <span v-if="reverted(commit)" class="shrink-0">{{
            maker ? t(`chat.noticeHomeCommit.plain.undone`) : t(`chat.noticeHomeCommit.reverted`)
        }}</span>
        <button v-else-if="canShip" type="button" class="touch-target shrink-0 font-medium text-link hover:underline" @click="confirming = true">
            {{ maker ? t(`chat.noticeHomeCommit.plain.undo`) : t(`chat.noticeHomeCommit.revert`) }}
        </button>
        <span v-for="refusal in refused" :key="refusal.repo" class="w-full text-warning">{{ refusedLine(refusal) }}</span>
        <ConfirmDialog
            :open="confirming"
            :header="maker ? t(`chat.noticeHomeCommit.plain.confirmHeader`) : t(`chat.noticeHomeCommit.confirmHeader`, { count }, count)"
            :description="maker ? t(`chat.noticeHomeCommit.plain.confirmBody`) : t(`chat.noticeHomeCommit.confirmBody`, { count }, count)"
            :confirm-label="maker ? t(`chat.noticeHomeCommit.plain.undo`) : t(`chat.noticeHomeCommit.revert`)"
            confirm-icon="undo"
            :loading="reverting"
            @cancel="confirming = false"
            @confirm="revert"
        />
    </template>
    <span v-else-if="writing" class="inline-flex shrink-0 items-center gap-1">
        <Icon name="spinner" spin class="text-2xs" />{{ maker ? t(`chat.noticeHomeCommit.plain.saving`) : t(`chat.noticeHomeCommit.writing`) }}
    </span>
</template>
