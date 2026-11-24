<!-- The model picker footer's first line, the same for every provider and every host. Where account rows follow it, it is
     their group header, drawn as the list's own ("CLAUDE CODE", "CODEX") so the footer reads as one more group of the same
     panel rather than a different component glued under it; what the footer has to SAY sits at that header's end. How fresh
     the meters are is each meter's own hover card, not a line here. Every message the footer has goes here, so none of them
     stacks as a paragraph above or below the account list, and the list itself stays nothing but its rows. -->
<script setup lang="ts">
import { computed, toRef } from "vue";
import { SectionHeader } from "@intentic/ui";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { useT } from "@intentic/ui/i18n";
import { usePickerAccounts } from "./pickerAccounts";

const t = useT();

const {
    provider,
    harness,
    model,
    note,
    accounts = true,
} = defineProps<{
    provider: AgentProvider;
    harness: AgentHarness;
    model?: string | undefined;
    // A live turn's sentence (which model it finishes on): said short, whole on hover.
    note?: string | undefined;
    // Whether the account half is this surface's to speak for: off for another box's session, whose accounts pay for nothing here.
    accounts?: boolean;
}>();

const { onKey, choosable, routedRows, unplacedRefusal, hasContent } = usePickerAccounts(
    toRef(() => provider),
    toRef(() => harness),
    toRef(() => model),
);

// Rows nobody picks between read as a broken list unless something says so; a choosable list needs no caption. On a key
// they are the way back to the subscription, not where the turn spreads. Turns spread only over the accounts whose plan
// includes the model; the rest say so on their own rows.
const spreadOver = computed(() => routedRows.value.filter((row) => !row.offPlan).length);
const spread = computed(() => (accounts && !onKey.value && spreadOver.value > 1 ? spreadOver.value : undefined));
const refusal = computed(() => (accounts ? unplacedRefusal.value : undefined));

// The rows' name, when PickerAccounts draws rows under this line: the account a turn runs on where there is a pick, the
// subscription where its accounts are only shown (the turn is spread over them).
const heading = computed(() => {
    if (!accounts || !hasContent.value) {
        return undefined;
    }
    return choosable.value ? t(`shared.account`) : t(`chat.pickerAccounts.subscription`);
});

const said = computed(() => note !== undefined || spread.value !== undefined || refusal.value !== undefined);
</script>

<template>
    <!-- One place for every message, header or not: the end of the line, so a note never moves when the rows come and go. -->
    <SectionHeader v-if="heading !== undefined || said" :label="heading" density="dense" class="pb-1 pt-2.5">
        <template v-if="said" #actions>
            <!-- A live turn keeps the model it runs on; what is picked here is for the next message. -->
            <span v-if="note !== undefined" class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
                <Icon name="clock" class="shrink-0" aria-hidden="true" />
                <span class="truncate" role="note" :aria-label="note" v-tooltip.top="note">{{ t(`chat.pickerStatus.nextMessage`) }}</span>
            </span>
            <span v-else-if="spread !== undefined" class="truncate text-2xs text-subtle">{{ t(`chat.pickerStatus.spread`, { count: spread }) }}</span>

            <!-- The refusal belonging to this selection but no single row: what happened and when, the provider's own words on hover. -->
            <span
                v-if="refusal !== undefined"
                class="flex min-w-0 shrink items-center gap-1 text-2xs text-warning"
                role="status"
                v-tooltip.top="{ title: refusal.headline, quote: refusal.detail }"
            >
                <Icon name="exclamation-triangle" class="shrink-0" aria-hidden="true" />
                <span class="truncate">{{ refusal.headline }}</span>
            </span>
        </template>
    </SectionHeader>
</template>
