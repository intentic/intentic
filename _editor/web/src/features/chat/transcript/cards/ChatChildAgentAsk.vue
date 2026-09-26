<script setup lang="ts">
import type { ChildAgentAsk, ChildRun } from "@intentic/sandbox-contract";
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import ProviderLogo from "../../accounts/ProviderLogo.vue";
import { requestModelPick } from "../../models/host/hostModelPicker";
import { childRunFacts, childRunLine, pickedChildRun } from "./childAgentRun";

// The child agent a held supervisor call is about, inside its permission card: what it is for, what the parent would say
// to it, and what it runs on. A start still waiting for its answer can be re-pointed here, through the same shell picker
// a Fix with agent caret opens; the card keeps the pick and sends it with the allow (ChatPermissionCard).

const t = useT();

const {
    ask,
    staged = undefined,
    repointable = false,
    disabled = false,
} = defineProps<{
    // The request's own account of the child, from the daemon's record of the call; once settled, what actually started.
    ask: ChildAgentAsk;
    // The owner's pick on a live card, when they made one; it is what starts if they allow.
    staged?: ChildRun | undefined;
    // Only a start still waiting can be re-pointed: a child already running keeps the run it was started on.
    repointable?: boolean;
    disabled?: boolean;
}>();
const emit = defineEmits<{ repoint: [run: ChildRun | undefined] }>();

const run = computed<ChildRun>(() => staged ?? ask);
const line = computed(() => childRunLine(run.value));
const facts = computed(() => childRunFacts(ask, run.value).join(` · `));
// What the agent asked for, when that is not what starts: the owner's pick on a live card, the record's once settled.
const changedFrom = computed(() => {
    const asked = staged === undefined ? ask.proposed : ask;
    return asked === undefined ? undefined : childRunLine(asked);
});

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
    <div class="flex min-w-0 flex-col gap-1.5">
        <span v-if="ask.task" class="text-xs leading-relaxed text-content/85">{{ ask.task }}</span>
        <!-- The parent's own words to it, since "send this" names nothing by itself. -->
        <p v-if="ask.message" class="line-clamp-6 whitespace-pre-wrap border-l-2 border-line pl-2 text-2xs leading-relaxed text-content/85">
            {{ ask.message }}
        </p>

        <!-- A chip, not a button: it carries the run, and pressing it opens the picker over that run. Lit once it is the owner's pick. -->
        <button
            v-if="repointable"
            ref="chip"
            type="button"
            class="ui-chip max-w-full self-start text-content"
            :class="{ 'ui-chip-on': staged !== undefined }"
            :disabled="disabled"
            :aria-label="t(`chat.chatChildAgentAsk.change`, { run: line })"
            v-tooltip.top="t(`chat.chatChildAgentAsk.changeHint`)"
            @click="choose"
        >
            <ProviderLogo :provider="run.provider" class="shrink-0 text-link" />
            <span class="truncate font-medium">{{ line }}</span>
            <Icon name="chevron-down" class="shrink-0 text-subtle" />
        </button>
        <span v-else class="flex min-w-0 items-center gap-1.5 text-xs text-content">
            <ProviderLogo :provider="run.provider" class="shrink-0 text-2xs text-link" />
            <span class="truncate font-medium">{{ line }}</span>
        </span>

        <span v-if="facts" class="text-2xs leading-snug text-subtle">{{ facts }}</span>
        <span v-if="changedFrom" class="flex flex-wrap items-center gap-x-2 text-2xs leading-snug text-muted">
            <span>{{ t(`chat.chatChildAgentAsk.changedFrom`, { run: changedFrom }) }}</span>
            <button v-if="staged !== undefined" type="button" :class="ui.textAction(`text-2xs`)" :disabled="disabled" @click="emit(`repoint`, undefined)">
                {{ t(`chat.chatChildAgentAsk.useAgentsPick`) }}
            </button>
        </span>
    </div>
</template>
