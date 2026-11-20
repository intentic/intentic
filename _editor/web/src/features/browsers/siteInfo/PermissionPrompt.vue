<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { PermissionAskTools } from "./usePermissionAsk";
import { PERMISSION_ICONS, permissionWords, siteName } from "./permissionWords";

// A site's permission ask, in the top corner of the page where a browser anchors its own: what it wants, and Block or
// Allow, remembered for the site. A camera or microphone the sandbox does not have was already refused, and this only
// says it happened.

const { tools } = defineProps<{ tools: PermissionAskTools }>();
const t = useT();

const ask = computed(() => tools.ask.value);
const site = computed(() => siteName(ask.value?.origin) ?? ``);
</script>

<template>
    <div v-if="ask" class="pointer-events-none absolute left-3 top-3 z-20 flex max-w-sm">
        <div class="pointer-events-auto flex w-80 flex-col gap-3 rounded-lg border border-line bg-card p-3.5 shadow-lg" role="dialog" :aria-label="site">
            <template v-if="ask.unavailable">
                <div class="flex items-start gap-2 text-xs">
                    <Icon :name="PERMISSION_ICONS[ask.permission]" class="shrink-0 text-muted" />
                    <p class="text-content">{{ t(`browsers.tools.noDevice`, { site, device: permissionWords(ask.permission) }) }}</p>
                </div>
                <div class="flex justify-end">
                    <Button size="small" tier="quiet" :loading="tools.answering.value" @click="tools.answer(`block`)">{{ t(`ui.action.dismiss`) }}</Button>
                </div>
            </template>
            <template v-else>
                <div class="flex flex-col gap-2">
                    <span class="text-xs text-content">{{ t(`browsers.tools.siteWants`, { site }) }}</span>
                    <span class="flex items-center gap-2 text-xs text-content">
                        <Icon :name="PERMISSION_ICONS[ask.permission]" class="shrink-0 text-2xs text-muted" />
                        {{ permissionWords(ask.permission) }}
                    </span>
                    <span v-if="ask.permission === `geolocation`" class="text-3xs text-muted">{{ t(`browsers.tools.locationNote`) }}</span>
                </div>
                <p v-if="tools.error.value" class="text-2xs text-danger">{{ tools.error.value }}</p>
                <div class="flex justify-end gap-2">
                    <Button size="small" tier="quiet" :disabled="tools.answering.value" @click="tools.answer(`block`)">{{ t(`browsers.tools.block`) }}</Button>
                    <Button size="small" tier="accent" :loading="tools.answering.value" @click="tools.answer(`allow`)">{{ t(`browsers.tools.allow`) }}</Button>
                </div>
            </template>
        </div>
    </div>
</template>
