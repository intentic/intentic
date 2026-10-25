<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { RouterLink } from "vue-router";
import { MODELS_PATH } from "../../../lib/routes/modelsPath";

// The model picker's first row while nothing in the sandbox can run: every row under it is locked, so the way to unlock
// them leads the list rather than ending it. A real link, so Ctrl/Cmd-click opens it elsewhere; on Home the view opens in
// the chat's place (lib/routes/homeDetour.ts).
const emit = defineEmits<{ navigate: [event: MouseEvent] }>();
const t = useT();
</script>

<template>
    <RouterLink
        :to="MODELS_PATH"
        class="ui-row-select flex w-full items-center gap-2 border-b border-line px-3 py-2 text-xs font-medium text-link max-md:min-h-11"
        data-picker-connect-first
        @click="emit(`navigate`, $event)"
    >
        <Icon name="key" class="shrink-0 text-2xs" aria-hidden="true" />
        <span class="min-w-0 flex-1">{{ t(`chat.modelPicker.nothingConnected`) }}</span>
        <Icon name="arrow-right" class="shrink-0 text-2xs" aria-hidden="true" />
    </RouterLink>
</template>
