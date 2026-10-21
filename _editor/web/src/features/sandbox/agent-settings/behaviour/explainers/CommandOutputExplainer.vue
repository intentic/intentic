<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Explainer from "./Explainer.vue";
import { AREA_GOOD, ARROW, BOX, LANE } from "./atoms";

// Command output, drawn: a command's output as lines, most of them progress and noise, through a cleaner that keeps the
// summary and the failure, so the agent reads two lines where the terminal printed eight.

const t = useT();
// Line lengths of the sketch, in percent of its width: progress noise, then the summary and the failure it keeps.
const NOISE = [92, 78, 85, 70, 88, 64] as const;
</script>

<template>
    <Explainer
        :label="t(`sandbox.explainers.commandOutput.label`)"
        :title="t(`sandbox.explainers.commandOutput.title`)"
        :experience="t(`sandbox.explainers.commandOutput.experience`)"
        :tokens="t(`sandbox.explainers.commandOutput.tokens`)"
    >
        <div class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
            <div class="flex flex-col gap-1">
                <span :class="LANE">{{ t(`sandbox.explainers.commandOutput.printed`) }}</span>
                <div class="flex flex-col gap-1 rounded-md border border-line-subtle bg-card p-1.5">
                    <code class="font-mono text-[0.625rem] text-muted">$ pnpm test</code>
                    <span v-for="(width, index) in NOISE" :key="index" class="h-1 rounded-full bg-line" :style="{ width: `${width}%` }" />
                    <span class="h-1 w-3/4 rounded-full bg-warning-fill" />
                    <span class="h-1 w-1/2 rounded-full bg-muted" />
                </div>
            </div>
            <div class="flex flex-col items-center gap-1">
                <span :class="BOX"><Icon name="bolt" />{{ t(`sandbox.explainers.commandOutput.cleaner`) }}</span>
                <Icon name="arrow-right" :class="ARROW" />
            </div>
            <div class="flex flex-col gap-1">
                <span :class="LANE">{{ t(`sandbox.explainers.commandOutput.agentReads`) }}</span>
                <div class="flex flex-col gap-1 rounded-md p-1.5" :class="AREA_GOOD">
                    <code class="font-mono text-[0.625rem] text-muted">$ pnpm test</code>
                    <span class="h-1 w-3/4 rounded-full bg-warning-fill" />
                    <span class="h-1 w-1/2 rounded-full bg-muted" />
                </div>
            </div>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-[0.625rem] text-subtle">
            <span class="inline-flex items-center gap-1"
                ><span class="h-1 w-3 rounded-full bg-line" />{{ t(`sandbox.explainers.commandOutput.noise`) }}</span
            >
            <span class="inline-flex items-center gap-1"
                ><span class="h-1 w-3 rounded-full bg-warning-fill" />{{ t(`sandbox.explainers.commandOutput.failure`) }}</span
            >
            <span class="inline-flex items-center gap-1"
                ><span class="h-1 w-3 rounded-full bg-muted" />{{ t(`sandbox.explainers.commandOutput.summary`) }}</span
            >
        </div>
    </Explainer>
</template>
