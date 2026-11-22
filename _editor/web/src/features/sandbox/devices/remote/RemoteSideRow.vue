<!-- One environment of a computer, as remote access sees it (remoteOffers.ts): its screen and a terminal there, each a
     press away or, when not, the one sentence saying why, and the shells already running there, to open or close. -->
<script setup lang="ts">
import { BrandMark, Button, ConfirmDialog, Icon, Row, useDevice } from "@intentic/ui";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { errorMessage } from "@intentic/base/errors";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useCapabilities } from "../../../../models/capabilities/useCapabilities";
import { osMark, platformName } from "../../../../models/sandbox/devices/deviceFacts";
import { screenRoute } from "../../../../models/sandbox/devices/deviceLinks";
import type { DeviceRow } from "../../../../models/sandbox/devices/deviceRows";
import { type RemoteTerminalInfo, useRemoteApi, useRemoteStatus } from "../../../../models/sandbox/devices/remote/remoteApi";
import { environmentName, primaryMonitor, remoteSide, type StatusRead, statusWanted, terminalTitle } from "../../../../models/sandbox/devices/remote/remoteOffers";
import { closeDeviceTerminal, deviceTabName } from "../../../../models/terminal/deviceTerminals";
import { environmentTitle } from "../machineEnvironments";
import { attachDeviceTerminal, openDeviceTerminal } from "./remoteActions";

const { row, machineKey, machineName } = defineProps<{
    row: DeviceRow;
    machineKey: string;
    machineName: string;
}>();

const t = useT();
const router = useRouter();
const { mobile } = useDevice();
const api = useRemoteApi();

const query = useRemoteStatus(() => (statusWanted(row) ? row.device.hostId : undefined));
const read = computed<StatusRead | undefined>(() => {
    if (!statusWanted(row)) {
        return undefined;
    }
    if (query.data.value !== undefined) {
        return { kind: `answered`, status: query.data.value };
    }
    return query.error.value === null ? { kind: `waiting` } : { kind: `refused`, reason: errorMessage(query.error.value) };
});
const side = computed(() => remoteSide(row, read.value));
// The switches live on the computer's card (its form, an agent, another window can flip them), so a status whose `allow`
// no longer matches the card is read again at once rather than at the next poll.
const { capabilities } = useCapabilities();
const stale = computed(() => {
    const config = capabilities.value.find((capability) => capability.id === row.device.card)?.config;
    const allow = query.data.value?.allow;
    if (config === undefined || allow === undefined) {
        return false;
    }
    return (
        (config[`remoteView`] === `on`) !== allow.view ||
        (config[`remoteControl`] === `on`) !== allow.control ||
        (config[`remoteTerminal`] === `on`) !== allow.terminal
    );
});
watch(
    stale,
    (now) => {
        if (now && !query.isFetching.value) {
            void query.refetch();
        }
    },
    { immediate: true },
);
const mark = computed(() => osMark(row.device));
const title = computed(() => environmentTitle(row));
// The one line under the name: why nothing here opens, else why one of the two does not, else nothing.
const note = computed(() => {
    const now = side.value;
    if (now === undefined) {
        return undefined;
    }
    if (now.checking) {
        return t(`sandbox.deviceRemote.checking`);
    }
    if (now.blocked !== undefined) {
        return now.blocked;
    }
    const reasons = [now.screen, now.terminal].flatMap((offer) => (offer !== undefined && !offer.ready ? [offer.reason] : []));
    return reasons.length === 0 ? undefined : reasons.join(` `);
});

// A tab names the computer and the side's short name ("rog · Windows", "rog · archlinux"), not the OS's full one.
const tabTitle = (environment: string): string => terminalTitle(machineName, environment, platformName(row.device) ?? title.value);
const failure = ref<string | undefined>();
const opening = ref(false);
const openTerminal = async (): Promise<void> => {
    const now = side.value;
    if (now === undefined || opening.value) {
        return;
    }
    failure.value = undefined;
    opening.value = true;
    try {
        await openDeviceTerminal({ device: now.device, environment: now.environment, title: tabTitle(now.environment) }, api, mobile.value, router);
    } catch (error) {
        failure.value = errorMessage(error);
    } finally {
        opening.value = false;
    }
};
const openScreen = (): void => {
    const now = side.value;
    if (now !== undefined) {
        void router.push(screenRoute(machineKey, now.device, primaryMonitor(now.monitors)?.id));
    }
};
const attach = (terminal: RemoteTerminalInfo): void => {
    const now = side.value;
    if (now !== undefined) {
        attachDeviceTerminal({ device: now.device, session: terminal.session, environment: terminal.environment, title: tabTitle(terminal.environment) }, mobile.value, router);
    }
};

// Closing a shell ends whatever runs in it, over there: asked first.
const closing = ref<RemoteTerminalInfo | undefined>();
const close = async (): Promise<void> => {
    const now = side.value;
    const terminal = closing.value;
    closing.value = undefined;
    if (now !== undefined && terminal !== undefined) {
        await closeDeviceTerminal(deviceTabName(now.device, terminal.session), api);
        await query.refetch();
    }
};
// Where it runs only when that is not this side itself, which the row above already names.
const terminalLine = (terminal: RemoteTerminalInfo): string =>
    [
        ...(terminal.environment === side.value?.environment ? [] : [environmentName(terminal.environment, title.value)]),
        t(`sandbox.deviceRemote.started`, { when: timeAgo(terminal.createdAt) }),
        ...(terminal.viewers > 0 ? [t(`sandbox.deviceRemote.viewers`, { count: terminal.viewers }, terminal.viewers)] : []),
    ].join(` · `);
</script>

<template>
    <template v-if="side">
        <Row :description="note" indent>
            <template #lead="{ mark: size }">
                <BrandMark :size="size" :name="title" :icon="mark.icon" :tint="mark.tint" :plain="true" :idle="side.blocked !== undefined" />
            </template>
            <template #title>{{ title }}</template>
            <template #control>
                <div class="flex shrink-0 items-center gap-1">
                    <Button
                        v-if="side.screen"
                        size="small"
                        tier="boring"
                        :label="t(`sandbox.deviceRemote.screen`)"
                        :disabled="!side.screen.ready"
                        @click="openScreen"
                    >
                        <template #icon><Icon name="screen" /></template>
                    </Button>
                    <Button
                        size="small"
                        tier="boring"
                        :label="t(`sandbox.deviceRemote.terminal`)"
                        :disabled="!side.terminal.ready"
                        :loading="opening"
                        @click="openTerminal"
                    >
                        <template #icon><Icon name="terminal" /></template>
                    </Button>
                </div>
            </template>
            <!-- Under the name it belongs to: why a terminal did not open, and the shells already running here, from this
                 browser or any other, each a press from a tab. -->
            <template v-if="failure || side.terminals.length > 0" #below>
                <p v-if="failure" class="text-xs text-danger">{{ failure }}</p>
                <div v-for="terminal in side.terminals" :key="terminal.session" class="flex min-w-0 items-center gap-2">
                    <span class="shrink-0 font-mono text-xs text-content">{{ terminal.title }}</span>
                    <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ terminalLine(terminal) }}</span>
                    <Button size="small" tier="quiet" :label="t(`sandbox.deviceRemote.attach`)" @click="attach(terminal)" />
                    <Button size="small" tier="quiet" tone="danger" :label="t(`sandbox.deviceRemote.close`)" @click="closing = terminal" />
                </div>
            </template>
        </Row>
        <ConfirmDialog
            :open="closing !== undefined"
            :header="t(`sandbox.deviceRemote.closeHeader`)"
            :description="t(`sandbox.deviceRemote.closeBody`, { name: machineName })"
            :confirm-label="t(`sandbox.deviceRemote.closeConfirm`)"
            @cancel="closing = undefined"
            @confirm="void close()"
        />
    </template>
</template>
