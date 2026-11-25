<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { pickerSource } from "../../../models/conversations/accounts/pickerSource";
import { computerHarnesses } from "../../../models/providers/computer/computerHarnesses";
import { modelsHref } from "../../../lib/routes/modelsPath";

// The model picker's first row while nothing in the sandbox can run: every row under it is locked, so the way to unlock
// them leads the list rather than ending it. A real link, so Ctrl/Cmd-click opens it elsewhere; on Home the view opens in
// the chat's place (lib/routes/homeDetour.ts).
const emit = defineEmits<{ navigate: [event: MouseEvent] }>();
const t = useT();

// On this computer there is no page to go to: every lane below holds its own set up or sign in, so the row only says so,
// or that no coding agent is here at all.
const computer = computed(() => pickerSource.value.kind === `computer`);
</script>

<template>
    <p v-if="computer" class="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-xs font-medium text-muted" data-picker-connect-first>
        <Icon name="download" class="shrink-0 text-2xs" aria-hidden="true" />
        <span class="min-w-0 flex-1">{{ computerHarnesses.length === 0 ? t(`chat.computer.picker.none`) : t(`chat.computer.picker.nothingRuns`) }}</span>
    </p>
    <RouterLink
        v-else
        :to="modelsHref()"
        class="ui-row-select flex w-full items-center gap-2 border-b border-line px-3 py-2 text-xs font-medium text-link max-md:min-h-11"
        data-picker-connect-first
        @click="emit(`navigate`, $event)"
    >
        <Icon name="key" class="shrink-0 text-2xs" aria-hidden="true" />
        <span class="min-w-0 flex-1">{{ t(`chat.modelPicker.nothingConnected`) }}</span>
        <Icon name="arrow-right" class="shrink-0 text-2xs" aria-hidden="true" />
    </RouterLink>
</template>
