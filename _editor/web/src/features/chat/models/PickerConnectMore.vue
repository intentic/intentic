<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { providerDisplayLabel } from "../../../models/providers/providerCatalog";
import { modelsHref } from "../../../lib/routes/modelsPath";

// The model picker's last row once something here can run: the way to connect more, which the list no longer shows
// (the lanes nothing can run yet fold away, ModelPicker.vue `fold`). Without it a first-run reader on the trial who
// wanted their own Gemini searched, read "No models match." and had nowhere to go (session replay, 2026-11-16). A search
// naming a provider not connected yet names it here, and the press starts its sign-in (modelsPath `provider`). A real
// link, so Ctrl/Cmd-click opens it elsewhere; on Home the view opens in the chat's place (lib/routes/homeDetour.ts).
const { provider } = defineProps<{
    // A provider the search named that nothing of is connected yet; undefined offers the Models page itself.
    provider?: AgentProvider;
}>();
const emit = defineEmits<{ navigate: [event: MouseEvent] }>();
const t = useT();

const to = computed(() => modelsHref(provider === undefined ? {} : { provider }));
const label = computed(() =>
    provider === undefined ? t(`chat.modelPicker.connectMore`) : t(`chat.modelPicker.connectNamed`, { provider: providerDisplayLabel(provider) }),
);
</script>

<template>
    <RouterLink
        :to="to"
        class="ui-row-select mt-1 flex w-full items-center gap-2 border-t border-line px-3 py-2 text-2xs text-link max-md:min-h-11"
        data-picker-connect-more
        @click="emit(`navigate`, $event)"
    >
        <Icon name="plus" class="shrink-0 text-2xs" aria-hidden="true" />
        <span class="min-w-0 flex-1">{{ label }}</span>
        <Icon name="arrow-right" class="shrink-0 text-2xs" aria-hidden="true" />
    </RouterLink>
</template>
