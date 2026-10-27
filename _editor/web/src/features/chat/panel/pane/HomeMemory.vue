<!-- HOW FULL A HOME CONVERSATION'S MEMORY IS, said to everyone who talks to it (models/home/homeMemory.ts): a maker and a
     home-only guest alike, since this chat is theirs to keep cheap, unlike the context ring, which is a developer's
     instrument and which this stands in for on a home. One quiet item of the status strip (ChatPaneStatus); its press
     opens what it means, and on the reader's own home the two ways to empty it: start fresh now, or clear the history. -->
<script setup lang="ts">
import { Button, ConfirmDialog, formatTokens, Icon, ProgressRing, ResponsiveOverlay, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { turnInFlight } from "../../../../models/agent-status/agentStatus-standing";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { clearHomeHistory, ownHome, startFreshHome, useHomeMemory } from "../../../../models/home/homeMemory";
import { useSandboxSession } from "../../../../client/session/sandboxSession";
import { useAudience } from "../../../../app/useAudience";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

const t = useT();

// The pane's card, which the strip already reads: one lookup for both.
const { card } = defineProps<{ card: FleetAgent }>();

const { conversation } = usePaneView();
const { presentedEmail } = useSandboxSession();
const { maker } = useAudience();
const { budget, reading } = useHomeMemory(() => card);
// The presses act on the caller's own home whatever chat they are pressed under, so another person's home a sandbox
// owner reads shows its figure and what it means, and nothing to press.
const own = computed(() => ownHome(card, presentedEmail.value));
const label = computed(() => {
    const now = reading.value;
    switch (now?.kind) {
        case `pending`:
            return t(`chat.homeMemory.pending`);
        case `fill`:
            return now.soon
                ? `${t(`chat.homeMemory.fill`, { percent: now.percent })} · ${t(`chat.homeMemory.soon`)}`
                : t(`chat.homeMemory.fill`, { percent: now.percent });
        default:
            return t(`chat.homeMemory.title`);
    }
});
// The figures behind the percentage, for a developer; the panel says what they mean to anyone.
const hint = computed((): Tip => {
    const tokens = card.contextTokens;
    const figures = !maker.value && tokens !== undefined && budget.value !== undefined && budget.value > 0;
    return {
        title: t(`chat.homeMemory.title`),
        rows: figures
            ? [
                  { label: t(`chat.homeMemory.used`), value: formatTokens(tokens) },
                  { label: t(`chat.homeMemory.freshAt`), value: formatTokens(budget.value ?? 0) },
              ]
            : undefined,
        // Under a budget of zero it never starts fresh by itself, so the note would promise what will not happen.
        note: reading.value?.kind === `unbudgeted` ? undefined : t(`chat.homeMemory.tipNote`),
    };
});

const open = ref(false);
const trigger = ref<HTMLElement>();
const refusal = ref<string>();
// A refusal belongs to the press that met it: opening the panel again starts clean.
const toggle = (): void => {
    open.value = !open.value;
    refusal.value = undefined;
};
// Both presses are refused while a turn writes to the record (the daemon's rewind lease), so they wait for it here.
const working = computed(() => turnInFlight(card));
const pending = computed(() => (reading.value?.kind === `pending` ? reading.value.why : undefined));

const starting = ref(false);
const startFresh = async (): Promise<void> => {
    if (starting.value) {
        return;
    }
    starting.value = true;
    refusal.value = await startFreshHome(conversation.value);
    starting.value = false;
    open.value = refusal.value !== undefined;
};

const confirming = ref(false);
const clearing = ref(false);
const clear = async (): Promise<void> => {
    if (clearing.value) {
        return;
    }
    clearing.value = true;
    refusal.value = await clearHomeHistory(conversation.value);
    clearing.value = false;
    confirming.value = false;
    open.value = refusal.value !== undefined;
};
</script>

<template>
    <template v-if="reading !== undefined">
        <button
            ref="trigger"
            type="button"
            class="touch-target inline-flex items-center gap-1 transition-colors hover:text-content"
            :class="{ 'text-link': reading.kind === `pending` }"
            :aria-expanded="open"
            :aria-label="label"
            data-home-memory
            v-tooltip.top="hint"
            @click="toggle"
        >
            <!-- The ring the context reading draws, filled against the budget instead: what a narrow strip keeps. -->
            <ProgressRing v-if="reading.kind === `fill`" :value="reading.percent" class="text-accent" />
            <Icon v-else :name="reading.kind === `pending` ? `refresh` : `history`" class="text-2xs" />
            <span class="tabular-nums @max-xs:hidden">{{ label }}</span>
        </button>
        <ResponsiveOverlay v-model="open" :anchor="trigger" cross="end" :header="t(`chat.homeMemory.title`)" panel-class="w-80">
            <div class="flex flex-col gap-2 p-3 text-xs">
                <p class="font-medium text-content">{{ t(`chat.homeMemory.title`) }}</p>
                <p class="text-subtle">{{ t(`chat.homeMemory.explain`) }}</p>
                <p v-if="pending === `asked`" class="text-link">{{ t(`chat.homeMemory.pendingAsked`) }}</p>
                <p v-else-if="pending === `cleared`" class="text-link">{{ t(`chat.homeMemory.pendingCleared`) }}</p>
                <p v-else-if="reading.kind === `fill`" class="text-content">{{ t(`chat.homeMemory.filled`, { percent: reading.percent }) }}</p>
                <p v-else-if="reading.kind === `unbudgeted`" class="text-content">{{ t(`chat.homeMemory.neverByItself`) }}</p>
                <div v-if="own" class="flex flex-wrap gap-1.5">
                    <Button
                        size="small"
                        tier="boring"
                        :label="t(`chat.homeMemory.startFresh`)"
                        :disabled="working || pending !== undefined || clearing"
                        :loading="starting"
                        @click="startFresh"
                    />
                    <Button
                        size="small"
                        tier="quiet"
                        tone="danger"
                        :label="t(`chat.homeMemory.clear`)"
                        :disabled="working || starting"
                        @click="confirming = true"
                    />
                </div>
                <p v-if="own && working" class="text-2xs text-subtle">{{ t(`chat.homeMemory.waitForReply`) }}</p>
                <p v-if="refusal !== undefined" class="text-2xs text-warning">{{ refusal }}</p>
            </div>
        </ResponsiveOverlay>
        <ConfirmDialog
            :open="confirming"
            :header="t(`chat.homeMemory.confirmHeader`)"
            :description="maker ? t(`chat.homeMemory.plain.confirmBody`) : t(`chat.homeMemory.confirmBody`)"
            :confirm-label="t(`chat.homeMemory.confirmLabel`)"
            confirm-icon="trash"
            :loading="clearing"
            @cancel="confirming = false"
            @confirm="clear"
        />
    </template>
</template>
