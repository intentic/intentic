<script setup lang="ts">
import { formatTokens, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useRole } from "../../../../client/sandbox/useRole";
import { contextPct } from "../../../../models/agent-status/agentStatus-meta";
import { commandResultOf } from "../../../../models/conversations/commands/commandResult";
import type { SlashRow } from "../../../../models/conversations/commands/slashCommands";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { currentChecklist } from "../../../../models/conversations/transcript/transcript";
import { effortsFor } from "../../../../models/providers/effortScale";
import { modelLabelFor, providerDisplayLabel } from "../../../../models/providers/providerCatalog";
import { poolResetNote } from "../../../../models/providers/usageNotes";
import { formatRemaining, planHeadroom, usageStatusFor } from "../../../../models/providers/usageStatus";
import { modeMeta } from "../../models/catalog";
import ChatTodoList from "../../transcript/ChatTodoList.vue";

// The answer to a `/` command the composer ran itself (composerCommands.ts), over the box it was typed in: what Claude
// Code prints under its prompt for `/usage` or `/context`, said in this chat's own readings. The readouts are read live,
// so a card left open stays true; × or the next send puts it away.

const t = useT();
const view = usePaneView();
const { conversation, provider, account, model, contextUsage, mode, messages, availableCommands } = view;
const { canShip } = useRole();

const held = computed(() => commandResultOf(conversation.value));
const result = computed(() => held.value.value);
const dismiss = (): void => {
    held.value.value = undefined;
};

const selection = computed(() => conversation.value.selection);
const modelRef = computed(() => (model.value === `` ? undefined : { id: model.value }));
const headroom = computed(() => planHeadroom(usageStatusFor(provider.value, account.value, modelRef.value), modelRef.value));
const context = computed(() => {
    const usage = contextUsage.value;
    const pct = contextPct(usage?.tokens, usage?.contextWindow);
    return usage === undefined || pct === undefined ? undefined : { pct, tokens: formatTokens(usage.tokens), window: formatTokens(usage.contextWindow) };
});
// Whether the agent can free the window up itself, which the context answer then says how.
const compacts = computed(() => availableCommands.value.some((command) => command.name === `compact`));
const todos = computed(() => currentChecklist(messages.value));
const levels = computed(() => effortsFor(provider.value, model.value, selection.value.thinking.value));
const status = computed(() => [
    { label: t(`shared.model`), value: `${providerDisplayLabel(provider.value)} · ${modelLabelFor(provider.value, model.value)}` },
    ...(selection.value.capabilities.value.effort && !selection.value.auto.value
        ? [{ label: t(`shared.effort`), value: selection.value.effort.value }]
        : []),
    { label: t(`chat.slashCommands.mode`), value: modeMeta(mode.value).label },
    ...(context.value === undefined ? [] : [{ label: t(`chat.chatPaneStatus.context`), value: `${context.value.pct}%` }]),
]);

const help = computed(() => {
    const rows: readonly SlashRow[] = result.value?.kind === `help` ? result.value.rows : [];
    return { ours: rows.filter((row) => row.local !== undefined), theirs: rows.filter((row) => row.local === undefined) };
});
// A help row writes its command into the box, for the reader to finish and send.
const write = (row: SlashRow): void => {
    view.draft.value = `/${row.name} `;
};
const pickEffort = (value: string, label: string): void => {
    selection.value.apply({ kind: `setEffort`, effort: value });
    held.value.value = { kind: `note`, typed: `effort`, text: t(`chat.slashCommands.effortSet`, { level: label }) };
};
</script>

<template>
    <div
        v-if="result !== undefined"
        class="flex flex-col gap-1.5 rounded-xl border border-line bg-card px-3 py-2 text-2xs text-muted shadow-sm"
        role="status"
        aria-live="polite"
    >
        <div class="flex items-center gap-2">
            <span class="shrink-0 font-mono text-content">/{{ result.typed }}</span>
            <span v-if="result.kind === `note`" class="min-w-0 flex-1" :class="{ 'text-warning': result.tone === `warning` }">{{ result.text }}</span>
            <span v-else class="min-w-0 flex-1 truncate">{{ t(`chat.slashCommands.title.${result.kind}`) }}</span>
            <button
                type="button"
                :class="ui.iconButton({ size: `xs`, tone: `subtle` }, `-mr-1 shrink-0`)"
                :aria-label="t(`chat.slashCommands.dismiss`)"
                @click="dismiss"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </div>

        <div v-if="result.kind === `help`" class="flex max-h-64 flex-col gap-2 overflow-y-auto">
            <section v-for="group in [{ rows: help.ours, label: t(`chat.slashCommands.inThisChat`) }, { rows: help.theirs, label: providerDisplayLabel(provider) }]" :key="group.label">
                <h3 v-if="group.rows.length > 0" class="mb-0.5 text-subtle">{{ group.label }}</h3>
                <button
                    v-for="row in group.rows"
                    :key="row.name"
                    type="button"
                    class="ui-row-select flex w-full items-baseline gap-2 rounded-md px-1.5 py-0.5 text-left"
                    @click="write(row)"
                >
                    <span class="shrink-0 font-mono text-content">/{{ row.name }}</span>
                    <span v-if="row.hint" class="max-w-[30%] shrink-0 truncate font-mono text-subtle">{{ row.hint }}</span>
                    <span class="min-w-0 truncate">{{ row.description }}</span>
                </button>
            </section>
            <p v-if="help.theirs.length === 0">{{ t(`chat.slashCommands.noAgentCommands`, { provider: providerDisplayLabel(provider) }) }}</p>
        </div>

        <template v-else-if="result.kind === `usage`">
            <p v-if="headroom === undefined || headroom.pools.length === 0">{{ t(`chat.slashCommands.noUsage`) }}</p>
            <div v-for="pool in headroom?.pools ?? []" v-else :key="pool.kind" class="flex items-baseline gap-2">
                <span class="min-w-0 flex-1 truncate text-content">{{ pool.label }}</span>
                <span class="shrink-0 tabular-nums">{{ formatRemaining(pool.percent, headroom?.stale ?? false) }}</span>
                <span v-if="poolResetNote(pool)" class="shrink-0 text-subtle">{{ poolResetNote(pool) }}</span>
            </div>
            <RouterLink v-if="canShip" to="/sandbox/usage" class="self-start text-link hover:underline">{{ t(`chat.slashCommands.openUsage`) }}</RouterLink>
        </template>

        <template v-else-if="result.kind === `context`">
            <p v-if="context === undefined">{{ t(`chat.slashCommands.noContext`) }}</p>
            <template v-else>
                <p class="text-content">{{ t(`chat.slashCommands.contextFill`, { pct: context.pct, tokens: context.tokens, window: context.window }) }}</p>
                <p v-if="compacts">{{ t(`chat.slashCommands.compactHint`) }}</p>
            </template>
        </template>

        <dl v-else-if="result.kind === `status`" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <template v-for="row in status" :key="row.label">
                <dt class="text-subtle">{{ row.label }}</dt>
                <dd class="min-w-0 truncate text-content">{{ row.value }}</dd>
            </template>
        </dl>

        <template v-else-if="result.kind === `todos`">
            <ChatTodoList v-if="todos" :todos="todos" :live="conversation.turn.generating.value" dense />
            <p v-else>{{ t(`chat.slashCommands.noTodos`) }}</p>
        </template>

        <div v-else-if="result.kind === `effort`" class="flex flex-wrap gap-1">
            <button
                v-for="level in levels"
                :key="level.value"
                type="button"
                class="ui-row-select rounded-md px-2 py-0.5"
                :class="{ 'ui-row-select-on': level.value === selection.effort.value }"
                @click="pickEffort(level.value, level.label)"
            >
                {{ level.label }}
            </button>
        </div>
    </div>
</template>
