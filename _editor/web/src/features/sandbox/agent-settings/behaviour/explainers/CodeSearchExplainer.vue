<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Explainer from "./Explainer.vue";
import { ARROW, BOX, BOX_FADED, BOX_GOOD, LANE } from "./atoms";

// Code search, drawn: the hunt without iq against the one ranked search with it, then where the map and the field notes
// ride (the notes on every turn, the map once on the first message), then the comparison that measures all three.

const t = useT();
// Command names, which no language translates: the hunt without iq, then the one search with it.
const HUNT = [`grep`, `find`] as const;
const IQ = `iq`;
</script>

<template>
    <Explainer
        :label="t(`sandbox.explainers.codeSearch.label`)"
        :title="t(`sandbox.explainers.codeSearch.title`)"
        :experience="t(`sandbox.explainers.codeSearch.experience`)"
        :tokens="t(`sandbox.explainers.codeSearch.tokens`)"
    >
        <div class="flex flex-col gap-1">
            <span :class="LANE">{{ t(`sandbox.explainers.codeSearch.without`) }}</span>
            <div class="flex flex-wrap items-center gap-1">
                <span :class="BOX_FADED"><Icon name="search" />{{ HUNT[0] }}</span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX_FADED"><Icon name="file" /></span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX_FADED"><Icon name="search" />{{ HUNT[1] }}</span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX_FADED"><Icon name="file" /></span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX_GOOD"><Icon name="check" />{{ t(`sandbox.explainers.codeSearch.rightFile`) }}</span>
            </div>
        </div>
        <div class="flex flex-col gap-1">
            <span :class="LANE">{{ t(`sandbox.explainers.codeSearch.with`) }}</span>
            <div class="flex flex-wrap items-center gap-1">
                <span :class="BOX"><Icon name="search" />{{ IQ }}</span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX_GOOD"><Icon name="check" />{{ t(`sandbox.explainers.codeSearch.rightFile`) }}</span>
            </div>
        </div>
        <!-- Where the two composed pieces ride: the conversation as a row of requests, the notes in every one. -->
        <div class="flex flex-col gap-1 border-t border-line-subtle pt-2">
            <span :class="LANE">{{ t(`sandbox.explainers.codeSearch.ridesAlong`) }}</span>
            <div class="grid grid-cols-3 gap-1 text-[0.625rem] leading-tight">
                <div v-for="turn in 3" :key="turn" class="flex flex-col gap-0.5 rounded-md border border-line-subtle p-1">
                    <span class="text-subtle">{{ t(`sandbox.explainers.codeSearch.turn`, { turn }) }}</span>
                    <span class="rounded-sm bg-primary-tint px-1 text-content">{{ t(`sandbox.agentCodeSearch.fieldNotes`) }}</span>
                    <span v-if="turn === 1" class="rounded-sm bg-info-tint px-1 text-content">{{ t(`sandbox.agentCodeSearch.projectMap`) }}</span>
                </div>
            </div>
        </div>
    </Explainer>
</template>
