<script setup lang="ts">
import { Button, Code, ui, CopyButton } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { curlLine, gatePath, githubStep } from "./gateSnippets";
import { host } from "./host";
import { useWorkflows } from "./useWorkflows";

/* THE GATE'S DOOR, AS THE TWO STRINGS A PIPELINE NEEDS: the URL and a paste-ready step.
 *
 * Rendered in the designer's gate panel AND under the card's badge, for the reason the automations row shows
 * its webhook beside the dialog that created it: the moment somebody actually wants this string is months
 * after the save that minted it, standing in a CI settings page. Only ever rendered once the token exists:
 * before the first save there is no URL to show, and a placeholder would be a string someone pastes. */

/* THE TOKEN IS NOT ON THE DESIGN. The daemon keeps it with the door and attaches it to the listed summary and to
 * the save's answer for a maintainer or the owner (`gateToken`); a viewer opening the badge sees that a gate
 * exists and not the string that opens it. So this takes the two facts it renders and the token beside them,
 * whichever surface has them: the list's summary, or the designer's draft plus what its last save answered. */
const { workflow } = defineProps<{ workflow: { readonly id: string; readonly name: string; readonly gateToken?: string } }>();

const { rotateGateToken } = useWorkflows();

const url = computed<string | undefined>(() => {
    const token = workflow.gateToken;
    if (token === undefined) {
        return undefined;
    }
    return `${host().sandbox.origin() ?? ``}${gatePath(workflow.id, token)}`;
});

// Two presses, like every press here that cannot be undone: the old URL dies the moment the daemon answers.
const confirmingRotate = ref(false);
const rotate = async (): Promise<void> => {
    confirmingRotate.value = false;
    await rotateGateToken.mutateAsync(workflow.id);
};
</script>

<template>
    <div v-if="url !== undefined" class="flex flex-col gap-2">
        <div class="flex items-center gap-1.5">
            <span :class="ui.sectionLabel('shrink-0')">Webhook</span>
            <code class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ url }}</code>
            <CopyButton :text="url" aria-label="Copy the gate URL" v-tooltip.top="`Copy URL`" />
            <Button
                v-if="!confirmingRotate"
                label="Rotate"
                size="small"
                severity="secondary"
                :text="true"
                :disabled="rotateGateToken.isPending.value"
                v-tooltip.top="`Mint a new token; the current URL stops working`"
                @click="confirmingRotate = true"
            />
        </div>
        <div v-if="confirmingRotate" class="flex flex-wrap items-center justify-end gap-2">
            <span class="mr-auto text-2xs text-subtle">Sure? Every pipeline wired to this URL has to be handed the new one.</span>
            <Button label="Cancel" size="small" severity="secondary" :text="true" @click="confirmingRotate = false" />
            <Button label="Rotate token" size="small" severity="danger" :loading="rotateGateToken.isPending.value" @click="rotate" />
        </div>
        <p class="text-2xs text-subtle">
            POST what the pipeline knows, commit, branch, preview URL, and the reply waits for the run: an
            <code>outcome</code> of pass, fail or blocked, with one line of why. The token in the URL is the whole auth: keep it in your CI's secret
            store, never in a committed file.
        </p>
        <Code :code="githubStep(workflow.name)" lang="yaml" label="GitHub Actions: the URL goes in a secret named INTENTIC_GATE_URL" />
        <Code :code="curlLine(url)" lang="bash" label="Any CI" wrap />
    </div>
</template>
