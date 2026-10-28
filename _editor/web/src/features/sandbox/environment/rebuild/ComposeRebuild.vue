<!-- The rebuild of a sandbox Docker Compose runs: the edit its compose file needs (composeRebuild.ts), then Compose's
     own redeploy. No button and no `ic` command: nothing on this page reaches the file, and a swap would start a container
     Compose does not know.

     Numbered steps, each a few words and a Copy over the block it copies. It used to be a paragraph for every block (a
     lead, a label saying the lead again, a sentence per line to paste), with the YAML scrolling sideways AND folded behind
     "Show all": the reader came to copy three things, so three things to copy is what it shows. Copy sits in the step's
     row rather than on the block, so the block keeps its whole width on a phone. -->
<script setup lang="ts">
import type { ShikiLang } from "@intentic/code-read/langs";
import { COMPOSE_UPDATE_COMMAND } from "@intentic/sandbox-run";
import { Code, CopyButton, toneFill } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { composeRebuildOf } from "./composeRebuild";

const props = defineProps<{
    // The approved recipe waiting to be built, as the daemon composed it.
    hash: string;
    content: string;
}>();

const t = useT();

const edit = computed(() => composeRebuildOf(props.hash, props.content));

interface Step {
    readonly key: string;
    readonly label: string;
    readonly code: string;
    readonly lang: ShikiLang;
    // A way to do the step without the block, said beside its label.
    readonly hint?: string;
    // Lines shown before the block scrolls in place: a long recipe is there to be copied, not read.
    readonly lines?: number;
}

// The service's keys only when the recipe has any (a recipe the base image already satisfies is the hash alone).
const steps = computed<Step[]>(() => [
    ...(edit.value.snippet === ``
        ? []
        : [{ key: `service`, label: t(`sandbox.environmentCard.composeStepService`), code: edit.value.snippet, lang: `yaml` as const, lines: 12 }]),
    { key: `environment`, label: t(`sandbox.environmentCard.composeStepEnvironment`), code: edit.value.hashEnv, lang: `dotenv` },
    {
        key: `redeploy`,
        label: t(`sandbox.environmentCard.composeStepRedeploy`),
        code: COMPOSE_UPDATE_COMMAND,
        lang: `bash`,
        hint: t(`sandbox.environmentCard.composeStepRedeployElsewhere`),
    },
]);
</script>

<template>
    <div class="flex flex-col gap-3" data-executor="compose">
        <p class="text-xs font-medium text-content">{{ t(`sandbox.environmentCard.composeTitle`) }}</p>
        <ol class="flex flex-col gap-3">
            <li v-for="(step, index) in steps" :key="step.key" :data-step="step.key" class="flex min-w-0 flex-col gap-1.5">
                <div class="flex items-center gap-2">
                    <span :class="toneFill(`neutral`, `soft`, `flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-medium text-muted`)">
                        {{ index + 1 }}
                    </span>
                    <p class="min-w-0 flex-1 text-xs text-content">
                        {{ step.label }}
                        <span v-if="step.hint" class="ml-1 text-2xs text-subtle">{{ step.hint }}</span>
                    </p>
                    <CopyButton class="shrink-0" :text="step.code" :label="t(`ui.action.copy`)" />
                </div>
                <!-- Wrapped, so nothing hides to the right, each wrapped line hanging under its own indent. -->
                <Code :code="step.code" :lang="step.lang" wrap :copyable="false" :scroll-lines="step.lines" />
            </li>
        </ol>
    </div>
</template>
