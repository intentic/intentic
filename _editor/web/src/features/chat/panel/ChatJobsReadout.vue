<script setup lang="ts">
import { AnchoredOverlay, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { formatElapsed } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { openWorkTerminal } from "../../terminal/useWorkTerminals";
import { portsLine, runningJobs } from "../transcript/jobPhase";
import { usePaneView } from "./useChat-view";
import { useT } from "@intentic/ui/i18n";

// Absent while nothing runs; the rows that started the jobs scroll away, this does not.

const t = useT();

const { conversation } = usePaneView();
const { agentById } = useAgents();

const jobs = computed(() => runningJobs(agentById(conversation.value.conversationId)?.jobs));

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const now = useNow(() => open.value && jobs.value.length > 0);

const watchJob = (session: string): void => {
    open.value = false;
    openWorkTerminal(session);
};
</script>

<template>
    <button
        v-if="jobs.length > 0"
        ref="trigger"
        type="button"
        class="touch-target inline-flex items-center gap-1.5 transition-colors hover:text-content"
        :aria-expanded="open"
        :aria-label="t(`chat.chatJobsReadout.running`, { count: jobs.length }, jobs.length)"
        @click="open = !open"
    >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-link motion-safe:animate-pulse"></span>
        <span class="tabular-nums @max-xs:hidden">{{ t(`chat.chatJobsReadout.running`, { count: jobs.length }, jobs.length) }}</span>
        <span class="tabular-nums @xs:hidden">{{ jobs.length }}</span>
    </button>

    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="top" cross="end">
        <div class="flex w-80 max-w-[calc(100vw-1rem)] flex-col p-1">
            <div class="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
                {{ t(`chat.chatJobsReadout.title`) }}
            </div>
            <div v-for="job in jobs" :key="job.id" class="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-overlay">
                <Icon name="spinner" spin class="shrink-0 text-2xs text-link" />
                <span class="min-w-0 flex-1 truncate text-xs text-content">{{ job.label }}</span>
                <span v-if="job.handed === true && job.ports !== undefined" class="shrink-0 font-mono text-2xs text-subtle">{{ portsLine(job.ports) }}</span>
                <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ formatElapsed(job.startedAt, now) }}</span>
                <button
                    type="button"
                    :class="ui.iconButton(`hover:bg-content/10`)"
                    v-tooltip.top="t(`shared.watchInTerminal`)"
                    :aria-label="t(`shared.watchInTerminal`)"
                    @click="watchJob(job.session)"
                >
                    <Icon name="desktop" class="text-2xs" />
                </button>
            </div>
            <p class="px-2 pt-1 pb-1.5 text-2xs leading-relaxed text-subtle">{{ t(`chat.chatJobsReadout.explain`) }}</p>
        </div>
    </AnchoredOverlay>
</template>
