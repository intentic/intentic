<script setup lang="ts">
import { Button, Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import Requirements from "../components/Requirements.vue";
import { openUrl, signIn, workspaceOpen, type MachineFolder } from "../desktop";
import {
    endMachineSession,
    machineActionError,
    machineRequirements,
    machineSandbox,
    machineStarting,
    recreateMachine,
    retryMachine,
    revealMachineLog,
    startMachine,
} from "./machineSandbox";
import { DOCKER_DOCS, useDevice } from "./useDevice";

// THIS COMPUTER'S OWN SANDBOX, at the top of This device: the one the app makes after sign-in, in the background, and
// keeps for the folders the reader works on with an agent (the app's machine_sandbox.rs). Every state it can be in is
// said here in a sentence, with the one thing that moves it on: sign in, Docker, the requirements its setup stopped on,
// try again with its log beside it, start it, make a new one. A folder window's card says the same in short and sends
// the reader here for anything with more than a button to it.

const t = useT();
const { dockerStarting, startDocker } = useDevice();

const record = computed(() => machineSandbox.value);
const state = computed(() => record.value?.state);

// The sentence under the heading, for every state: what it is doing, or what it waits for.
const detail = computed((): string | undefined => {
    const held = record.value;
    if (held === undefined) {
        return undefined;
    }
    switch (held.state) {
        case `needsDocker`:
            return t(`desktop.machineSandbox.detail.needsDocker.${held.reason}`);
        case `failed`:
            return t(`desktop.machineSandbox.detail.failed`);
        default:
            return t(`desktop.machineSandbox.detail.${held.state}`);
    }
});

const percent = computed(() => (record.value?.state === `creating` ? record.value.percent : 0));
const step = computed(() => (record.value?.state === `creating` ? record.value.step : undefined));
const reason = computed(() => (record.value?.state === `failed` ? record.value.reason : undefined));
const folders = computed(() => record.value?.folders ?? []);

// The workspace at this computer's sandbox, once it is up.
const open = (): void => {
    const id = record.value?.sandboxId;
    if (id !== undefined) {
        void workspaceOpen(`/?sandbox=${encodeURIComponent(id)}`);
    }
};

const folderWord = (folder: MachineFolder): string => t(`desktop.machineSandbox.folder.${folder.state}`);
</script>

<template>
    <section v-if="record !== undefined" class="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-sm">
        <header class="flex items-start gap-2.5">
            <Icon v-if="state === `creating` || state === `interrupted`" name="spinner" spin class="mt-0.5 shrink-0 text-link" />
            <Icon v-else-if="state === `ready`" name="check-circle" class="mt-0.5 shrink-0 text-success" />
            <Icon v-else-if="state === `signedOut`" name="box" class="mt-0.5 shrink-0 text-subtle" />
            <Icon v-else name="exclamation-circle" class="mt-0.5 shrink-0" :class="state === `failed` || state === `gone` ? `text-danger` : `text-warning`" />
            <div class="min-w-0 flex-1">
                <h2 class="flex flex-wrap items-baseline gap-x-2 text-sm leading-tight font-semibold">
                    <span>{{ t(`desktop.machineSandbox.title`) }}</span>
                    <span class="text-2xs font-normal text-subtle">{{ t(`desktop.machineSandbox.state.${state}`) }}</span>
                </h2>
                <p v-if="record.name" class="truncate text-2xs text-subtle">{{ record.name }}</p>
                <p v-if="detail && state !== `waiting`" class="mt-1 max-w-read-sm text-xs leading-relaxed text-muted">{{ detail }}</p>
            </div>
            <Button v-if="state === `ready`" size="small" tier="boring" class="-my-1 shrink-0" :label="t(`desktop.machineSandbox.open`)" @click="open">
                <template #icon><Icon name="arrow-up-right" /></template>
            </Button>
        </header>

        <!-- Being made: how far, in the setup's own words, while the reader does anything else. -->
        <template v-if="state === `creating`">
            <div
                class="h-1 overflow-hidden rounded-full bg-line"
                role="progressbar"
                :aria-valuenow="percent"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-label="t(`desktop.machineSandbox.title`)"
            >
                <div class="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-smooth" :style="{ width: `${percent}%` }"></div>
            </div>
            <div class="flex items-center gap-3 text-2xs">
                <span class="min-w-0 flex-1 truncate text-subtle" v-tooltip.top="step">{{ step }}</span>
                <span class="shrink-0 tabular-nums text-muted">{{ t(`desktop.machineSandbox.percent`, { percent }) }}</span>
            </div>
        </template>

        <!-- Stopped on what this computer needs first: the same card a handed-over setup asks on, with no hosted way out. -->
        <Requirements
            v-if="state === `waiting`"
            :requirements="machineRequirements"
            :busy="false"
            hide-elsewhere
            @install="retryMachine(true)"
            @restart="endMachineSession(`restart`)"
            @signout="endMachineSession(`signout`)"
            @recheck="retryMachine(false)"
        />

        <Notice v-if="reason" tone="danger" class="text-2xs">
            <span class="block break-words">{{ reason }}</span>
        </Notice>

        <!-- The one thing that moves it on, as the primary press; the log beside a failure. -->
        <div v-if="state !== `creating` && state !== `ready` && state !== `waiting` && state !== `interrupted`" class="flex flex-wrap items-center gap-2">
            <Button v-if="state === `signedOut`" size="small" :label="t(`desktop.machineSandbox.signIn`)" @click="signIn">
                <template #icon><Icon name="sign-in" /></template>
            </Button>
            <template v-if="state === `needsDocker` && record.state === `needsDocker`">
                <Button
                    v-if="record.reason !== `notInstalled`"
                    size="small"
                    :label="t(`desktop.app.startDocker`)"
                    :loading="dockerStarting"
                    @click="startDocker(`card`)"
                />
                <Button
                    v-if="record.reason === `notInstalled`"
                    size="small"
                    :label="t(`desktop.machineSandbox.getDocker`)"
                    @click="openUrl(DOCKER_DOCS)"
                />
            </template>
            <Button v-if="state === `failed`" size="small" :label="t(`ui.action.tryAgain`)" @click="retryMachine(false)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <button v-if="state === `failed` && record.logPath" type="button" :class="ui.textButton({ tone: `quiet` }, `shrink-0`)" v-tooltip.top="record.logPath" @click="revealMachineLog">
                {{ t(`desktop.machineSandbox.showLog`) }}
            </button>
            <Button v-if="state === `stopped`" size="small" :label="t(`desktop.machineSandbox.start`)" :loading="machineStarting" @click="startMachine" />
            <Button v-if="state === `gone`" size="small" :label="t(`desktop.machineSandbox.recreate`)" @click="recreateMachine">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </div>
        <Notice v-if="machineActionError" tone="warning" class="text-2xs">{{ machineActionError }}</Notice>

        <!-- The folders on their way into it, and in it: each by its name there, and how far. -->
        <ul v-if="folders.length > 0" class="flex flex-col gap-1 border-t border-line pt-2.5">
            <li v-for="folder in folders" :key="folder.path" class="flex items-center gap-2 text-2xs">
                <Icon name="folder" class="shrink-0 text-subtle" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate font-mono text-content" v-tooltip.top="folder.path">/work/{{ folder.name }}</span>
                <span class="shrink-0" :class="folder.state === `failed` ? `text-danger` : `text-subtle`" v-tooltip.top="folder.reason ?? folder.status">{{
                    folderWord(folder)
                }}</span>
            </li>
        </ul>
    </section>
</template>
