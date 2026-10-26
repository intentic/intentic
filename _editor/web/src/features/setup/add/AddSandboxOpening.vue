<!-- THE NEW SANDBOX'S FIRST START, SEEN FROM WHERE IT WAS MADE: the dialog, or Home's page for it. Once it reports in,
     the setup row selects it and the workspace (or Home's chat) behind connects to it, then waits out its boot chain
     (SandboxGate's "Connecting" and "Starting" pages). Nobody needs to watch those: this keeps the run on screen, says how
     far the boot has got from the daemon's own declared steps (useDaemonBoot.ts, the ones SandboxWarming lists), and says
     `shown` once the workspace is on screen ready to use, or on Home the new sandbox's home conversation
     (models/home/homeChat.ts `homeShownFor`).
     A start that outlasts OPEN_ANYWAY_MS is handed over as it is, so the gate behind can say why. -->
<script setup lang="ts">
import { Meter } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onUnmounted, watch } from "vue";
import { bootSteps } from "../../../client/sandbox/useDaemonBoot";
import { useSandboxGateState } from "../../sandbox/gates/workspaceShown";
import { homeShownFor } from "../../../models/home/homeChat";

const { sandboxId, name } = defineProps<{ sandboxId: string; name: string }>();
const emit = defineEmits<{ shown: [] }>();

const t = useT();
const OPEN_ANYWAY_MS = 120_000;

const { shown } = useSandboxGateState();
const done = computed(() => bootSteps.value.filter((step) => step.state === `done` || step.state === `failed`).length);
const running = computed(() => bootSteps.value.find((step) => step.state === `running`));

// The workspace, or on Home the new sandbox's home conversation: whichever the reader will be looking at once it closes.
watch(
    () => [shown.value, homeShownFor.value] as const,
    (ready) => {
        if (ready.includes(sandboxId)) {
            emit(`shown`);
        }
    },
    { immediate: true },
);
const anyway = setTimeout(() => emit(`shown`), OPEN_ANYWAY_MS);
onUnmounted(() => clearTimeout(anyway));
</script>

<template>
    <div class="flex flex-col gap-2" data-add-sandbox-opening>
        <p class="flex items-center gap-2 text-xs font-medium text-content">
            <Icon name="spinner" spin class="shrink-0 text-xs text-info" />
            {{ t(`setup.addSandbox.gettingReady`, { name }) }}
        </p>
        <template v-if="bootSteps.length > 0">
            <Meter :value="done / bootSteps.length" :label="t(`sandbox.sandboxWarming.stepsDone`, { done, total: bootSteps.length })" />
            <p v-if="running" class="truncate text-2xs text-muted">{{ running.label }}</p>
        </template>
        <p v-else class="text-2xs text-muted">{{ t(`setup.addSandbox.connecting`) }}</p>
    </div>
</template>
