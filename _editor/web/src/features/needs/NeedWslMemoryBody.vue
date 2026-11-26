<!-- A wsl-memory need's own answer: what the PC this sandbox runs on measured, the memory= it proposes for its WSL VM as a
     change from what .wslconfig says now, and, plainly, that nothing changes until WSL restarts, which restarts every
     sandbox on that PC. The daemon raises it, never an agent, so the measurements are the case. There is no "restart when
     quiet": nothing restarts a PC's WSL by itself, so the yes writes the file and the restart stays the owner's. -->
<script setup lang="ts">
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import type { WslMemoryNeed } from "@intentic/sandbox-contract/schemas/wsl-memory";
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "../../models/needs/useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: WslMemoryNeed }>();

const needs = useNeeds();
const GIB = 1024 ** 3;
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

const device = computed(() => props.subject.device);
const fit = computed(() => props.subject.fit);
const lead = computed(() =>
    t(`needs.wslMemory.lead`, {
        device: device.value,
        low: gib(fit.value.lowLineBytes),
        share: Math.round(fit.value.underLowShare * 100),
        hours: Math.round((fit.value.windowMs / 3_600_000) * 10) / 10,
        vm: gib(fit.value.vmMedianBytes),
        total: gib(fit.value.totalBytes),
        outside: gib(fit.value.outsideBytes),
    }),
);
const from = computed(() => (fit.value.configuredGb === undefined ? t(`needs.wslMemory.unset`) : `memory=${fit.value.configuredGb}GB`));
const to = computed(() => `memory=${fit.value.proposedGb}GB`);
const caps = computed(() => (fit.value.capsOver ?? []).map((cap) => `${cap.name} (${gib(cap.memoryBytes)})`).join(`, `));

// The need's answer, wherever it is drawn (needAnswer.ts).
const { busy, notice, answer } = useNeedAnswer(() => props.need);
const approve = async (): Promise<void> => {
    const id = props.need.id;
    await answer({ failed: t(`needs.card.couldNotAnswer`), task: () => needs.answer.mutateAsync({ id, answer: { kind: `approve` } }) });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <p class="text-xs text-content/85">{{ lead }}</p>

        <!-- The one line it changes, as it reads now and after the yes, the way a setting change is drawn (NeedChangeFacts). -->
        <p class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs" data-wsl-memory-change>
            <span class="font-mono text-content/85">{{ from }}</span>
            <Icon name="arrow-right" class="text-2xs text-subtle" aria-hidden="true" />
            <span class="font-mono font-medium text-content">{{ to }}</span>
        </p>
        <p class="text-2xs text-subtle">{{ t(`needs.wslMemory.file`, { path: subject.configPath }) }}</p>
        <p v-if="fit.atFloor" class="text-2xs text-subtle" data-wsl-memory-floor>{{ t(`needs.wslMemory.floor`) }}</p>
        <p v-if="caps" class="text-2xs text-subtle" data-wsl-memory-caps>{{ t(`needs.wslMemory.caps`, { caps }) }}</p>

        <!-- Said where the button is: the yes changes nothing until a restart that stops every sandbox on that PC. -->
        <p class="text-xs font-medium text-content" data-wsl-memory-restart>{{ t(`needs.wslMemory.restart`, { device }) }}</p>

        <div v-if="need.status === `open`" class="flex flex-wrap items-center gap-2">
            <ChatDecisionButton tone="primary" icon="check" :disabled="busy" @click="approve">{{ t(`needs.wslMemory.approve`, { setting: to }) }}</ChatDecisionButton>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
