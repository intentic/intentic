<script setup lang="ts">
import type { ChildAgentAsk, ChildMove, ChildRun } from "@intentic/sandbox-contract/events/requests";
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useTemplateRef, watch } from "vue";
import ProviderLogo from "../../../../parts/providers/ProviderLogo.vue";
import { requestModelPick } from "../../../../models/conversations/accounts/hostModelPicker";
import { watchClamp } from "../clampWatch";
import { childRunFacts, childRunLine, pickedChildRun } from "./childAgentRun";

// The child agent a held supervisor call is about, inside its permission card. Read top-down in the order a decision
// needs it: what the child is for, what it would be told, what it runs on. A start still waiting for its answer can be
// re-pointed here, through the same shell picker a Fix with agent caret opens; the card keeps the pick and sends it with
// the allow (ChatPermissionCard).
// Settled, the card is history under the subagent's own row, so it folds to what identifies it: the task and the run,
// with the parent's words one press away.

const t = useT();

const {
    ask,
    staged = undefined,
    repointable = false,
    disabled = false,
    settled = false,
} = defineProps<{
    // The request's own account of the child, from the daemon's record of the call; once settled, what actually started.
    ask: ChildAgentAsk;
    // The owner's pick on a live card, when they made one; it is what starts if they allow.
    staged?: ChildRun | undefined;
    // Only a start still waiting can be re-pointed: a child already running keeps the run it was started on.
    repointable?: boolean;
    disabled?: boolean;
    // Answered: the words fold away behind a press.
    settled?: boolean;
}>();
const emit = defineEmits<{ repoint: [run: ChildRun | undefined] }>();

const run = computed<ChildRun>(() => staged ?? ask);
const line = computed(() => childRunLine(run.value));
const facts = computed(() => childRunFacts(ask, run.value));
// What the agent asked for, when that is not what starts: the owner's pick on a live card, the record's once settled.
const changedFrom = computed(() => {
    const asked = staged === undefined ? ask.proposed : ask;
    return asked === undefined ? undefined : childRunLine(asked);
});

// THE PARENT'S WORDS: a start's prompt, a message, or the answers it gives. Three lines on a live card, which is enough
// to judge most by and keeps the answers in reach; the rest opens in place. Whether the clamp cut anything depends on
// the wrap width, so it is measured (clampWatch.ts), and the press to open it is offered only where it did.
const open = ref(false);
const quote = useTemplateRef<HTMLElement>(`quote`);
const clamped = ref(false);
watch(
    quote,
    (element, _previous, onCleanup) => {
        if (element === null) {
            clamped.value = false;
            return;
        }
        onCleanup(watchClamp(element, { skip: () => open.value, answer: (value) => (clamped.value = value) }));
    },
    { immediate: true, flush: `post` },
);
const quoteShown = computed(() => ask.message !== undefined && ask.message !== `` && (!settled || open.value));
// Folded, a blank line between paragraphs is one of the three lines spent on nothing, and the clamp's ellipsis lands on
// it: the paragraphs close up until it opens.
const quoteText = computed(() => (open.value ? ask.message : ask.message?.replaceAll(/\n\s*\n/gu, `\n`)));
// A settled card's press names what it brings back, as the move named it.
const showWords = (move: ChildMove): string => {
    switch (move) {
        case `spawn`:
            return t(`chat.chatChildAgentAsk.showPrompt`);
        case `send`:
            return t(`chat.chatChildAgentAsk.showMessage`);
        case `answer`:
            return t(`chat.chatChildAgentAsk.showAnswer`);
    }
};
// The one press that opens and folds the words, at the end of the run row under them: offered on a live card only where
// the clamp cut something, and on a settled one always, since there they start folded away.
const toggleLabel = computed(() => {
    if (settled) {
        return open.value ? t(`chat.chatChildAgentAsk.hide`) : showWords(ask.move);
    }
    return open.value ? t(`chat.chatChildAgentAsk.showLess`) : t(`chat.chatChildAgentAsk.showAll`);
});
const toggleShown = computed(() => (settled ? Boolean(ask.message) : clamped.value || open.value));
// The press that opens the words in place, read off the selection so a hand copying a phrase from them is left alone.
const openFromQuote = (): void => {
    if (clamped.value && !open.value && (window.getSelection()?.toString() ?? ``) === ``) {
        open.value = true;
    }
};

// The chip is the anchor the picker hangs off, as a run button's caret is.
const chip = ref<HTMLButtonElement>();
const choose = async (): Promise<void> => {
    const anchor = chip.value;
    if (anchor === undefined) {
        return;
    }
    // The picker reads an absent knob and an undefined one alike (hostModelPicker.ts), so the run passes through whole.
    const { provider, model, account, harness, effort, thinking, fast } = run.value;
    const choice = await requestModelPick({
        anchor,
        provider,
        model,
        account,
        harness,
        effort,
        thinking,
        fast,
        // A child carries all three knobs to its turn (children.ts childProfile), so the picker offers them.
        chooseRun: true,
        action: t(`chat.chatChildAgentAsk.useForAgent`),
    });
    if (choice !== undefined) {
        emit(`repoint`, pickedChildRun(choice, ask));
    }
};
</script>

<template>
    <div class="flex min-w-0 flex-col gap-2">
        <!-- WHAT IT IS FOR, the line a reader scans a card by: the lead while the card waits, one quiet line once it is history. -->
        <p
            v-if="ask.task"
            class="min-w-0 text-xs"
            :class="settled ? `truncate text-content/85` : `line-clamp-2 font-medium leading-snug text-content`"
            v-tooltip.top.overflow="settled ? ask.task : undefined"
            data-child-task
        >
            {{ ask.task }}
        </p>

        <!-- WHAT IT WOULD BE TOLD, set apart as quoted by a soft inset rather than a rule down its edge. The clamp is on the
             words, not the inset: clamped with its padding, the box would show the top of the line it cut. -->
        <div v-if="quoteShown" class="min-w-0 rounded-md bg-content/5 px-2 py-1.5">
            <p
                ref="quote"
                class="whitespace-pre-wrap text-2xs leading-relaxed text-content/80"
                :class="[!open && `line-clamp-3`, clamped && !open && `cursor-pointer`]"
                data-child-message
                @click="openFromQuote"
            >
                {{ quoteText }}
            </p>
        </div>

        <!-- WHAT IT RUNS ON, in one row: the run (the picker's chip while it can still change), then only the facts that
             say something, and on a settled card the press that brings the words back. -->
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <button
                v-if="repointable"
                ref="chip"
                type="button"
                :class="ui.chip({ on: staged !== undefined }, `max-w-full text-content`)"
                :disabled="disabled"
                :aria-label="t(`chat.chatChildAgentAsk.change`, { run: line })"
                v-tooltip.top="{ title: t(`chat.chatChildAgentAsk.changeRun`), note: t(`chat.chatChildAgentAsk.modelAccountEffort`) }"
                @click="choose"
            >
                <ProviderLogo :provider="run.provider" class="shrink-0 text-link" />
                <span class="truncate font-medium">{{ line }}</span>
                <Icon name="chevron-down" class="shrink-0 text-subtle" />
            </button>
            <span v-else class="flex min-w-0 items-center gap-1.5 text-2xs" :class="settled ? `text-muted` : `text-content`" data-child-run>
                <ProviderLogo :provider="run.provider" class="shrink-0 text-link" />
                <span class="truncate font-medium">{{ line }}</span>
            </span>
            <span v-for="fact in facts" :key="fact" class="flex items-center gap-2 text-2xs text-subtle">
                <span aria-hidden="true">·</span>{{ fact }}
            </span>
            <button
                v-if="toggleShown"
                type="button"
                :class="ui.textButton({ tone: `quiet`, size: `xs` }, `ml-auto`)"
                :aria-expanded="open"
                data-child-message-toggle
                @click="open = !open"
            >
                {{ toggleLabel }}
            </button>
        </div>

        <span v-if="changedFrom" class="flex flex-wrap items-center gap-x-2 text-2xs leading-snug text-muted">
            <span>{{ t(`chat.chatChildAgentAsk.changedFrom`, { run: changedFrom }) }}</span>
            <button
                v-if="staged !== undefined"
                type="button"
                :class="ui.textButton({ tone: `quiet`, size: `xs` })"
                :disabled="disabled"
                @click="emit(`repoint`, undefined)"
            >
                {{ t(`chat.chatChildAgentAsk.useAgentsPick`) }}
            </button>
        </span>
    </div>
</template>
