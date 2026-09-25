<script setup lang="ts">
import { computed } from "vue";
import { useNow } from "@intentic/ui/async";
import GateCard from "./GateCard.vue";
import { formatElapsed } from "../../agents/fleet/agentStatus";
import { bootSteps, bootStartedAt } from "../overview/useDaemonBoot";
import { useSandbox } from "../client/useSandbox";
import { useT } from "@intentic/ui/i18n";

// Shown while the active daemon is reached but not yet ready, converging state before other routes work. Steps
// come from the daemon's own declared boot chain, streamed on /events, so a slow boot names its slow step while
// running.

const t = useT();

const { active } = useSandbox();

const title = computed(() => `Starting "${active.value?.name ?? `your sandbox`}"…`);

const done = computed(() => bootSteps.value.filter((step) => step.state === `done` || step.state === `failed`).length);
const running = computed(() => bootSteps.value.find((step) => step.state === `running`));

// The shared clock keeps the total moving, so a slow boot visibly ticks between step transitions.
const now = useNow();
</script>

<template>
    <GateCard icon="box" :title="title" spinner>
        <p class="text-sm text-muted">
            {{ t(`sandbox.sandboxWarming.sandboxUpGettingWorkspace`) }}
        </p>
        <template #below>
            <!-- The declared chain, in run order; a daemon too old to report one just leaves this empty. -->
            <div v-if="bootSteps.length > 0" class="flex flex-col gap-1.5 text-left">
                <div
                    v-for="step in bootSteps"
                    :key="step.key"
                    class="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-3 py-1.5"
                    :class="{ 'opacity-50': step.state === 'pending' }"
                >
                    <span class="flex min-w-0 items-center gap-1.5">
                        <Icon v-if="step.state === 'running'" name="spinner" spin class="shrink-0 text-info" />
                        <Icon v-else-if="step.state === 'done'" name="check-circle" class="shrink-0 text-success" />
                        <!-- A failed step is finished, not fatal: that subsystem degrades but never holds the gate. -->
                        <Icon v-else-if="step.state === 'failed'" name="exclamation-triangle" class="shrink-0 text-warning" />
                        <Icon v-else name="circle" class="shrink-0 text-muted" />
                        <span class="truncate text-2xs text-content">{{ step.label }}</span>
                    </span>
                    <span v-if="step.ms !== undefined" class="shrink-0 font-mono text-2xs text-muted">{{ Math.round(step.ms / 100) / 10 }}s</span>
                </div>
            </div>

            <p class="text-center text-2xs text-muted">
                <template v-if="bootSteps.length > 0"
                    >{{ t(`sandbox.sandboxWarming.stepsDone`, { done, total: bootSteps.length })
                    }}<template v-if="running"> · {{ running.label }}</template> ·
                </template>
                {{ bootStartedAt === undefined ? t(`sandbox.words.starting`) : formatElapsed(bootStartedAt, now) }}
            </p>
        </template>
    </GateCard>
</template>
