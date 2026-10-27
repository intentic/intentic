<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import AccessAsk from "../../../components/access/AccessAsk.vue";

// The model picker's first row when this sandbox has models connected and none of them is the reader's (Access ▸
// People, a person's AI accounts). Connecting is not their way on and no row below can be picked, so the line says so
// and the one press that changes it is asking the owner, which turns into "Asked" once sent.
const t = useT();
</script>

<template>
    <div class="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-2" data-picker-nothing-shared>
        <span class="min-w-0 flex-1 text-xs text-muted">{{ t(`chat.modelPicker.nothingShared`) }}</span>
        <AccessAsk :reason="{ kind: `ai-accounts` }" :place="t(`shared.models`)" tier="accent" small />
    </div>
</template>
