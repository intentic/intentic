<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract";
import { Button, CopyButton, Icon, Modal, Notice, noticeOf } from "@intentic/extension-ui";
import { computed, ref, toRef } from "vue";
import { since } from "./cronSchedule";
import { type VisitorChatInstall, embedSnippet, useAutomations, useVisitorChatInstalls } from "./useAutomations";
import { t } from "./i18n.js";

// Whether the snippet actually landed: this panel exists since copying it is the only act that matters, moved out of
// the create dialog into the row, reachable forever, with the missing half (has a browser loaded it) beside it. A
// refused origin is the point: a www/bare-domain mismatch used to fail silently, now it's a named origin and an Allow
// button.

const props = defineProps<{ automation: AutomationSummary }>();
const visible = defineModel<boolean>(`visible`, { default: false });

const { save } = useAutomations();
const { installs, isLoading, error } = useVisitorChatInstalls(
    computed(() => props.automation.id),
    toRef(visible),
);

const snippet = computed(() => embedSnippet(props.automation) ?? ``);
const allowedOrigins = computed<string[]>(() => {
    const trigger = props.automation.trigger;
    return trigger.kind === `listener` ? [...(trigger.allowedOrigins ?? [])] : [];
});

// Split, not sorted by recency: a refused origin is an action, a working one is reassurance, and recency would bury the
// action on a busy site.
const refused = computed<VisitorChatInstall[]>(() => installs.value.filter((probe) => !probe.allowed));
const loaded = computed<VisitorChatInstall[]>(() => installs.value.filter((probe) => probe.allowed));

const addError = ref<string | undefined>(undefined);
const adding = ref<string | undefined>(undefined);

// One click on the commonest setup mistake: append the origin the browser actually used to the allowlist.
const allowOrigin = async (origin: string): Promise<void> => {
    const trigger = props.automation.trigger;
    if (trigger.kind !== `listener`) {
        return;
    }
    adding.value = origin;
    addError.value = undefined;
    try {
        const { runs: _runs, nextRun: _nextRun, ...automation } = props.automation;
        await save.mutateAsync({
            ...automation,
            trigger: { ...trigger, allowedOrigins: [...(trigger.allowedOrigins ?? []), origin] },
        });
    } catch (err) {
        addError.value = err instanceof Error ? err.message : `Could not add that site.`;
    } finally {
        adding.value = undefined;
    }
};
</script>

<template>
    <Modal v-model:open="visible" size="md" :header="t(`visitorChatInstallDialog.install`)">
        <div class="flex flex-col gap-4">
            <!-- The deliverable, first and unmissable. Everything below it is about whether it worked. -->
            <div class="ui-field">
                <span class="ui-field-label">{{ t(`visitorChatInstallDialog.pasteIntoSiteBefore`) }} <span class="font-mono">&lt;/body&gt;</span></span>
                <div class="flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2">
                    <code class="min-w-0 flex-1 break-all font-mono text-2xs text-content">{{ snippet }}</code>
                    <CopyButton :text="snippet" :aria-label="t(`visitorChatInstallDialog.copyEmbedSnippet`, { id: automation.id })" />
                </div>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">{{ t(`visitorChatInstallDialog.allowedSites`) }}</span>
                <div v-if="allowedOrigins.length > 0" class="flex flex-wrap gap-1.5">
                    <code v-for="origin in allowedOrigins" :key="origin" class="rounded bg-overlay px-2 py-1 font-mono text-2xs text-muted">
                        {{ origin }}
                    </code>
                </div>
                <Notice v-else :of="noticeOf(`No sites are allowed yet, so every visitor is turned away. Add one below or edit the automation.`)" />
            </div>

            <div class="ui-field">
                <span class="ui-field-label">{{ t(`visitorChatInstallDialog.loaded`) }}</span>

                <Notice v-if="error" :of="noticeOf(error)" />

                <!-- A real state, not empty: it says what to do to change it, the only useful thing while nothing has happened yet. -->
                <div v-else-if="installs.length === 0" class="flex items-start gap-2 rounded-md bg-overlay px-3 py-2.5 text-xs text-muted">
                    <Icon name="clock" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                    <span v-if="isLoading">{{ t(`visitorChatInstallDialog.checking`) }}</span>
                    <span v-else>
                        {{ t(`visitorChatInstallDialog.noBrowserLoadedWidget`) }}
                    </span>
                </div>

                <template v-else>
                    <!-- Refused first: it is the one line here that asks for an action. -->
                    <div
                        v-for="probe in refused"
                        :key="probe.origin"
                        class="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs"
                    >
                        <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
                        <span class="min-w-0 flex-1">
                            <code class="font-mono text-2xs text-content">{{ probe.origin }}</code>
                            <span class="text-muted">{{ t(`visitorChatInstallDialog.askedTurnedAway`, { lastSeenAt: since(probe.lastSeenAt) }) }}</span>
                        </span>
                        <Button
                            size="small"
                            severity="secondary"
                            :label="t(`visitorChatInstallDialog.allow`)"
                            :loading="adding === probe.origin"
                            :aria-label="t(`visitorChatInstallDialog.allowToLoadChat`, { origin: probe.origin })"
                            @click="allowOrigin(probe.origin)"
                        />
                    </div>

                    <div v-for="probe in loaded" :key="probe.origin" class="flex items-center gap-2 px-1 text-xs">
                        <Icon name="check-circle" class="shrink-0 text-2xs text-success" />
                        <code class="min-w-0 flex-1 truncate font-mono text-2xs text-content">{{ probe.origin }}</code>
                        <span class="shrink-0 text-2xs text-subtle">
                            {{ probe.loads }} {{ probe.loads === 1 ? `load` : `loads` }} · {{ since(probe.lastSeenAt) }}
                        </span>
                    </div>

                    <Notice v-if="addError" :of="noticeOf(addError)" />
                </template>
            </div>
        </div>

        <template #footer>
            <Button :label="t(`visitorChatInstallDialog.done`)" @click="visible = false" />
        </template>
    </Modal>
</template>
