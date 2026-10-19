<script setup lang="ts">
import { FRESH_KINDS, type FreshKind } from "@intentic/sandbox-contract/schemas/agent";
import { SegmentedControl } from "@intentic/ui";
import { FRESH_ICONS } from "../../../../models/fleet/freshKinds";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { agentDisplayTitle } from "../../../../models/agent-status/agentStatus-meta";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { providerCommands } from "../../../../models/providers/providerCatalog";
import { refreshFreshDraft, switchFreshKind, unlinkFresh } from "../../../../models/fleet/freshSession";
import { useAgents } from "../../../../models/fleet/useAgents";

/* A fresh session not sent yet (freshSession.ts), said over the composer: whose work it opens on, that it carries none of
   that conversation, what it is for (switching swaps the ask while the reader has not written over it), and the way
   back to an ordinary chat. Gone once the first message is taken, when the transcript's own line says it (ChatFreshLine). */

const t = useT();
const { conversation } = usePaneView();
const { agentById } = useAgents();

const pending = computed(() => conversation.value.pendingFreshOf.value);
const origin = computed(() => (pending.value === undefined ? undefined : agentById(pending.value.conversationId)));
const originTitle = computed(() => (origin.value === undefined ? t(`agents.freshSession.anotherChat`) : agentDisplayTitle(origin.value)));

const options = computed(() => FRESH_KINDS.map((kind) => ({ value: kind, label: t(`agents.freshSession.kind.${kind}`), icon: FRESH_ICONS[kind] })));
const kind = computed({
    get: (): FreshKind => pending.value?.kind ?? `ask`,
    set: (next: FreshKind) => void switchFreshKind(conversation.value, origin.value, next),
});

// A provider picked after the strip wrote its ask may name its reviewer otherwise: the untouched ask follows it.
const provider = computed(() => conversation.value.selection.provider.value);
watch(provider, (_now, before) => {
    if (pending.value !== undefined && before !== undefined) {
        void refreshFreshDraft(conversation.value, providerCommands.value[before] ?? []);
    }
});
</script>

<template>
    <div
        v-if="pending !== undefined"
        class="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-line bg-card px-3 py-2 text-2xs text-muted shadow-sm"
        data-fresh-draft
    >
        <Icon name="link" class="shrink-0 text-link" />
        <span class="min-w-[12rem] flex-1" v-tooltip.top="{ title: t(`agents.freshSession.howItWorks`), note: t(`agents.freshSession.howItWorksNote`) }">
            <i18n-t keypath="agents.freshSession.onWork" scope="global">
                <template #title>
                    <span class="font-medium text-content">{{ originTitle }}</span>
                </template>
            </i18n-t>
        </span>
        <SegmentedControl v-model="kind" :options="options" size="xs" class="shrink-0" />
        <button
            type="button"
            class="touch-target flex shrink-0 cursor-pointer items-center rounded-sm text-subtle hover:text-content"
            :aria-label="t(`agents.freshSession.unlink`)"
            v-tooltip.top="{ title: t(`agents.freshSession.unlink`), note: t(`agents.freshSession.unlinkNote`) }"
            @click="unlinkFresh(conversation)"
        >
            <Icon name="link-broken" class="text-xs" />
        </button>
    </div>
</template>
