<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { RouterLink } from "vue-router";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { computed } from "vue";
import { pickerSource } from "../../../models/conversations/accounts/pickerSource";
import { computerHarness } from "../../../models/providers/computer/computerHarnesses";
import { hasSignIn, providerReady } from "../../../models/providers/access";
import ComputerLaneStatus from "./computer/ComputerLaneStatus.vue";
import type { CatalogLoadState } from "../../../models/providers/providerCatalog";
import { modelsPath } from "../../../lib/routes/modelsPath";

// `withheld`: the reader may not run this provider (Access ▸ People), so connecting it is never the line drawn here.
const { provider } = defineProps<{ provider: AgentProvider | undefined; withheld?: boolean; rowCount: number; state: CatalogLoadState }>();
const emit = defineEmits<{ retry: []; navigate: [event: MouseEvent] }>();
const t = useT();

// A coding agent of this computer that cannot run yet lists no models: its line says what it needs, and how its set up or
// sign in is going once pressed (ComputerLaneStatus.vue). One that runs reads as any lane does, with nothing to connect.
const computer = computed(() => pickerSource.value.kind === `computer`);
const harnessBlocked = computed(() => {
    const harness = computer.value && provider !== undefined ? computerHarness(provider) : undefined;
    return harness !== undefined && harness.standing !== `ready` ? harness : undefined;
});
</script>

<template>
    <ComputerLaneStatus v-if="harnessBlocked !== undefined" :harness="harnessBlocked" />
    <template v-else-if="!computer && provider !== undefined && !withheld && hasSignIn(provider) && !providerReady(provider)">
        <p v-if="rowCount > 0" class="px-3 py-1.5 text-2xs text-subtle">{{ t(`chat.modelPicker.connectToCheckModels`) }}</p>
        <RouterLink v-else :to="modelsPath({ provider })" class="block px-3 py-1.5 text-2xs text-link hover:underline" @click="emit(`navigate`, $event)">
            {{ t(`chat.modelPicker.connectToDiscoverModels`) }}
        </RouterLink>
    </template>
    <template v-else-if="rowCount === 0">
        <div v-if="state === `error`" class="flex items-center gap-2 px-3 py-1.5 text-2xs text-danger">
            <span>{{ t(`chat.modelPicker.couldntLoadModels`) }}</span>
            <button type="button" class="text-link hover:underline" @click="emit(`retry`)">{{ t(`ui.action.retry`) }}</button>
        </div>
        <div v-else-if="state === `loaded`" class="px-3 py-1.5 text-2xs text-subtle">{{ t(`chat.modelPicker.noModelsDiscovered`) }}</div>
        <div v-else class="flex items-center gap-2 px-3 py-1.5 text-2xs text-subtle">
            <Icon name="spinner" spin /> {{ t(`chat.modelPicker.loadingModels`) }}
        </div>
    </template>
</template>
