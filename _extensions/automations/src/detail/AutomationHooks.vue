<!-- The doors into an automation from outside, opened: a webhook's URL with its rotation, a Visitor chat's settings and embed code. -->
<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { Button, CopyButton, Icon, Section } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { useAutomations, webhookUrl } from "../useAutomations";
import { visitorChatOf } from "./visitorChat";
import { t } from "../i18n.js";

const props = defineProps<{ automation: AutomationSummary }>();
const emit = defineEmits<{ install: [] }>();

// The URL carries the door's token; the daemon hands it to a maintainer or owner only, never a viewer.
const url = computed(() => webhookUrl(props.automation));
const visitorChat = computed(() => visitorChatOf(props.automation));

const { rotateToken } = useAutomations();
// Two presses, like every undoable action here: the old URL dies the moment the daemon answers.
const confirmingRotate = ref(false);
const rotate = async (): Promise<void> => {
    confirmingRotate.value = false;
    await rotateToken.mutateAsync(props.automation.id);
};
</script>

<template>
    <!-- One box that states its own gap, so the two doors space the same wherever this is mounted. -->
    <div v-if="automation.trigger.kind === `event` || visitorChat" class="flex flex-col gap-5">
        <Section v-if="automation.trigger.kind === `event`" :label="t(`automationRow.webhook`)">
            <div class="flex flex-col gap-1.5">
                <div v-if="url !== undefined" class="flex items-center gap-1.5 rounded-lg border border-line-subtle py-1 pl-3 pr-1">
                    <code class="min-w-0 flex-1 truncate font-mono text-2xs text-muted">{{ url }}</code>
                    <CopyButton :text="url" :aria-label="t(`automationRow.copyWebhookUrl`, { id: automation.id })" v-tooltip.top="t(`automationRow.copyUrl`)" />
                    <Button
                        v-if="!confirmingRotate"
                        :label="t(`automationRow.rotate`)"
                        size="small"
                        tier="quiet"
                        :disabled="rotateToken.isPending.value"
                        v-tooltip.top="{ title: t(`automationRow.newToken`), note: t(`automationRow.oldUrlStops`) }"
                        @click="confirmingRotate = true"
                    />
                </div>
                <p v-else class="text-2xs text-subtle">{{ t(`automationRow.urlShownToMaintainers`) }}</p>
                <div v-if="confirmingRotate" class="flex flex-wrap items-center justify-end gap-2">
                    <span class="mr-auto text-2xs text-subtle">{{ t(`automationRow.sureEverySenderWired`) }}</span>
                    <Button :label="t(`automationRow.cancel`)" size="small" tier="quiet" @click="confirmingRotate = false" />
                    <Button :label="t(`automationRow.rotateToken`)" size="small" tone="danger" :loading="rotateToken.isPending.value" @click="rotate" />
                </div>
            </div>
        </Section>

        <!-- The settings deciding whether the widget works at all, each on its own line so a missing one stands out. -->
        <Section v-if="visitorChat" :label="t(`automationRow.visitorChat`)">
            <div class="flex flex-col gap-2">
                <ul class="flex flex-col gap-1 text-xs text-muted">
                    <li class="flex items-center gap-2">
                        <Icon name="globe" class="shrink-0 text-2xs text-subtle" />
                        <span v-if="visitorChat.origins.length > 0" class="truncate">{{
                            t(`automationRow.onOrigins`, { origins: visitorChat.origins.join(`, `) })
                        }}</span>
                        <span v-else class="text-danger">{{ t(`automationRow.noSitesAllowedNobody`) }}</span>
                    </li>
                    <li class="flex items-center gap-2"><Icon name="users" class="shrink-0 text-2xs text-subtle" />{{ visitorChat.access }}</li>
                    <li class="flex items-center gap-2"><Icon name="shield" class="shrink-0 text-2xs text-subtle" />{{ visitorChat.botCheck }}</li>
                </ul>
                <Button
                    size="small"
                    tier="boring"
                    class="self-start"
                    :label="t(`automationRow.getEmbedCode`)"
                    :aria-label="t(`automationRow.installOnWebsite`, { id: automation.id })"
                    @click="emit(`install`)"
                >
                    <template #icon><Icon name="globe" /></template>
                </Button>
            </div>
        </Section>
    </div>
</template>
