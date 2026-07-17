<script setup lang="ts">
import { ProgressRing } from "@intentic-app/ui";
import { computed } from "vue";
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
import { laneOf, type FleetAgent } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { modelLabelFor } from "../composables/chat/conversation";

/* One fleet agent, mock-level hierarchy: provider mark + title + status/attention chip; model · branch meta;
 * a self-hiding stats row (tokens ↑in/out · cost · files · +ins −dels · msgs · context ring); the live
 * activity line while running; time-ago / Completed footer. `now` ticks from AgentsView so every card's
 * elapsed readout advances together without per-card timers. */

const props = defineProps<{ agent: FleetAgent; now: number }>();
defineEmits<{ open: [] }>();

const meta = computed(() => agentStatusMeta(props.agent.status));
const lane = computed(() => laneOf(props.agent));
const reason = computed(() => attentionReason(props.agent));
const context = computed(() => contextPct(props.agent.contextTokens, props.agent.contextWindow));
const model = computed(() =>
    props.agent.model !== undefined ? modelLabelFor(props.agent.provider, props.agent.harness, props.agent.model) : undefined,
);
</script>

<template>
    <button
        type="button"
        class="flex w-full flex-col gap-1.5 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-overlay"
        :class="lane === 'attention' ? 'border-warning/50 hover:border-warning/80' : 'border-line hover:border-line-strong'"
        @click="$emit('open')"
    >
        <div class="flex items-center gap-2">
            <ProviderLogo :provider="agent.provider" class="shrink-0 text-sm text-muted" />
            <span class="min-w-0 flex-1 truncate text-xs font-semibold text-content">{{
                agent.title ?? (agent.status === "draft" ? "New agent" : "Untitled agent")
            }}</span>
            <span
                v-if="reason !== undefined"
                class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold text-warning"
                >{{ reason }}</span
            >
            <span v-else-if="agent.unread" class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-px text-2xs font-semibold text-link">New</span>
            <Icon v-else :name="meta.icon" :spin="meta.spin" class="shrink-0 text-xs" :class="meta.class" />
        </div>

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
            <span v-if="agent.costUsd !== undefined" v-tooltip.top="'Cost across this agent\'s turns'">{{ formatCost(agent.costUsd) }}</span>
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
    </button>
</template>
