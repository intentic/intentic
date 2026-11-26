<script setup lang="ts">
import { Button, CopyButton, Icon, Notice, noticeOf, timeAgo } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { host } from "./host";
import { t } from "./i18n.js";
import { embedSnippet } from "./snippet";
import { type VisitorChatInstall, useChat, useInstalls } from "./useInstalls";

// Whether the snippet actually landed: copying it is the only act that matters, and beside it the missing half, whether
// a browser has loaded it. A refused origin is the point: a www/bare-domain mismatch used to fail silently, now it is a
// named origin and an Allow button. Moved here from the Automations view's install dialog on 2026-11-26, with the rest
// of the Visitor chat.

const props = defineProps<{ input: { readonly automation?: string | number | boolean } }>();

const automationId = computed(() => String(props.input.automation ?? ``));
const { chat, save } = useChat(automationId);
const { installs, isLoading, error } = useInstalls(automationId);

const snippet = computed(() => {
    const origin = host().sandbox.origin();
    return origin === undefined ? `` : embedSnippet(origin, automationId.value);
});
const allowedOrigins = computed<string[]>(() => {
    const trigger = chat.value?.trigger;
    return trigger?.kind === `listener` ? [...(trigger.allowedOrigins ?? [])] : [];
});

// Split, not sorted by recency: a refused origin is an action, a working one is reassurance, and recency would bury the
// action on a busy site.
const refused = computed<VisitorChatInstall[]>(() => installs.value.filter((probe) => !probe.allowed));
const loaded = computed<VisitorChatInstall[]>(() => installs.value.filter((probe) => probe.allowed));

const addError = ref<string | undefined>(undefined);
const adding = ref<string | undefined>(undefined);

// One click on the commonest setup mistake: append the origin the browser actually used to the allowlist.
const allowOrigin = async (origin: string): Promise<void> => {
    const current = chat.value;
    if (current === undefined || current.trigger.kind !== `listener`) {
        return;
    }
    adding.value = origin;
    addError.value = undefined;
    try {
        const { runs: _runs, nextRun: _nextRun, ...automation } = current;
        await save.mutateAsync({ ...automation, trigger: { ...current.trigger, allowedOrigins: [...(current.trigger.allowedOrigins ?? []), origin] } });
    } catch (err) {
        addError.value = err instanceof Error ? err.message : t(`installPanel.couldntAddSite`);
    } finally {
        adding.value = undefined;
    }
};
</script>

<template>
    <div class="flex flex-col gap-4 p-4">
        <!-- The deliverable, first and unmissable. Everything below it is about whether it worked. -->
        <div class="ui-field">
            <span class="ui-field-label">{{ t(`installPanel.pasteIntoSiteBefore`) }} <span class="font-mono">&lt;/body&gt;</span></span>
            <div class="flex items-start gap-2 rounded-md bg-canvas px-3 py-2">
                <code class="min-w-0 flex-1 break-all font-mono text-2xs text-content">{{ snippet }}</code>
                <CopyButton :text="snippet" :aria-label="t(`installPanel.copyEmbedSnippet`, { id: automationId })" />
            </div>
        </div>

        <div class="ui-field">
            <span class="ui-field-label">{{ t(`installPanel.allowedSites`) }}</span>
            <div v-if="allowedOrigins.length > 0" class="flex flex-wrap gap-1.5">
                <code v-for="origin in allowedOrigins" :key="origin" class="rounded bg-overlay px-2 py-1 font-mono text-2xs text-muted">
                    {{ origin }}
                </code>
            </div>
            <Notice v-else :of="noticeOf(t(`installPanel.noSitesAllowed`))" />
        </div>

        <div class="ui-field">
            <span class="ui-field-label">{{ t(`installPanel.loaded`) }}</span>

            <Notice v-if="error" :of="noticeOf(t(`installPanel.couldntReadInstalls`))" />

            <!-- A real state, not empty: it says what to do to change it, the only useful thing while nothing has happened yet. -->
            <Notice v-else-if="installs.length === 0" icon="clock">
                <template v-if="isLoading">{{ t(`installPanel.checking`) }}</template>
                <template v-else>{{ t(`installPanel.noBrowserLoadedWidget`) }}</template>
            </Notice>

            <template v-else>
                <!-- Refused first: it is the one line here that asks for an action. -->
                <Notice v-for="probe in refused" :key="probe.origin" tone="warning">
                    <code class="font-mono text-2xs text-content">{{ probe.origin }}</code>
                    <span class="text-muted">{{ t(`installPanel.askedTurnedAway`, { lastSeenAt: timeAgo(probe.lastSeenAt) }) }}</span>
                    <template #actions>
                        <Button
                            size="small"
                            tier="boring"
                            :label="t(`installPanel.allow`)"
                            :loading="adding === probe.origin"
                            :aria-label="t(`installPanel.allowToLoadChat`, { origin: probe.origin })"
                            @click="allowOrigin(probe.origin)"
                        />
                    </template>
                </Notice>

                <div v-for="probe in loaded" :key="probe.origin" class="flex items-center gap-2 px-1 text-xs">
                    <Icon name="check-circle" class="shrink-0 text-2xs text-success" />
                    <code class="min-w-0 flex-1 truncate font-mono text-2xs text-content">{{ probe.origin }}</code>
                    <span class="shrink-0 text-2xs text-subtle">
                        {{ t(`installPanel.loadCount`, { count: probe.loads }, probe.loads) }} · {{ timeAgo(probe.lastSeenAt) }}
                    </span>
                </div>

                <Notice v-if="addError" :of="noticeOf(addError)" />
            </template>
        </div>
    </div>
</template>
