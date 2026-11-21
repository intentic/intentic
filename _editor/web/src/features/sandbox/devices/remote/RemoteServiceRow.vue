<!-- Windows' lock screen and administrator prompts on this computer (remoteService.ts): whether remoted's own Windows
     service is set up there, and the one thing to do about it, which waits on an administrator's yes at the computer.
     The wait is kept beyond this view (the operations ledger), so a prompt answered after the person left the page still
     lands. A maintainer acts; anyone else reads. -->
<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { Button, Notice, Row } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { accessWords } from "../../../../client/sandbox/access/accessWords";
import type { DeviceRow } from "../../../../models/sandbox/devices/deviceRows";
import {
    type RemoteServiceChange,
    type RemoteServiceState,
    useRemoteService,
    useRemoteServiceApi,
} from "../../../../models/sandbox/devices/remote/remoteApi";
import { type ServiceRead, serviceDeclined, serviceView, serviceWanted } from "../../../../models/sandbox/devices/remote/remoteService";
import { useOperation } from "../../../../workbench/operations/operations";

const { row, machineName, editable } = defineProps<{
    row: DeviceRow;
    machineName: string;
    editable: boolean;
}>();

const t = useT();
const api = useRemoteServiceApi();
const device = computed(() => row.device.hostId);
const query = useRemoteService(() => (serviceWanted(row) ? device.value : undefined));
const read = computed<ServiceRead>(() => {
    if (query.data.value !== undefined) {
        return { kind: `answered`, service: query.data.value };
    }
    return query.error.value === null ? { kind: `waiting` } : { kind: `refused`, reason: errorMessage(query.error.value) };
});

const change = useOperation<RemoteServiceState>(() => `devices/${device.value ?? row.device.key}/remote-service`);
const view = computed(() => serviceView(row, machineName, read.value, change.busy.value, editable));
const declined = computed(() => serviceDeclined(change.value.value, machineName));
const maintainersOnly = computed(() => accessWords({ kind: `tier`, floor: `maintainer` }).short);

// The computer's answer after its prompt; one that did not do what it was asked is a failure in its own words.
const act = (action: RemoteServiceChange, label: string): void => {
    const at = device.value;
    if (at === undefined) {
        return;
    }
    void change.run({
        what: `${t(`sandbox.deviceRemote.serviceTitle`)}: ${label}`,
        failed: t(`sandbox.deviceRemote.serviceFailed`),
        quiet: true,
        task: async () => {
            const answer = await api.changeService(at, action);
            await query.refetch();
            if (answer.error !== undefined) {
                throw new Error(answer.error);
            }
            return answer;
        },
    });
};
</script>

<template>
    <Row :title="t(`sandbox.deviceRemote.serviceTitle`)" :description="t(`sandbox.deviceRemote.serviceNote`)">
        <template #meta>
            <span v-tooltip.top="editable || view.muted ? undefined : maintainersOnly" :class="view.muted ? undefined : `text-content`">{{ view.state }}</span>
        </template>
        <template v-if="view.action" #control>
            <Button size="small" tier="boring" :label="view.action.label" @click="act(view.action.change, view.action.label)" />
        </template>
        <template v-if="declined" #below>
            <p class="text-xs text-muted">{{ declined }}</p>
        </template>
    </Row>
    <Notice v-if="change.failure.value" :of="change.failure.value" />
</template>
