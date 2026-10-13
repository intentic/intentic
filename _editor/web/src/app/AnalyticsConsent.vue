<script setup lang="ts">
import { computed } from "vue";
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { analyticsAvailable, analyticsChoice, chooseAnalytics } from "./analyticsConsent";

const t = useT();
const prompt = computed(() => analyticsAvailable() && analyticsChoice.value === undefined);
</script>

<template>
    <aside v-if="prompt" class="fixed bottom-4 left-4 z-50 max-w-sm rounded-lg border border-subtle bg-surface p-4 shadow-lg" role="region" :aria-label="t(`settings.analytics.title`)">
        <p class="font-medium">{{ t(`settings.analytics.title`) }}</p>
        <p class="mt-1 text-sm">{{ t(`settings.analytics.description`) }}</p>
        <div class="mt-3 flex gap-2">
            <Button :label="t(`settings.analytics.allow`)" size="small" @click="chooseAnalytics(`allow`)" />
            <Button :label="t(`settings.analytics.deny`)" tier="quiet" size="small" @click="chooseAnalytics(`deny`)" />
        </div>
    </aside>

</template>
