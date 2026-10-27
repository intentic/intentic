<!-- A settled card's one line. Once a card is answered it is history, and a reader scrolling past wants what it ended
     as, not the ask again: the default slot holds that as facts (who, what changed, a word sent back), and what was asked
     folds behind one quiet press at the line's end, the way a settled subagent ask keeps its words (ChatChildAgentAsk).
     Nothing is drawn when there is neither a fact nor anything folded, so a plain "Done" stays a one-line card. -->
<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useSlots } from "vue";

const t = useT();

const { more = undefined, facts = true } = defineProps<{
    // What the press brings back, named for it ("Why it asked", "Details"); absent, nothing folds.
    more?: string | undefined;
    // Whether the default slot has anything in it: a slot that renders only `v-if`s that are all false still exists,
    // so the card says so rather than this guessing from the vnodes.
    facts?: boolean;
}>();

const slots = useSlots();
const open = ref(false);
const folds = computed(() => more !== undefined && slots[`folded`] !== undefined);
</script>

<template>
    <div v-if="facts || folds" class="chat-card-body flex flex-col gap-2" data-card-outcome>
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
            <slot />
            <button
                v-if="folds"
                type="button"
                :class="ui.textButton({ tone: `quiet`, size: `xs` }, `ml-auto`)"
                :aria-expanded="open"
                data-card-outcome-toggle
                @click="open = !open"
            >
                {{ open ? t(`chat.cardOutcome.hide`) : more }}
            </button>
        </div>
        <slot v-if="open" name="folded" />
    </div>
</template>
