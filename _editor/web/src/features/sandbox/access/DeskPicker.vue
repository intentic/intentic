<script setup lang="ts">
import { personaBounds } from "@intentic/sandbox-contract";
import { PersonaFace, StatusBadge } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { RouterLink } from "vue-router";
import { usePersonas } from "../personas/usePersonas";
import { useT } from "@intentic/ui/i18n";

// Which persona cards a desk member may act through: one switch per card the sandbox has. The bounds badge is the
// honest part: a card with commands on is a lens, not a fence, and the owner picking it should read that here.

const t = useT();

const { picked, disabled = false } = defineProps<{ picked: readonly string[]; disabled?: boolean }>();
const emit = defineEmits<{ change: [desks: string[]] }>();

const { personas } = usePersonas();

const toggle = (id: string, on: boolean): void => {
    emit(`change`, on ? [...new Set([...picked, id])] : picked.filter((held) => held !== id));
};
</script>

<template>
    <div class="flex flex-col gap-2">
        <span class="text-xs text-subtle">{{ t(`sandbox.sandboxAccess.deskPick`) }}</span>
        <p v-if="personas.length === 0" class="text-xs text-subtle">
            {{ t(`chat.chatPersonaMenu.noPersonasYetChat`) }}
            <RouterLink to="/sandbox/personas" class="underline">{{ t(`chat.chatPersonaMenu.setUpPersona`) }}</RouterLink>
        </p>
        <label v-for="persona in personas" :key="persona.id" class="flex items-center justify-between gap-3">
            <span class="flex min-w-0 items-center gap-2">
                <PersonaFace :persona :size="24" />
                <span class="flex min-w-0 flex-col">
                    <span class="flex min-w-0 items-baseline gap-1.5">
                        <span class="truncate text-sm text-content">{{ persona.label ?? persona.id }}</span>
                        <StatusBadge v-if="persona.powers !== undefined" variant="neutral" size="xs">{{ personaBounds(persona) }}</StatusBadge>
                    </span>
                    <span v-if="persona.brief !== undefined" class="truncate text-2xs text-subtle">{{ persona.brief }}</span>
                </span>
            </span>
            <ToggleSwitch :model-value="picked.includes(persona.id)" :disabled="disabled" @update:model-value="(on: boolean) => toggle(persona.id, on)" />
        </label>
        <span v-if="picked.length === 0 && personas.length > 0" class="ui-field-error">{{ t(`sandbox.sandboxAccess.deskNeedsAssistant`) }}</span>
    </div>
</template>
