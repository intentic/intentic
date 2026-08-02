<script setup lang="ts">
import { type AgentProvider, quickModelKey } from "@intentic/sandbox-contract";
import { Picker, type PickerOptions, Row, RowGroup } from "@intentic-app/ui";
import { computed } from "vue";
import { quickModelGroups, useQuickModel } from "../../../composables/chat/quickModel";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import ProviderLogo from "../../../chat/ProviderLogo.vue";

/* The cheap, fast model behind the one-click helpers that are not a conversation (today: the commit box's AI
 * autofill). It sits directly under the AI accounts because that is what it is a choice OVER — a model pinned
 * here can never name a provider this sandbox has no credential for, which is exactly the promise a
 * cross-sandbox preference in personal Settings could not make.
 *
 * AUTO IS THE DEFAULT AND IT IS DERIVED, NOT STORED: the empty string means "work it out from whatever is
 * connected right now" (resolveQuickModel — cheapest tier first, free channel before a paid one). So connecting
 * an account tomorrow improves the answer by itself, and the row's label shows what it currently resolves to
 * rather than making the user guess. */

const { settings, patch } = useSandboxSettings();
const quickModel = useQuickModel();

// The model Auto currently resolves to, by its SHORT label — the trigger is 14rem wide, and "Auto — Claude
// Code · Claude Haiku 4.5" truncated to "Auto — Claude Code · Cla…" hid exactly the part worth showing. The
// provider rides on the row's logo and the full resolution sits in the Auto row's description instead.
const autoModelLabel = computed<string | undefined>(() => {
    const choice = quickModel.choice.value;
    if (choice === undefined) {
        return undefined;
    }
    const key = quickModelKey(choice);
    return quickModelGroups.value.flatMap((group) => group.options).find((option) => option.key === key)?.label ?? choice.model;
});
// Auto leads as its own ungrouped row; the connected providers follow as labelled groups, so a model row can
// drop the "Claude Code · " prefix that used to eat the width of every line.
const quickModelPickerOptions = computed<PickerOptions>(() => [
    {
        options: [
            {
                value: ``,
                label: autoModelLabel.value === undefined ? `Auto` : `Auto · ${autoModelLabel.value}`,
                description: `Cheapest connected model`,
            },
        ],
    },
    ...quickModelGroups.value.map((group) => ({
        label: group.label,
        options: group.options.map((option) => ({ value: option.key, label: option.label })),
    })),
]);
// A pinned key is `${provider}:${model}` (quickModelKey) — the provider prefix drives the row's brand mark.
const providerOfKey = (key: string): AgentProvider => key.slice(0, key.indexOf(`:`)) as AgentProvider;
</script>

<template>
    <RowGroup label="Models">
        <!-- Auto leads and states what it resolves to, because the useful thing to know here is not that a
             default exists but WHICH model a click is about to bill. -->
        <Row
            icon="sparkles"
            title="Quick model"
            description="The cheap, fast model behind one-click helpers like the commit-message autofill — never the model your chat runs on."
        >
            <template #control>
                <Picker
                    :model-value="quickModel.pinned.value"
                    :options="quickModelPickerOptions"
                    :disabled="settings === undefined"
                    class="w-56 py-1.5 text-xs"
                    aria-label="Quick model"
                    @update:model-value="(value: string | undefined) => patch({ quickModel: value ?? `` })"
                >
                    <!-- Auto keeps the sparkle the helpers themselves wear; a pinned model wears its provider's
                         mark, so the trigger names the account a click will spend at a glance. -->
                    <template #icon="{ option }">
                        <Icon v-if="option.value === ``" name="sparkles" class="shrink-0 text-xs text-muted" aria-hidden="true" />
                        <ProviderLogo v-else :provider="providerOfKey(option.value)" class="shrink-0 text-xs text-muted" />
                    </template>
                </Picker>
            </template>
            <!-- Nothing connected: the helpers are inert and the dropdown has only Auto in it, which on its own
                 reads as a broken control rather than a missing account. -->
            <template v-if="quickModel.choice.value === undefined && settings !== undefined" #below>
                <p class="text-2xs text-muted">Connect an AI account above to enable the one-click helpers.</p>
            </template>
        </Row>
    </RowGroup>
</template>
