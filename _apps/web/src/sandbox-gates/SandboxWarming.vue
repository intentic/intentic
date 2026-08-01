<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import GateCard from "./GateCard.vue";
import { formatElapsed } from "../composables/agents/agentStatus";
import { bootSteps, bootStartedAt } from "../composables/sandbox/useDaemonBoot";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* Shown while the active daemon is REACHED but not yet READY — the window the sandbox spends listening on
 * /health and /events while its boot chain converges the state every other route serves.
 *
 * That window was invisible before this screen, and the invisibility was the bug. A browser holding a
 * persisted cache painted the whole workspace over it, so a file opened into a read that never returned and a
 * `pnpm build:sandbox && dev-sandbox.sh` swap read as an app that had broken — the fix people found was
 * clearing site data, which only "worked" because an empty cache put the connecting gate up instead.
 *
 * So the wait is a screen, and it says what the daemon is doing. The steps come from the daemon's own declared
 * chain (its main.ts BOOT_STEPS), streamed on /events: a slow boot names its slow step while it is still
 * running, which is the difference between waiting and wondering. */

const { active } = useSandbox();

const title = computed(() => `Starting "${active.value?.name ?? `your sandbox`}"…`);

const done = computed(() => bootSteps.value.filter((step) => step.state === `done` || step.state === `failed`).length);
const running = computed(() => bootSteps.value.find((step) => step.state === `running`));

// One ticker for the total, so a boot that takes minutes visibly keeps moving even between step transitions.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    ticker = setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => clearInterval(ticker));
</script>

<template>
    <GateCard icon="box" :title="title" spinner>
        <p class="text-sm text-muted">
            Your sandbox is up and getting its workspace ready. It opens by itself the moment it can serve — nothing to click.
        </p>
        <template #below>
            <!-- The declared chain, in the order it runs. A daemon too old to report one leaves this empty and the
                 card is the message on its own. -->
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
                        <!-- A failed step is finished, not fatal: the daemon logs it and carries on with that one
                             subsystem degraded, so it reads as a warning and never holds the gate. -->
                        <Icon v-else-if="step.state === 'failed'" name="exclamation-triangle" class="shrink-0 text-warning" />
                        <Icon v-else name="circle" class="shrink-0 text-muted" />
                        <span class="truncate text-2xs text-content">{{ step.label }}</span>
                    </span>
                    <span v-if="step.ms !== undefined" class="shrink-0 font-mono text-2xs text-muted">{{ Math.round(step.ms / 100) / 10 }}s</span>
                </div>
            </div>

            <p class="text-center text-2xs text-muted">
                <template v-if="bootSteps.length > 0">{{ done }} of {{ bootSteps.length }}{{ running ? ` · ${running.label}` : "" }} · </template>
                {{ bootStartedAt === undefined ? "starting" : formatElapsed(bootStartedAt, now) }}
            </p>
        </template>
    </GateCard>
</template>
