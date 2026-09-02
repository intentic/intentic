<script setup lang="ts">
import { computed } from "vue";
import { modelRequest, settleModelPick, stageModelPick } from "../composables/chat/hostModelPicker";
import type { PickerEntry } from "../composables/chat/modelPicker";
import { usePickerAccounts } from "../composables/chat/pickerAccounts";
import ModelPicker from "./ModelPicker.vue";
import PickerAccounts from "./PickerAccounts.vue";

/* THE SHELL PICKER'S BODY: the list, and under it the same who-serves-the-turn block the composer shows. One
 * component because there are two hosts for it (a sheet on mobile, a popover on desktop) and only the frame
 * differs; the panel they frame is the same panel, and it stopped being a single tag the moment it grew a footer.
 *
 * Like the composer, only a MODEL row answers and closes. Account and harness rows configure that answer in
 * place: the open request holds those staged pins until a model is picked, while dismissal still returns no
 * choice to the caller. */

const request = computed(() => modelRequest.value);

// The block below the list: mounted only when it has something to say, since the border and padding are drawn
// here rather than by it.
const { hasContent } = usePickerAccounts(
    computed(() => request.value?.provider ?? `claude`),
    computed(() => request.value?.harness ?? `native`),
    computed(() => request.value?.model),
);

/* A model row. The two pins ride along ONLY under the provider they were made under: an account id is one
 * provider's store key, and a harness is a choice that exists for codex/grok alone: carrying either across a
 * provider switch would pin the run to a credential the new provider does not have. */
const choose = (entry: PickerEntry): void => {
    const held = request.value;
    const kept = held !== undefined && entry.provider === held.provider ? held : undefined;
    settleModelPick({
        provider: entry.provider,
        model: entry.value,
        label: entry.label,
        ...(kept?.account !== undefined ? { account: kept.account } : {}),
        ...(kept?.harness !== undefined ? { harness: kept.harness } : {}),
    });
};
</script>

<template>
    <ModelPicker v-if="request" :provider="request.provider" :model="request.model" @pick="choose" @close="settleModelPick()">
        <template #footer>
            <!-- The composer's footer metrics exactly (ModelPicker's own 12px rhythm, the row groups bleeding
                 back out with `-mx-3`): the two panels are the same panel, and a reader who opens this one from
                 an extension should not be able to tell which surface asked for it. -->
            <div v-if="hasContent" class="scrollbar-thin flex min-h-0 shrink flex-col gap-2 overflow-y-auto border-t border-line bg-canvas px-3 py-2">
                <PickerAccounts
                    :provider="request.provider"
                    :harness="request.harness ?? `native`"
                    :model="request.model"
                    :account="request.account"
                    @select-account="stageModelPick({ account: $event })"
                    @select-harness="stageModelPick({ harness: $event })"
                    @navigate="settleModelPick()"
                />
            </div>
        </template>
    </ModelPicker>
</template>
