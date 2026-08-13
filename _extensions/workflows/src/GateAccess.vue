<script setup lang="ts">
import { Code, cmp, CopyButton } from "@intentic/extension-ui";
import type { Workflow } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { curlLine, gatePath, githubStep } from "./gateSnippets";
import { host } from "./host";

/* THE GATE'S DOOR, AS THE TWO STRINGS A PIPELINE NEEDS — the URL and a paste-ready step.
 *
 * Rendered in the designer's gate panel AND under the card's badge, for the reason the automations row shows
 * its webhook beside the dialog that created it: the moment somebody actually wants this string is months
 * after the save that minted it, standing in a CI settings page. Only ever rendered once the token exists —
 * before the first save there is no URL to show, and a placeholder would be a string someone pastes. */

const { workflow } = defineProps<{ workflow: Workflow }>();

const url = computed<string | undefined>(() => {
    const token = workflow.gate?.token;
    if (token === undefined) {
        return undefined;
    }
    return `${host().sandbox.origin() ?? ``}${gatePath(workflow.id, token)}`;
});
</script>

<template>
    <div v-if="url !== undefined" class="flex flex-col gap-2">
        <div class="flex items-center gap-1.5">
            <span :class="cmp.sectionLabel('shrink-0')">Webhook</span>
            <code class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ url }}</code>
            <CopyButton :text="url" aria-label="Copy the gate URL" v-tooltip.top="`Copy URL`" />
        </div>
        <p class="text-2xs text-subtle">
            POST what the pipeline knows — commit, branch, preview URL — and the reply waits for the run: an
            <code>outcome</code> of pass, fail or blocked, with one line of why. The token in the URL is the whole auth — keep it in your CI's secret
            store, never in a committed file.
        </p>
        <Code :code="githubStep(workflow.name)" lang="yaml" label="GitHub Actions — the URL goes in a secret named INTENTIC_GATE_URL" />
        <Code :code="curlLine(url)" lang="bash" label="Any CI" wrap />
    </div>
</template>
