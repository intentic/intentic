<script setup lang="ts">
import { SectionHeader } from "@intentic/ui";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { computerHarness } from "../../../../models/providers/computer/computerHarnesses";
import PickerFooter from "../PickerFooter.vue";

// THE MODEL PICKER'S FOOTER, WHERE THE CODING AGENT IS THIS COMPUTER'S (ChatModelPicker.vue): the same first line a
// sandbox's footer has (PickerStatus.vue), the account group's header with a live turn's note at its end, over the one
// account there is, the harness's own sign-in as the harness states it, drawn as a sandbox's account row is. Nothing to
// pick between: the harness signs in as one account, and whose it is is the harness's to change.

const { provider, note } = defineProps<{
    provider: AgentProvider;
    // A live turn's sentence (which model it finishes on): said short, whole on hover.
    note?: string | undefined;
}>();
const t = useT();

const account = computed(() => computerHarness(provider)?.account);
</script>

<template>
    <PickerFooter v-if="account !== undefined || note !== undefined">
        <SectionHeader :label="account === undefined ? undefined : t(`shared.account`)" density="dense" class="pb-1 pt-2.5">
            <template v-if="note !== undefined" #actions>
                <span class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
                    <Icon name="clock" class="shrink-0" aria-hidden="true" />
                    <span class="truncate" role="note" :aria-label="note" v-tooltip.top="note">{{ t(`chat.pickerStatus.nextMessage`) }}</span>
                </span>
            </template>
        </SectionHeader>
        <div v-if="account !== undefined" class="-mx-3 flex min-w-0 items-center gap-2 px-3 py-1.5" data-computer-account>
            <span data-account-name class="max-w-[60%] shrink-0 truncate text-sm text-link md:text-xs">{{ account.label }}</span>
            <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ account.email }}</span>
        </div>
    </PickerFooter>
</template>
