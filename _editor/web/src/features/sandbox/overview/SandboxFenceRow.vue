<!-- THIS SANDBOX'S NETWORK FENCE, a row of the Overview's facts beside its share of the machine: what ic holds for it and
     how that stands, with the press that changes it. A hosted sandbox has no private network around it to fence, and
     says so; one on a machine whose agent and ic cannot fence draws nothing. Changing it is maintainer and up. -->
<script setup lang="ts">
import { deviceEnvironment } from "@intentic/sandbox-contract/schemas/devices";
import { HOST_NATIVE_ENVIRONMENT } from "@intentic/sandbox-contract/schemas/hosts";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { canFence, fenceLine } from "../../../models/sandbox/devices/egressFlow";
import { useDevices } from "../../../models/sandbox/devices/useDevices";
import { useSelfResources } from "../../../models/sandbox/devices/useSelfResources";
import NetworkFenceDialog from "../fence/NetworkFenceDialog.vue";

const t = useT();

const sandbox = useSandbox();
const { canShip } = useRole();
const { hostId, slug, row, refetch } = useSelfResources();
const { devices } = useDevices({ poll: false });

const hosted = computed(() => (sandbox.active.value?.hosted ?? null) !== null);
const door = computed(() => devices.value.find((device) => device.hostId !== undefined && device.hostId === hostId.value));
const fences = computed(() => door.value !== undefined && canFence(door.value.facts) && slug.value !== undefined);
const status = computed(() => door.value?.sandboxes?.find((box) => box.slug === slug.value)?.egress);
const line = computed(() => fenceLine(status.value));
const TONE = { default: `text-content`, success: `text-content`, warning: `text-warning`, danger: `text-danger` } as const;

const opened = ref(false);
const said = ref<string | undefined>();
const target = computed(() => ({
    machineId: door.value?.machineId ?? ``,
    environment: (door.value === undefined ? undefined : deviceEnvironment(door.value)) ?? HOST_NATIVE_ENVIRONMENT,
    slug: slug.value ?? ``,
}));
const saved = (message: string): void => {
    opened.value = false;
    said.value = message;
    refetch();
};
</script>

<template>
    <div v-if="hosted || (fences && row)" data-setting="overview-fence" class="grid gap-x-3 gap-y-0.5 @md:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
        <dt class="text-subtle">{{ t(`sandbox.networkFence.rowLabel`) }}</dt>
        <dd v-if="hosted" class="min-w-0 text-muted @md:text-right">{{ t(`sandbox.networkFence.hosted`) }}</dd>
        <dd v-else class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 @md:justify-end">
            <span class="min-w-0 break-words" :class="TONE[line.tone]">{{ line.text }}</span>
            <span v-if="said" class="text-subtle" role="status">{{ said }}</span>
            <button v-if="canShip" type="button" class="shrink-0 font-medium text-link hover:underline" @click="((opened = true), (said = undefined))">
                {{ t(`sandbox.networkFence.change`) }}
            </button>
        </dd>
        <NetworkFenceDialog
            v-if="canShip && fences && hostId !== undefined"
            :open="opened"
            :name="sandbox.active.value?.name ?? slug ?? ``"
            :machine="door?.label ?? ``"
            :host-id="hostId"
            :target="target"
            :status="status"
            @close="opened = false"
            @saved="saved"
        />
    </div>
</template>
