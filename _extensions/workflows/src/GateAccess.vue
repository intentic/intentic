<script setup lang="ts">
import { Button, Code, ui, CopyButton } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { curlLine, gatePath, githubStep } from "./gateSnippets";
import { host } from "./host";
import { useWorkflows } from "./useWorkflows";
import { t } from "./i18n.js";

// Renders the gate's webhook URL and a paste-ready CI snippet, in both the designer's gate panel and the card's badge.
// Shown only once the token exists; there is no URL to show before the first save.

// Token lives on the daemon's summary or last save, never on the design; rendered from whichever the caller has.
const { workflow } = defineProps<{ workflow: { readonly id: string; readonly name: string; readonly gateToken?: string } }>();

const { rotateGateToken } = useWorkflows();

const url = computed<string | undefined>(() => {
    const token = workflow.gateToken;
    if (token === undefined) {
        return undefined;
    }
    return `${host().sandbox.origin() ?? ``}${gatePath(workflow.id, token)}`;
});

// Two-step confirm: rotating kills the old URL the instant the daemon answers.
const confirmingRotate = ref(false);
const rotate = async (): Promise<void> => {
    confirmingRotate.value = false;
    await rotateGateToken.mutateAsync(workflow.id);
};
</script>

<template>
    <div v-if="url !== undefined" class="flex flex-col gap-2">
        <div class="flex items-center gap-1.5">
            <span :class="ui.sectionLabel('shrink-0')">{{ t(`gateAccess.webhook`) }}</span>
            <code class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ url }}</code>
            <CopyButton :text="url" :aria-label="t(`gateAccess.copyGateUrl`)" v-tooltip.top="t(`gateAccess.copyUrl`)" />
            <Button
                v-if="!confirmingRotate"
                :label="t(`gateAccess.rotate`)"
                size="small"
                severity="secondary"
                :text="true"
                :disabled="rotateGateToken.isPending.value"
                v-tooltip.top="t(`gateAccess.mintNewTokenCurrent`)"
                @click="confirmingRotate = true"
            />
        </div>
        <div v-if="confirmingRotate" class="flex flex-wrap items-center justify-end gap-2">
            <span class="mr-auto text-2xs text-subtle">{{ t(`gateAccess.sureEveryPipelineWired`) }}</span>
            <Button :label="t(`gateAccess.cancel`)" size="small" severity="secondary" :text="true" @click="confirmingRotate = false" />
            <Button :label="t(`gateAccess.rotateToken`)" size="small" severity="danger" :loading="rotateGateToken.isPending.value" @click="rotate" />
        </div>
        <p class="text-2xs text-subtle">
            {{ t(`gateAccess.postWhatPipelineKnows`) }}
            <code>outcome</code> {{ t(`gateAccess.passFailBlockedOne`) }}
        </p>
        <Code :code="githubStep(workflow.name)" lang="yaml" :label="t(`gateAccess.githubActionsUrlGoes`)" />
        <Code :code="curlLine(url)" lang="bash" :label="t(`gateAccess.anyCi`)" wrap />
    </div>
</template>
