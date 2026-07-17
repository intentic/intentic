<script setup lang="ts">
import { ProgressRing } from "@intentic-app/ui";
import { providerLabel } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { agentStatusMeta, contextPct, formatCost, formatElapsed, formatTokens } from "../composables/agents/agentStatus";
import type { FleetAgent } from "../composables/agents/useAgents";
import AgentActivity from "./AgentActivity.vue";

/* One fleet agent: status, identity (title · provider/model · branch), live activity, and the visibility row
 * (cost in dollars, tokens, context fill, elapsed). Click = drill in. `now` ticks from AgentsView so every
 * card's elapsed readout advances together without per-card timers. */

const props = defineProps<{ agent: FleetAgent; now: number }>();
defineEmits<{ open: [] }>();

const meta = computed(() => agentStatusMeta(props.agent.status));
const context = computed(() => contextPct(props.agent.contextTokens, props.agent.contextWindow));
const needsYou = computed(() => props.agent.attention.plan || props.agent.attention.question || props.agent.attention.conflict);
</script>

<template>
    <button
        type="button"
        class="flex w-full flex-col gap-1.5 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay"
        :class="{ 'border-primary-500/50': needsYou }"
        @click="$emit('open')"
    >
        <div class="flex items-center gap-2">
            <Icon :name="meta.icon" :spin="meta.spin" class="shrink-0 text-xs" :class="meta.class" />
            <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{ agent.title ?? `Untitled agent` }}</span>
            <span
                v-if="needsYou || agent.unread"
                class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-px text-2xs font-semibold text-link"
                >{{
                    agent.attention.conflict
                        ? `Conflict`
                        : agent.attention.plan
                          ? `Plan`
                          : agent.attention.question
                            ? `Question`
                            : `New`
                }}</span
            >
        </div>
        <div class="flex items-center gap-1.5 text-2xs text-subtle">
            <span class="font-medium" :class="meta.class">{{ meta.label }}</span>
            <span>·</span>
            <span class="truncate">{{ providerLabel(agent.provider) }}<template v-if="agent.model !== undefined"> · {{ agent.model }}</template></span>
        </div>
        <div v-if="agent.branch !== undefined" class="flex items-center gap-1.5 text-2xs text-subtle">
            <Icon name="code" class="text-2xs" />
            <span class="truncate font-mono">{{ agent.branch }}</span>
            <span v-if="agent.base !== undefined" class="truncate font-mono text-subtle/70">from {{ agent.base }}</span>
        </div>
        <AgentActivity v-if="agent.activity !== undefined && agent.status === 'running'" :activity="agent.activity" />
        <div class="flex items-center gap-2 text-2xs text-muted">
            <span v-if="agent.costUsd !== undefined" v-tooltip.top="'Cost across this agent\'s turns'">{{ formatCost(agent.costUsd) }}</span>
            <span v-if="agent.outputTokens !== undefined" v-tooltip.top="'Output tokens'">{{ formatTokens(agent.outputTokens) }} out</span>
            <span v-if="context !== undefined" class="inline-flex items-center gap-1" v-tooltip.top="'Context window fill'">
                <ProgressRing :value="context" :class="context >= 80 ? 'text-warning' : 'text-primary-500'" />
                <span>{{ context }}%</span>
            </span>
            <span class="flex-1"></span>
            <span v-if="agent.startedAt !== undefined">{{ formatElapsed(agent.startedAt, now) }}</span>
        </div>
    </button>
</template>
