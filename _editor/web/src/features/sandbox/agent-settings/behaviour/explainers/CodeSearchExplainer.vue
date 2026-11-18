<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import Explainer from "./Explainer.vue";
import { LANE } from "../../../../../components/explainerAtoms";

// The project map, drawn: what each turn actually sends. A request is the whole conversation so far, so the stack grows
// turn by turn: the map rides in the opening message and every request after it, read back from the prompt cache like
// the rest of the history. Only the tail is new.

const t = useT();

interface Block {
    readonly key: string;
    readonly label: string;
    readonly tone: string;
    // Sent before, so this request reads it back from the cache instead of paying for it in full.
    readonly cached: boolean;
}

const TURNS = 3;
const BLOCK = `truncate rounded-sm px-1`;
// The legend's sample of a block: the same ground, no words.
const SWATCH = `inline-block h-2.5 w-4 rounded-sm`;
// The conversation's own exchange in a quiet ground, so the two pieces this section adds stand out against it.
const EXCHANGE = `border border-line-subtle bg-card text-muted`;

// One request's stack, front first: the instructions, then each turn's message (the map in front of
// the first, where the wire puts it) and, for turns already answered, the reply that is now history.
const stackOf = (turn: number): Block[] => {
    const fixed: Block[] = [
        { key: `instructions`, label: t(`sandbox.explainers.codeSearch.instructions`), tone: EXCHANGE, cached: turn > 1 },
    ];
    const exchange = Array.from({ length: turn }, (_, index): Block[] => {
        const at = index + 1;
        const past = at < turn;
        return [
            ...(at === 1 ? [{ key: `map`, label: t(`sandbox.agentCodeSearch.projectMap`), tone: `bg-info-tint text-content`, cached: past }] : []),
            { key: `message-${at}`, label: t(`sandbox.explainers.codeSearch.message`, { turn: at }), tone: EXCHANGE, cached: past },
            ...(past ? [{ key: `reply-${at}`, label: t(`sandbox.explainers.codeSearch.reply`, { turn: at }), tone: `${EXCHANGE} py-1`, cached: true }] : []),
        ];
    });
    return [...fixed, ...exchange.flat()];
};
const STACKS = Array.from({ length: TURNS }, (_, index) => ({ turn: index + 1, blocks: stackOf(index + 1) }));
</script>

<template>
    <Explainer
        :label="t(`sandbox.explainers.codeSearch.label`)"
        :title="t(`sandbox.explainers.codeSearch.title`)"
        :experience="t(`sandbox.explainers.codeSearch.experience`)"
        :tokens="t(`sandbox.explainers.codeSearch.tokens`)"
    >
        <!-- What each turn sends: the conversation so far, front first. Faded is read back from the cache; solid is new. -->
        <div class="flex flex-col gap-1">
            <span :class="LANE">{{ t(`sandbox.explainers.codeSearch.ridesAlong`) }}</span>
            <div class="grid grid-cols-3 items-start gap-1 text-[0.625rem] leading-tight">
                <div v-for="stack in STACKS" :key="stack.turn" class="flex min-w-0 flex-col gap-0.5 rounded-md border border-line-subtle p-1">
                    <span class="text-subtle">{{ t(`sandbox.explainers.codeSearch.turn`, { turn: stack.turn }) }}</span>
                    <span v-for="block in stack.blocks" :key="block.key" :class="[BLOCK, block.tone, block.cached ? `opacity-45` : `ring-1 ring-line`]">
                        {{ block.label }}
                    </span>
                </div>
            </div>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.625rem] text-subtle">
                <span class="inline-flex items-center gap-1"><span :class="[SWATCH, EXCHANGE, `ring-1 ring-line`]" />{{ t(`sandbox.explainers.codeSearch.fresh`) }}</span>
                <span class="inline-flex items-center gap-1"><span :class="[SWATCH, EXCHANGE, `opacity-45`]" />{{ t(`sandbox.explainers.codeSearch.cached`) }}</span>
            </div>
        </div>
    </Explainer>
</template>
