<script setup lang="ts">
import type { AgentHarness } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { modelRequest, settleModelPick } from "../composables/chat/hostModelPicker";
import { modelLabelFor, type PickerEntry } from "../composables/chat/modelPicker";
import { usePickerAccounts } from "../composables/chat/pickerAccounts";
import ModelPicker from "./ModelPicker.vue";
import PickerAccounts from "./PickerAccounts.vue";

/* THE SHELL PICKER'S BODY: the list, and under it the same who-serves-the-turn block the composer shows. One
 * component because there are two hosts for it (a sheet on mobile, a popover on desktop) and only the frame
 * differs; the panel they frame is the same panel, and it stopped being a single tag the moment it grew a footer.
 *
 * EVERY ROW ANSWERS THE REQUEST AND CLOSES. That is the difference from the composer's binding, and it follows
 * from who is asking: an extension is AWAITING one value, so a half-changed selection has nowhere to live, there
 * is no conversation here to write it to, and a picker holding state the caller cannot see is a picker that can
 * disagree with the chip that opened it. So an account or a harness row settles the promise exactly as a model
 * row does, carrying the parts nobody touched. */

const request = computed(() => modelRequest.value);

// The block below the list: mounted only when it has something to say, since the border and padding are drawn
// here rather than by it.
const { hasContent } = usePickerAccounts(
    computed(() => request.value?.provider ?? `claude`),
    computed(() => request.value?.harness ?? `native`),
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

// An account or harness row: the model is untouched, so it is re-named from the catalog rather than remembered:
// the same rule the chip that opened this obeys, and the reason no caller keeps a catalog of its own.
const settleWith = (patch: { account?: string; harness?: AgentHarness }): void => {
    const held = request.value;
    if (held === undefined) {
        return;
    }
    settleModelPick({
        provider: held.provider,
        model: held.model,
        label: modelLabelFor(held.provider, held.model),
        ...(held.account !== undefined ? { account: held.account } : {}),
        ...(held.harness !== undefined ? { harness: held.harness } : {}),
        ...patch,
    });
};
</script>

<template>
    <ModelPicker v-if="request" :provider="request.provider" :model="request.model" @pick="choose" @close="settleModelPick()">
        <template #footer>
            <!-- The composer's footer metrics exactly (ModelPicker's own 12px rhythm, the row groups bleeding
                 back out with `-mx-3`): the two panels are the same panel, and a reader who opens this one from
                 an extension should not be able to tell which surface asked for it. -->
            <div v-if="hasContent" class="scrollbar-thin flex min-h-0 shrink flex-col gap-2 overflow-y-auto border-t border-line px-3 py-2">
                <PickerAccounts
                    :provider="request.provider"
                    :harness="request.harness ?? `native`"
                    :account="request.account"
                    @select-account="settleWith({ account: $event })"
                    @select-harness="settleWith({ harness: $event })"
                    @navigate="settleModelPick()"
                />
            </div>
        </template>
    </ModelPicker>
</template>
