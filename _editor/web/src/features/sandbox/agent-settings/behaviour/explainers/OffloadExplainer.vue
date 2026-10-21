<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Explainer from "./Explainer.vue";
import { ARROW, BOX, LANE } from "./atoms";

// Where heavy work runs, drawn: a heavy command leaving this sandbox for a runner on one of your machines and its
// results coming back, and the fallback when that machine is offline or busy.

const t = useT();
</script>

<template>
    <Explainer
        :label="t(`sandbox.explainers.offload.label`)"
        :title="t(`sandbox.explainers.offload.title`)"
        :experience="t(`sandbox.explainers.offload.experience`)"
        :tokens="t(`sandbox.explainers.offload.tokens`)"
    >
        <div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
            <span :class="BOX"><Icon name="box" />{{ t(`sandbox.explainers.offload.sandbox`) }}</span>
            <div class="flex flex-col gap-1 text-[0.625rem] text-subtle">
                <span class="flex items-center gap-1"
                    ><code class="font-mono text-muted">pnpm test</code><span class="h-px flex-1 bg-line-strong" /><Icon
                        name="arrow-right"
                        :class="ARROW"
                /></span>
                <span class="flex items-center gap-1"
                    ><Icon name="arrow-left" :class="ARROW" /><span class="h-px flex-1 bg-line-strong" />{{
                        t(`sandbox.explainers.offload.results`)
                    }}</span
                >
            </div>
            <span :class="BOX"><Icon name="desktop" />{{ t(`sandbox.explainers.offload.runner`) }}</span>
        </div>
        <div class="flex flex-col gap-1 border-t border-line-subtle pt-2">
            <span :class="LANE">{{ t(`sandbox.explainers.offload.offline`) }}</span>
            <div class="flex items-center gap-1">
                <span :class="BOX"><Icon name="box" />{{ t(`sandbox.explainers.offload.sandbox`) }}</span>
                <span class="text-2xs text-muted">{{ t(`sandbox.explainers.offload.runsHere`) }}</span>
            </div>
        </div>
    </Explainer>
</template>
