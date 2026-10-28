<!-- ONE SANDBOX'S NETWORK FENCE AS A LINE OF ITS CARD, beside its files and ports: what ic holds and how it stands, and
     the press that opens the fence to change it. Drawn only where the machine's agent and ic can fence at all
     (`egress`); the warnings that turn on who can step around it (privileged without Kata, commands on this machine)
     are said inside, where they are acted on. Changing it is maintainer and up, as every device op is. -->
<script setup lang="ts">
import { deviceEnvironment } from "@intentic/sandbox-contract/schemas/devices";
import { HOST_NATIVE_ENVIRONMENT } from "@intentic/sandbox-contract/schemas/hosts";
import { type DeviceSandboxGroup, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { canFence, fenceLine } from "../../../models/sandbox/devices/egressFlow";
import { manageable, managerOf, type MachineRow } from "../../../models/sandbox/devices/deviceRows";
import NetworkFenceDialog from "./NetworkFenceDialog.vue";

const t = useT();

const { machine, group, editable, rowClass, labelClass } = defineProps<{
    machine: MachineRow;
    group: DeviceSandboxGroup;
    editable: boolean;
    /** The card's own fact-line classes, so this line lines up with Files and Ports. */
    rowClass: string;
    labelClass: string;
}>();
const emit = defineEmits<{ saved: [] }>();

// The environment the machine's sandbox verbs go through, which carries `set-egress` too.
const door = computed(() => managerOf(machine));
const slug = computed(() => group.sandbox?.slug);
// Every side of a PC lists the same containers; the first that reports this one's fence says it.
const status = computed(() =>
    machine.environments.flatMap((environment) => environment.device.sandboxes ?? []).find((sandbox) => sandbox.slug === slug.value && sandbox.egress !== undefined)
        ?.egress,
);
const hostId = computed(() => door.value?.device.hostId);
const shown = computed(
    () => slug.value !== undefined && door.value !== undefined && manageable(door.value.device, group) && hostId.value !== undefined && canFence(door.value.device.facts),
);
const line = computed(() => fenceLine(status.value));
const TONE = { default: `text-muted`, success: `text-content`, warning: `text-warning`, danger: `text-danger` } as const;
const warned = computed(() => status.value?.hostShell === true || (status.value?.advisory === true && status.value.effectiveProfile !== `open`));

const opened = ref(false);
const said = ref<string | undefined>();
const target = computed(() => ({
    machineId: door.value?.device.machineId ?? ``,
    environment: (door.value === undefined ? undefined : deviceEnvironment(door.value.device)) ?? HOST_NATIVE_ENVIRONMENT,
    slug: slug.value ?? ``,
}));
const saved = (message: string): void => {
    opened.value = false;
    said.value = message;
    emit(`saved`);
};
</script>

<template>
    <div v-if="shown" :class="rowClass">
        <span :class="labelClass">{{ t(`sandbox.networkFence.label`) }}</span>
        <span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span :class="TONE[line.tone]">{{ line.text }}</span>
            <Icon v-if="warned" name="exclamation-triangle" class="text-2xs text-warning" v-tooltip.top="t(`sandbox.networkFence.stepAround`)" />
            <span v-if="said" class="text-subtle" role="status">{{ said }}</span>
            <button
                v-if="editable"
                type="button"
                class="rounded text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-content"
                @click="((opened = true), (said = undefined))"
            >
                {{ t(`sandbox.networkFence.change`) }}
            </button>
        </span>
        <NetworkFenceDialog
            v-if="editable && hostId !== undefined"
            :open="opened"
            :machine="machine.label"
            :host-id="hostId"
            :target="target"
            :status="status"
            @close="opened = false"
            @saved="saved"
        />
    </div>
</template>
