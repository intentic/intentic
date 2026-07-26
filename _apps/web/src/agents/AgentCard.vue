<script setup lang="ts">
import { ProgressRing, useDevice } from "@intentic-app/ui";
import { computed } from "vue";
import { useRouter } from "vue-router";
import ProviderLogo from "../chat/ProviderLogo.vue";
import {
    activityIcon,
    agentStatusMeta,
    attentionReason,
    contextPct,
    formatCost,
    formatElapsed,
    formatTokens,
} from "../composables/agents/agentStatus";
import { createTitleEdit } from "../composables/agents/titleEdit";
import { laneOf, type FleetAgent } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { modelLabelFor } from "../composables/chat/conversation";

/* One fleet agent, mock-level hierarchy: provider mark + title + status/attention chip; model · branch meta;
 * a self-hiding stats row (tokens ↑in/out · cost · files · +ins −dels · msgs · context ring); the live
 * activity line while running; time-ago / Completed footer. `now` ticks from AgentsView so every card's
 * elapsed readout advances together without per-card timers. The title renames in place (hover pencil →
 * inline input); the root is a div-button, not a <button>, so the nested pencil/input stay valid HTML. */

const props = defineProps<{ agent: FleetAgent; now: number; dragging?: boolean; busy?: boolean }>();
const emit = defineEmits<{ open: []; grab: [event: PointerEvent, card: HTMLElement] }>();

const { mobile } = useDevice();
const meta = computed(() => agentStatusMeta(props.agent.status));
const router = useRouter();
const lane = computed(() => laneOf(props.agent));
const reason = computed(() => attentionReason(props.agent));
const context = computed(() => contextPct(props.agent.contextTokens, props.agent.contextWindow));
const model = computed(() => (props.agent.model !== undefined ? modelLabelFor(props.agent.provider, props.agent.model) : undefined));
const displayTitle = computed(() => props.agent.title ?? (props.agent.status === `draft` ? `New agent` : `Untitled agent`));

const edit = createTitleEdit(
    () => props.agent.id,
    () => props.agent.title,
);
// A blur-commit's click on the card body must commit the rename, not also open the agent.
const openCard = (): void => {
    if (edit.editing || edit.consumeSuppressedOpen()) {
        return;
    }
    emit(`open`);
};

// Offer the card to the board's drag as long as the press starts on the card BODY — the rename pencil and its
// input run their own pointer gestures, and a press while renaming belongs to the input's caret.
const grab = (event: PointerEvent): void => {
    if (edit.editing || !(event.currentTarget instanceof HTMLElement) || !(event.target instanceof Element)) {
        return;
    }
    if (event.target.closest(`input, button`) !== null) {
        return;
    }
    emit(`grab`, event, event.currentTarget);
};
</script>

<template>
    <div
        role="button"
        tabindex="0"
        :aria-label="`Open agent: ${displayTitle}`"
        class="group flex w-full cursor-pointer select-none flex-col gap-1.5 rounded-lg border bg-card p-3 text-left outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary-500/25"
        :class="[
            lane === 'attention' ? 'border-warning/50 hover:border-warning/80' : 'border-line hover:border-line-strong',
            dragging ? 'opacity-40' : '',
            busy ? 'pointer-events-none opacity-60' : '',
        ]"
        @pointerdown="grab"
        @click="openCard"
        @keydown.enter.self.prevent="openCard"
        @keydown.space.self.prevent="openCard"
    >
        <div class="flex items-center gap-2">
            <ProviderLogo :provider="agent.provider" class="shrink-0 text-sm text-muted" />
            <input
                v-if="edit.editing"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                aria-label="Agent title"
                class="min-w-0 flex-1 select-text rounded bg-overlay px-1 text-xs font-semibold text-content outline-none ring-1 ring-primary-500/50"
                @click.stop
                @keydown.enter.stop.prevent="edit.commit()"
                @keydown.esc.stop.prevent="edit.cancel()"
                @blur="edit.blurCommit()"
                @vue:mounted="edit.focusInput"
            />
            <template v-else>
                <span class="min-w-0 flex-1 truncate text-xs font-semibold text-content">{{ displayTitle }}</span>
                <button
                    type="button"
                    aria-label="Rename agent"
                    v-tooltip.top="'Rename'"
                    class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-opacity hover:bg-overlay hover:text-content"
                    :class="mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'"
                    @click.stop="edit.begin()"
                >
                    <Icon name="pencil" class="text-2xs" />
                </button>
            </template>
            <Icon v-if="busy" name="spinner" spin class="shrink-0 text-xs text-link" />
            <span v-else-if="reason !== undefined" class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold text-warning">{{
                reason
            }}</span>
            <span v-else-if="agent.unread" class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-px text-2xs font-semibold text-link">New</span>
            <Icon v-else :name="meta.icon" :spin="meta.spin" class="shrink-0 text-xs" :class="meta.class" />
        </div>
        <p v-if="edit.error !== undefined" class="text-2xs text-danger">{{ edit.error }}</p>

        <div class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
            <span v-if="model !== undefined" class="truncate">{{ model }}</span>
            <template v-if="agent.branch !== undefined">
                <span v-if="model !== undefined">·</span>
                <Icon name="code" class="shrink-0 text-2xs" />
                <span class="truncate font-mono">{{ agent.branch }}</span>
            </template>
        </div>

        <div
            v-if="agent.inputTokens !== undefined || agent.costUsd !== undefined || agent.diff !== undefined || agent.turns !== undefined"
            class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-muted"
        >
            <span v-if="agent.inputTokens !== undefined" v-tooltip.top="'Tokens in / out'">
                <Icon name="arrow-circle-up" class="mr-0.5 text-2xs" />{{ formatTokens(agent.inputTokens)
                }}<template v-if="agent.outputTokens !== undefined"> / {{ formatTokens(agent.outputTokens) }}</template>
            </span>
            <!-- The card's cost is this agent's lifetime total; the Usage tab is where it breaks down by day
                 and model. A nested button, so the click opens the breakdown instead of the agent (the drag
                 gesture already excludes buttons). -->
            <button
                v-if="agent.costUsd !== undefined"
                type="button"
                class="cursor-pointer transition-colors hover:text-content hover:underline"
                v-tooltip.top="'Cost across this agent\'s turns — open the usage breakdown'"
                @click.stop="router.push({ name: `sandbox`, params: { tab: `usage` }, query: { agent: agent.id } })"
            >
                {{ formatCost(agent.costUsd) }}
            </button>
            <span v-if="agent.diff !== undefined && agent.diff.files > 0" v-tooltip.top="'Files the agent changed'">
                <Icon name="copy" class="mr-0.5 text-2xs" />{{ agent.diff.files }}
            </span>
            <span v-if="agent.diff !== undefined && (agent.diff.insertions > 0 || agent.diff.deletions > 0)" class="font-mono">
                <span class="text-success">+{{ agent.diff.insertions }}</span>
                <span class="text-danger"> −{{ agent.diff.deletions }}</span>
            </span>
            <span v-if="agent.turns !== undefined && agent.turns > 0" v-tooltip.top="'Completed turns'">
                <Icon name="comments" class="mr-0.5 text-2xs" />{{ agent.turns }}
            </span>
            <span v-if="context !== undefined" class="inline-flex items-center gap-1" v-tooltip.top="'Context window fill'">
                <ProgressRing :value="context" :class="context >= 80 ? 'text-warning' : 'text-primary-500'" />
                <span>{{ context }}%</span>
            </span>
        </div>

        <p v-if="agent.status === 'running' && agent.activity !== undefined" class="flex min-w-0 items-center gap-1.5 text-2xs text-link">
            <Icon :name="activityIcon(agent.activity.tool)" class="shrink-0 text-2xs" />
            <span class="truncate">{{ agent.activity.todo ?? [agent.activity.tool, agent.activity.target].filter(Boolean).join(" · ") }}</span>
        </p>

        <div class="flex items-center gap-2 text-2xs text-subtle">
            <span v-if="lane === 'finished' && agent.status !== 'draft'" class="inline-flex items-center gap-1 text-muted">
                <Icon name="check" class="text-2xs" />Completed
            </span>
            <span class="flex-1"></span>
            <span v-if="agent.startedAt !== undefined" class="text-link">{{ formatElapsed(agent.startedAt, now) }}</span>
            <span v-else-if="agent.updatedAt > 0">{{ relativeTime(agent.updatedAt) }}</span>
        </div>
    </div>
</template>
