<script setup lang="ts">
import { Icon, SectionHeader, toneFill } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { onMounted } from "vue";
import { readComputerHarnesses } from "../../../../models/conversations/accounts/computerSignIn";
import type { Conversation } from "../../../../models/conversations/session/conversation";
import { type ComputerHarness, computerHarnesses } from "../../../../models/providers/computer/computerHarnesses";
import { type ModelOption, providerModels, providerModelsState } from "../../../../models/providers/providerCatalog";
import ComputerHarnessPress from "./ComputerHarnessPress.vue";

// WHICH CODING AGENT OF THIS COMPUTER A CHAT RUNS ON, AND WHICH OF ITS MODELS (2026-11-24). The sandbox's picker lists
// model vendors with accounts to connect; here there is nothing to connect, only the programs this reader has (Claude
// Code, Codex) or could have, each with the models it names itself. So every row is the harness's own word: its label,
// its description, its id sent back as it came (`default`, `opus`, `sonnet[1m]`), never looked up in a sandbox's
// catalog. A harness that cannot run yet shows the one press that makes it so (ComputerHarnessPress) instead of rows.

const emit = defineEmits<{ selected: [] }>();
const { conversation } = defineProps<{ conversation: Conversation }>();

const t = useT();
const { provider, model } = conversation.selection;
const { streaming } = conversation.turn;

// Asked again each time the picker opens: the reader may have installed or signed in to one beside this window.
onMounted(() => void readComputerHarnesses());

// A program the model route does not answer for keeps its model to itself: one row stands for "its own".
const modelsOf = (harness: ComputerHarness): readonly ModelOption[] =>
    harness.asked ? (providerModels.value[harness.id] ?? []) : [{ label: t(`chat.computer.picker.ownModel`), value: `` }];
const reading = (harness: ComputerHarness): boolean => modelsOf(harness).length === 0 && providerModelsState.value[harness.id] !== `error`;
const chosen = (harness: ComputerHarness, option: ModelOption): boolean => harness.id === provider.value && option.value === model.value;
// A turn under way runs where it started: another harness is a pick for after it.
const held = (harness: ComputerHarness): boolean => streaming.value && harness.id !== provider.value;
// The sign-in as the harness names it: its plan or organisation, and whose it is where it says.
const accountWords = (harness: ComputerHarness): string | undefined => {
    const account = harness.account;
    if (account === undefined) {
        return undefined;
    }
    return t(`chat.computer.picker.signedIn`, { account: account.email === undefined ? account.label : `${account.label} · ${account.email}` });
};

const pick = (harness: ComputerHarness, option: ModelOption): void => {
    conversation.selection.apply({ kind: `selectModel`, pick: { provider: harness.id, value: option.value } });
    emit(`selected`);
};
</script>

<template>
    <div class="flex max-h-[min(28rem,70vh)] w-full min-w-80 flex-col overflow-y-auto py-1" role="listbox" :aria-label="t(`chat.computer.picker.title`)" data-computer-picker>
        <p class="px-3 pb-1 pt-1.5 text-2xs text-subtle">{{ t(`chat.computer.picker.title`) }}</p>
        <!-- A turn under way runs where it started: said once, here, rather than on each greyed row. -->
        <p v-if="streaming" class="px-3 pb-1 text-2xs text-subtle">{{ t(`chat.computer.picker.afterTurn`) }}</p>
        <p v-if="computerHarnesses.length === 0" class="px-3 py-3 text-2xs text-muted">{{ t(`chat.computer.picker.none`) }}</p>
        <template v-for="harness in computerHarnesses" :key="harness.id">
            <SectionHeader :label="harness.label" density="dense" class="px-3 pb-1 pt-2" role="presentation">
                <template #info>
                    <span v-if="harness.standing === `setUp`" class="rounded bg-content/5 px-1 py-px text-[0.6rem] font-medium text-subtle">{{
                        t(`chat.computer.picker.notSetUp`)
                    }}</span>
                    <span v-else-if="harness.standing === `signIn`" class="rounded px-1 py-px text-[0.6rem] font-medium text-warning" :class="toneFill(`warning`, `soft`)">{{
                        t(`chat.computer.picker.signedOut`)
                    }}</span>
                    <span v-else-if="accountWords(harness) !== undefined" class="min-w-0 truncate text-2xs text-subtle">{{ accountWords(harness) }}</span>
                </template>
            </SectionHeader>
            <ComputerHarnessPress v-if="harness.standing !== `ready`" :harness="harness" class="px-3 pb-2" />
            <p v-else-if="reading(harness)" class="flex items-center gap-2 px-3 py-1.5 text-2xs text-subtle" role="status">
                <Icon name="spinner" spin class="shrink-0" />{{ t(`chat.computer.picker.reading`) }}
            </p>
            <template v-else>
                <button
                    v-for="option in modelsOf(harness)"
                    :key="option.value"
                    type="button"
                    role="option"
                    :aria-selected="chosen(harness, option)"
                    class="ui-row-select ui-off flex w-full items-center gap-2 px-3 py-1.5 text-left max-md:min-h-11"
                    :class="{ 'opacity-60': held(harness) }"
                    :disabled="held(harness)"
                    @click="pick(harness, option)"
                >
                    <span class="max-w-[55%] shrink-0 truncate text-sm md:text-xs" :class="chosen(harness, option) ? 'text-link' : 'text-content'">
                        {{ option.label }}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ option.description }}</span>
                    <Icon v-if="chosen(harness, option)" name="check" class="shrink-0 text-2xs text-accent" aria-hidden="true" />
                </button>
            </template>
        </template>
    </div>
</template>
