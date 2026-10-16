<script setup lang="ts">
import type { IntenticOsChannel, IntenticOsStatus, IntenticOsUpdateCheck } from "@intentic/sandbox-contract/schemas/intentic-os";
import { Button, DeviceRunLog, Notice, SegmentedControl, StatusBadge, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { OsRunEnd } from "../../desktop";
import {
    CHANNELS,
    canRollBack,
    canSwitchChannel,
    channelOf,
    checkSaidOf,
    endSaidOf,
    healthOf,
    isolationOf,
    nextChannelOf,
    restartOf,
    waitingOf,
    waitingVersionOf,
    type OsRestart,
    type OsRunProgress,
} from "./systemCard";

// THIS SYSTEM, on This device when this computer runs Intentic OS (system.ts holds it, the app's os.rs runs `ic os`): its
// edition, version and channel, the boot's health and the checks that failed, how sandboxes are isolated, and what waits
// for the next boot with the restart into it in front of the reader. Below, the quieter changes: check for updates, go
// back to the previous version, the other channel. While a change runs, its lines; after, how it ended.

const t = useT();

const props = defineProps<{
    status: IntenticOsStatus;
    /** A change under way, this window's or another's. */
    progress?: OsRunProgress;
    /** How the last change ended. */
    end?: OsRunEnd;
    /** A change asked for here that never ran. */
    error?: string;
    check?: IntenticOsUpdateCheck;
    checking: boolean;
    checkError?: string;
    /** Another run on this device is going: a change waits for it. */
    busy: boolean;
}>();
const emit = defineEmits<{
    restart: [restart: OsRestart];
    check: [];
    download: [];
    rollBack: [];
    channel: [channel: IntenticOsChannel];
    dismiss: [];
    log: [path: string];
}>();

const running = computed(() => props.progress !== undefined);
const held = computed(() => props.busy || running.value);
const health = computed(() => healthOf(props.status));
const isolation = computed(() => isolationOf(props.status));
const waiting = computed(() => waitingOf(props.status));
const restart = computed(() => restartOf(props.status));
const checkSaid = computed(() => checkSaidOf(props.check, props.status));
const endSaid = computed(() => endSaidOf(props.end));
// In front of the reader: a restart waiting, a change under way or just ended, and a boot whose checks failed.
const prominent = computed(
    () => waiting.value !== undefined || running.value || props.end !== undefined || props.error !== undefined || health.value.verdict === `failing`,
);

// An edition or channel a newer image names is shown as ic says it rather than as a missing message.
const editionName = computed(() =>
    props.status.edition === `desktop` || props.status.edition === `server` ? t(`desktop.os.edition.${props.status.edition}`) : props.status.edition,
);
const channelName = (value: string): string => {
    const channel = channelOf(value);
    return channel === undefined ? value : t(`desktop.os.channelName.${channel}`);
};
const summary = computed(() => [t(`desktop.os.version`, { version: props.status.version }), editionName.value].join(` · `));

const waitingSentence = computed(() => {
    const version = waitingVersionOf(props.status);
    if (waiting.value === `rollback`) {
        return version === undefined ? t(`desktop.os.waiting.rollback`) : t(`desktop.os.waiting.rollbackTo`, { version });
    }
    return version === undefined ? t(`desktop.os.waiting.update`) : t(`desktop.os.waiting.updateTo`, { version });
});

const runningLabel = computed(() => {
    const progress = props.progress;
    if (progress === undefined) {
        return ``;
    }
    if (progress.verb === `channel`) {
        return progress.channel === undefined ? t(`desktop.os.running.channel`) : t(`desktop.os.running.channelTo`, { channel: channelName(progress.channel) });
    }
    if (progress.verb === `update` || progress.verb === `rollback`) {
        return t(`desktop.os.running.${progress.verb}${progress.apply ? `Apply` : ``}`);
    }
    return t(`desktop.os.running.reboot`);
});

/* THE CHANNEL: the one the next boot runs, and the other at the reader's word. */
const nextChannel = computed(() => nextChannelOf(props.status));
const channelOptions = computed(() => CHANNELS.map((value) => ({ value, label: channelName(value) })));
const pickChannel = (value: string): void => {
    const channel = channelOf(value);
    if (channel !== undefined && channel !== nextChannel.value) {
        emit(`channel`, channel);
    }
};
</script>

<template>
    <section class="flex flex-col gap-3 rounded-xl p-4" :class="prominent ? `bg-card shadow-sm` : `border border-line`" :aria-busy="running">
        <header class="flex items-start gap-2.5">
            <Icon v-if="running" name="spinner" spin class="mt-0.5 shrink-0 text-link" />
            <Icon v-else name="linux" class="mt-0.5 shrink-0 text-subtle" />
            <div class="min-w-0 flex-1">
                <h2 class="text-sm leading-tight font-semibold">{{ t(`desktop.os.title`) }}</h2>
                <p class="mt-1 text-xs text-muted">{{ summary }}</p>
            </div>
            <StatusBadge class="shrink-0" size="xs" dot :variant="health.tone" :label="t(`desktop.os.health.${health.verdict}`)" />
        </header>

        <!-- The boot's checks that failed, in ic's words: greenboot restarts a boot that keeps failing them, and goes back
             to the previous version after three. -->
        <div v-if="health.failed.length > 0" class="flex flex-col gap-1 text-2xs">
            <p class="text-muted">{{ t(`desktop.os.failedChecks`) }}</p>
            <p v-for="failed in health.failed" :key="failed" class="flex items-start gap-1.5 text-danger">
                <Icon name="times-circle" class="mt-0.5 shrink-0" />
                <span class="min-w-0 break-words">{{ failed }}</span>
            </p>
        </div>

        <!-- How sandboxes are kept apart from this computer, and when the microVMs the policy asks for are missing. -->
        <p class="flex items-start gap-1.5 text-2xs text-subtle">
            <Icon name="shield" class="mt-0.5 shrink-0" />
            <span>{{ t(`desktop.os.isolation.${isolation.mode}`) }}</span>
        </p>
        <Notice v-if="isolation.vmMissing" tone="warning" class="text-2xs">{{
            isolation.mode === `vm` ? t(`desktop.os.vmMissing.vm`) : t(`desktop.os.vmMissing.auto`)
        }}</Notice>

        <!-- Under way: what it is doing, and every line ic prints as it prints it. -->
        <template v-if="progress">
            <p class="text-xs font-medium text-content">{{ runningLabel }}</p>
            <DeviceRunLog :lines="progress.lines" :running="true" :note="t(`desktop.os.keepsGoing`)" />
        </template>

        <!-- WHAT WAITS FOR THE NEXT BOOT, and the restart into it: the one press on this card that restarts this computer. -->
        <div v-else-if="restart" class="flex flex-col gap-2">
            <p class="flex items-start gap-1.5 text-xs text-content">
                <Icon :name="waiting === `rollback` ? `undo` : `download`" class="mt-0.5 shrink-0 text-link" />
                <span>{{ waitingSentence }}</span>
            </p>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button
                    size="small"
                    tier="accent"
                    :label="restart === `applyUpdate` ? t(`desktop.os.restartToUpdate`) : t(`desktop.os.restartIntoPrevious`)"
                    :disabled="held"
                    @click="emit(`restart`, restart)"
                >
                    <template #icon><Icon name="refresh" /></template>
                </Button>
                <span class="min-w-0 flex-1 text-2xs text-subtle">{{ t(`desktop.os.restartNote`) }}</span>
            </div>
        </div>

        <!-- How the last change ended. One that did what it said needs no words: the status read after it shows it. -->
        <Notice v-if="endSaid === `restarting`" tone="info" icon="refresh" class="text-xs">{{ t(`desktop.os.restarting`) }}</Notice>
        <Notice v-else-if="endSaid === `busy`" tone="warning" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="emit(`dismiss`)">
            {{ t(`desktop.os.busy`) }}
        </Notice>
        <Notice v-else-if="endSaid === `notOs`" tone="warning" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="emit(`dismiss`)">
            {{ t(`desktop.os.notOs`) }}
        </Notice>
        <Notice v-else-if="end && (endSaid === `failed` || endSaid === `timedOut`)" tone="danger" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="emit(`dismiss`)">
            <span class="block font-medium">{{ t(`desktop.os.didntFinish.${end.verb}`) }}</span>
            <span v-if="end.reason" class="mt-0.5 block font-mono text-2xs break-words">{{ end.reason }}</span>
            <span v-if="endSaid === `timedOut`" class="mt-1 block">{{ t(`desktop.os.timedOut`) }}</span>
            <button v-if="end.log" type="button" :class="ui.textButton({ tone: `quiet` }, `mt-1`)" @click="emit(`log`, end.log)">
                {{ t(`desktop.os.showLog`) }}
            </button>
        </Notice>
        <Notice v-else-if="error" tone="danger" class="text-xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="emit(`dismiss`)">
            <span class="block font-medium">{{ t(`desktop.os.didntStart`) }}</span>
            <span class="mt-0.5 block font-mono text-2xs break-words">{{ error }}</span>
        </Notice>

        <!-- What the last check found: a newer version to download now, or nothing newer. -->
        <template v-if="!running">
            <div v-if="checkSaid?.kind === `available`" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span class="min-w-0 flex-1">{{
                    checkSaid.version === undefined ? t(`desktop.os.available`) : t(`desktop.os.availableVersion`, { version: checkSaid.version })
                }}</span>
                <Button size="small" tier="boring" :label="t(`desktop.os.download`)" :disabled="held" @click="emit(`download`)">
                    <template #icon><Icon name="download" /></template>
                </Button>
            </div>
            <p v-else-if="checkSaid?.kind === `current`" class="flex items-start gap-1.5 text-2xs text-subtle">
                <Icon name="check-circle" class="mt-0.5 shrink-0" />
                <span>{{ t(`desktop.os.upToDate`) }}</span>
            </p>
            <Notice v-if="checkError" tone="warning" class="text-2xs">
                <span class="block font-medium">{{ t(`desktop.os.checkFailed`) }}</span>
                <span class="mt-0.5 block font-mono break-words">{{ checkError }}</span>
            </Notice>
        </template>

        <!-- THE QUIETER CHANGES: none restarts anything, and each that changes the next boot asks first. -->
        <footer v-if="!running" class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-2.5">
            <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="checking || held" @click="emit(`check`)">
                <Icon :name="checking ? `spinner` : `refresh`" :spin="checking" class="shrink-0" />
                <span>{{ checking ? t(`desktop.os.checking`) : t(`desktop.os.checkForUpdates`) }}</span>
            </button>
            <button v-if="canRollBack(status)" type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="held" @click="emit(`rollBack`)">
                <Icon name="undo" class="shrink-0" />
                <span>{{ t(`desktop.os.rollBack`) }}</span>
            </button>
            <span class="flex-1" />
            <div class="flex items-center gap-2">
                <span class="text-2xs text-subtle">{{ t(`desktop.os.channelLabel`) }}</span>
                <SegmentedControl
                    v-if="canSwitchChannel(status) && !held"
                    size="xs"
                    :options="channelOptions"
                    :model-value="nextChannel"
                    @update:model-value="pickChannel"
                />
                <span v-else class="text-2xs font-medium text-content">{{ channelName(nextChannel) }}</span>
            </div>
        </footer>
        <!-- A switch waits for the restart like any update: until then this computer runs the channel it booted. -->
        <p v-if="nextChannel !== status.channel" class="text-2xs text-subtle">
            {{ t(`desktop.os.channelNext`, { channel: channelName(nextChannel), current: channelName(status.channel) }) }}
        </p>
    </section>
</template>
