<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { branchLabel } from "../../../../app/workspaceScope";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { unlinkBranch } from "../../../../models/fleet/branches/branchStart";

/* A branch start not sent yet (branchStart.ts), said over the composer as a fresh session's is (ChatFreshDraft): which
   branch the new agent's copy is cut from, that its finished work is committed onto that branch rather than landed in
   the shared workspace, and the way back to the main line. Gone once the first message is taken, when the card says it
   (SessionChip's "from <branch>"). */

const t = useT();
const { conversation } = usePaneView();

const branch = computed(() => conversation.value.pendingFromBranch.value);
const label = computed(() => (branch.value === undefined ? `` : branchLabel(branch.value)));
</script>

<template>
    <div
        v-if="branch !== undefined"
        class="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-line bg-card px-3 py-2 text-2xs text-muted shadow-sm"
        data-branch-draft
    >
        <Icon name="git-branch" class="shrink-0 text-link" />
        <span class="min-w-[12rem] flex-1" v-tooltip.top="{ title: t(`agents.branchStart.howItWorks`), note: t(`agents.branchStart.howItWorksNote`) }">
            <i18n-t keypath="agents.branchStart.onBranch" scope="global">
                <template #branch>
                    <span class="font-mono font-medium text-content">{{ label }}</span>
                </template>
            </i18n-t>
        </span>
        <button
            type="button"
            class="touch-target flex shrink-0 cursor-pointer items-center rounded-sm text-subtle hover:text-content"
            :aria-label="t(`agents.branchStart.unlink`)"
            v-tooltip.top="{ title: t(`agents.branchStart.unlink`), note: t(`agents.branchStart.unlinkNote`) }"
            @click="unlinkBranch(conversation)"
        >
            <Icon name="link-broken" class="text-xs" />
        </button>
    </div>
</template>
