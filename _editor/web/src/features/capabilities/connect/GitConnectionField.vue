<!-- Which GitHub or GitLab card reads a plugin's or an extension's private repository (model/gitConnection.ts): one card
     is said in a sentence, several are a choice, and a token of the install's own sets them all aside. Nothing is drawn
     while no card is connected for the repository's host. -->
<script setup lang="ts">
import type { CapabilityField } from "@intentic/extension-manifest";
import { gitProviderName } from "@intentic/sandbox-contract/policy/git/git-connections";
import { Picker, type PickerOption } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watchEffect } from "vue";
import type { FormValues, StoredSecrets } from "../../../models/capabilities/form";
import { useCapabilities } from "../../../models/capabilities/useCapabilities";
import { chosenConnection, offeredConnections, ownToken } from "../model/gitConnection";

const t = useT();

const { field, values, kept } = defineProps<{
    field: CapabilityField;
    /** The form's live answers: this row writes its own key, and reads the URL and the token beside it. */
    values: FormValues;
    /** The credentials an edit keeps, a stored token among them. */
    kept: StoredSecrets;
}>();

const { capabilities } = useCapabilities();

const offered = computed(() => offeredConnections(capabilities.value, values[`url`] ?? ``));
const tokenOwn = computed(() => ownToken(values, kept));
// The answer follows the URL, the cards and the token: what the form sends is always one this row is showing.
watchEffect(() => {
    const next = chosenConnection(offered.value, values[field.key], tokenOwn.value);
    if ((values[field.key] ?? ``) !== next) {
        values[field.key] = next;
    }
});

const first = computed(() => offered.value[0]);
const provider = computed(() => (first.value === undefined ? `` : gitProviderName(first.value.provider)));
const options = computed<readonly PickerOption<string>[]>(() =>
    offered.value.map((connection) => ({ value: connection.id, label: connection.id, description: gitProviderName(connection.provider) })),
);
const picked = computed({
    get: () => values[field.key] ?? ``,
    set: (id: string) => {
        values[field.key] = id;
    },
});
</script>

<template>
    <div v-if="first" class="flex items-start gap-2 rounded-lg bg-card px-3 py-2 text-xs text-content shadow-sm">
        <Icon name="link" class="shrink-0 text-2xs text-subtle" />
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <span v-if="tokenOwn">{{ t(`capabilities.gitConnectionField.tokenInstead`, { provider }) }}</span>
            <template v-else-if="offered.length === 1">
                <span>{{ t(`capabilities.gitConnectionField.uses`, { provider, name: first.id }) }}</span>
                <span class="text-2xs text-subtle">{{ t(`capabilities.gitConnectionField.overrideHint`) }}</span>
            </template>
            <template v-else>
                <span class="flex flex-wrap items-center gap-2">
                    {{ t(`capabilities.gitConnectionField.readsWith`) }}
                    <Picker
                        v-model="picked"
                        :options="options"
                        variant="input"
                        :aria-label="field.label"
                        :header="field.label"
                        class="ui-field-sm w-56"
                    />
                </span>
                <span class="text-2xs text-subtle">{{ t(`capabilities.gitConnectionField.severalHint`, { provider }) }}</span>
            </template>
        </div>
    </div>
</template>
