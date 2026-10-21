<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Explainer from "./Explainer.vue";
import { AREA_GOOD, BOX, LANE } from "./atoms";

// Subagents, drawn: one chat fanning out (how many at once is the width), one of them delegating again (how deep it
// nests), and an allowance window split between what subagents may spend and the room kept for your own chats.

const t = useT();
</script>

<template>
    <Explainer
        :label="t(`sandbox.explainers.subagents.label`)"
        :title="t(`sandbox.explainers.subagents.title`)"
        :experience="t(`sandbox.explainers.subagents.experience`)"
        :tokens="t(`sandbox.explainers.subagents.tokens`)"
    >
        <div class="flex flex-col items-start gap-1.5">
            <span :class="BOX"><Icon name="comments" />{{ t(`sandbox.explainers.subagents.thisChat`) }}</span>
            <!-- The fan-out: three side by side, the width "at once" bounds. -->
            <div class="ml-3 flex flex-col gap-1 border-l border-line-strong pl-2">
                <div class="flex flex-wrap items-center gap-1">
                    <span v-for="n in 3" :key="n" :class="BOX"><Icon name="robot" />{{ n }}</span>
                    <span class="text-[0.625rem] text-primary">← {{ t(`sandbox.agentSubagents.subagentsAtOnce`) }}</span>
                </div>
                <!-- One of them delegating again: depth. -->
                <div class="ml-3 flex items-center gap-1 border-l border-line-strong pl-2">
                    <span :class="BOX"><Icon name="robot" />1.1</span>
                    <span class="text-[0.625rem] text-primary">← {{ t(`sandbox.agentSubagents.nestingDepth`) }}</span>
                </div>
            </div>
        </div>
        <!-- The allowance window: what subagents may spend, and the room kept for you. -->
        <div class="flex flex-col gap-1 border-t border-line-subtle pt-2">
            <span :class="LANE">{{ t(`sandbox.explainers.subagents.window`) }}</span>
            <div class="flex h-5 gap-0.5 text-[0.625rem] leading-none">
                <span class="flex w-[88%] items-center rounded-sm bg-primary-tint px-1.5 text-content">{{ t(`shared.subagents`) }}</span>
                <span class="flex w-[12%] items-center justify-center rounded-sm" :class="AREA_GOOD"><Icon name="user" /></span>
            </div>
            <span class="text-[0.625rem] text-subtle">{{ t(`sandbox.explainers.subagents.roomKept`) }}</span>
        </div>
    </Explainer>
</template>
