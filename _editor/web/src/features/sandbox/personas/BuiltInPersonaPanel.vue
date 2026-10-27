<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { BuiltInPersonaView } from "../../../models/sandbox/personas/builtInPersonas";

// An open built-in persona (Full access, No accounts), in the place a card's editor opens: what it reaches and when it
// is worn without being picked, so "who does this run act as" has an answer on this page even for a chat or an
// automation that picked no one. Read-only: built-ins are constants, not cards, so there is nothing to rename or save.

const { persona } = defineProps<{ persona: BuiltInPersonaView }>();
const t = useT();
</script>

<template>
    <div class="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-sm">
        <h3 class="m-0 flex min-w-0 items-baseline gap-2 text-base font-semibold">
            {{ persona.label }}
            <span class="text-xs font-normal text-subtle">{{ t(`sandbox.builtInPersonas.title`) }}</span>
        </h3>
        <p class="m-0 text-sm text-content">{{ persona.note }}</p>
        <p class="m-0 text-sm text-muted">{{ persona.when }}</p>
        <p class="m-0 flex items-start gap-1.5 text-xs text-subtle">
            <Icon name="lock" class="shrink-0" aria-hidden="true" />
            <span>{{ t(`sandbox.builtInPersonas.readOnly`) }}</span>
        </p>
    </div>
</template>
