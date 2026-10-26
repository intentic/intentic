<!-- THE COMMAND TO RUN ON A SERVER, on the new sandbox's page once its code is minted (useAddCommand.ts): the shell's
     command or the compose file, copied from here; the reader's own Cloudflare zone when they would rather not use the
     address the platform minted; and the wait for the machine that runs it, which says what it is doing and, when it
     fails, exactly what broke. The row opens by itself once that machine reports in (the registry watch). -->
<script setup lang="ts">
import { Code, CopyButton, InfoHint, SegmentedControl, toneRim, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import CloudflareTokenField from "../../capabilities/connect/CloudflareTokenField.vue";
import { useCloudflareZones } from "../../extensions/useCloudflareZones";
import { lockedReasonOf } from "../flow/commandHandoff";
import SetupCompose from "../SetupCompose.vue";
import SetupHandoff from "../SetupHandoff.vue";
import SetupNudge from "../SetupNudge.vue";
import type { AddSandboxHere } from "./useAddSandboxHere";

const { add } = defineProps<{ add: AddSandboxHere[`add`] }>();

const t = useT();
const { user } = useAuth();
const { command, created } = add;
const { mode, cfToken, step, wait } = command;
const { runTab, runTabOptions, selectedCommand, selectedCommandLang, composeArgs } = step;
const { handoff, reportFailures, buildStage, nudging, stalled, nudgeVariant, nudgeCopyable, slowBuild, onCopied, onEmailed } = wait;
const { mobile } = add;

// The reader's own zone: its token rides the command, read here so leaving the page asks for it again.
const cf = useCloudflareZones();
watch(
    () => [mode.value, cf.cfToken.value, cf.selectedZone.value] as const,
    ([chosen, token, zone]) => {
        cfToken.value = chosen === `own` && zone !== undefined ? token : ``;
    },
    { immediate: true },
);
// Why the command is not on screen yet: the own zone still wants its token or its zone.
const locked = computed(() =>
    mode.value === `own`
        ? lockedReasonOf({
              addressless: false,
              mode: `own`,
              mintError: undefined,
              cfToken: cf.cfToken.value,
              cfTokenValid: cf.cfTokenValid.value,
              zonesLoading: cf.zonesLoading.value,
              zonesError: cf.zonesError.value,
              zone: cf.selectedZone.value,
              subdomainValid: true,
          })
        : undefined,
);
const hostname = computed(() => (mode.value === `own` && cf.selectedZone.value !== undefined ? cf.selectedZone.value : add.minted.value?.hostname));
</script>

<template>
    <div class="flex flex-col gap-3" data-add-sandbox-command>
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
            <span class="text-muted">{{ t(`shared.address`) }}</span>
            <span class="min-w-0 font-mono break-all text-content">{{ hostname }}</span>
            <button type="button" :class="ui.textButton({ size: `xs` })" @click="mode = mode === `own` ? `intentic` : `own`">
                {{ mode === `own` ? t(`setup.setup.useIntenticsDomain`) : t(`setup.setup.ownCloudflareZone`) }}
            </button>
        </div>

        <!-- The reader's own Cloudflare zone: the token is read once for its zones, then rides the command, never kept by us. -->
        <template v-if="mode === `own`">
            <InfoHint :label="t(`views.words.whyCloudflareApiToken`)">
                <span class="block text-sm font-medium text-content">{{ t(`views.words.whyToken`) }}</span>
                <span class="mt-2 block text-xs text-muted">{{ t(`views.words.noOpenPorts`) }}</span>
            </InfoHint>
            <CloudflareTokenField :cf="cf" :storage-note="t(`setup.addSandbox.ownZoneNote`)" />
        </template>

        <div v-if="locked" class="ui-card ui-card-dashed flex items-start gap-2 rounded-none p-3 text-xs text-muted">
            <Icon name="lock" class="shrink-0" />
            <span>{{ locked }}</span>
        </div>
        <template v-else>
            <p class="flex items-center gap-2.5 text-xs text-muted">
                <Icon name="terminal" class="shrink-0 text-link" />
                <span class="min-w-0">{{ mobile ? t(`setup.setup.runOnComputerNotPhone`) : t(`setup.setup.pasteIntoTerminalComputer`) }}</span>
            </p>
            <div class="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
                <SegmentedControl v-model="runTab" :options="runTabOptions" :stretch="mobile" class="[&>button]:py-1 [&>button]:text-xs" />
                <CopyButton v-if="runTab !== `compose`" :text="selectedCommand" :label="t(`ui.action.copy`)" class="text-xs" @copied="onCopied" />
            </div>
            <SetupCompose v-if="runTab === `compose` && composeArgs" :args="composeArgs" />
            <Code v-else :code="selectedCommand" :lang="selectedCommandLang" :wrap="true" :copyable="false" :clamp-lines="mobile ? 4 : undefined" />
            <!-- A phone has no terminal: the link to this page, mailed to the reader for the computer that has one. -->
            <SetupHandoff v-if="mobile && created" :sandbox-id="created.id" :email="user?.email ?? ``" @sent="onEmailed" />
        </template>

        <!-- How far the machine running it has got; never spinning beside the account of what broke. -->
        <p v-if="reportFailures === null" class="flex items-center gap-2 text-xs" :class="handoff === `claimed` ? `text-content` : `text-muted`">
            <Icon name="spinner" spin class="shrink-0" :class="handoff === `claimed` ? `text-success` : `text-subtle`" />
            <span class="min-w-0">
                <template v-if="handoff === `claimed` && buildStage !== undefined">
                    <span class="font-medium text-success">{{ t(`setup.setup.machinePickedUp`) }}</span>
                    {{ t(`setup.setup.rightNow`) }} <span data-replay="diagnostic">{{ buildStage }}</span>.
                </template>
                <template v-else-if="handoff === `claimed`">
                    <span class="font-medium text-success">{{ t(`setup.setup.machinePickedUp`) }}</span>
                    {{ t(`setup.setup.startingDockerFirstRun`) }}
                </template>
                <template v-else-if="handoff === `handed`">
                    <span class="font-medium text-content">{{ t(`setup.setup.copied`) }}</span>
                    {{ t(`setup.setup.pasteIntoTerminalPress`) }}
                </template>
                <template v-else>
                    <span class="font-medium text-content">{{ t(`setup.setup.waitingToRunCommand`) }}</span>
                    {{ t(`setup.setup.wellNoticeMomentSandbox`) }}
                </template>
            </span>
        </p>
        <!-- The machine said exactly what broke: its words, problem and fix per check (a replay keeps them). -->
        <div v-else :class="toneRim(`danger`, `strong`, `ui-card flex flex-col gap-1.5 p-3 text-xs`)" role="alert">
            <span class="font-medium text-danger">{{ t(`setup.setup.failedOnYourMachine`) }}</span>
            <ul class="flex flex-col gap-1.5" data-replay="diagnostic">
                <li v-for="failure in reportFailures" :key="failure.check" class="min-w-0 text-2xs">
                    <span class="font-medium">{{ failure.check }}:</span> {{ failure.problem }}
                    <span v-if="failure.remedy !== ``">{{ t(`setup.setup.fix`, { remedy: failure.remedy }) }}</span>
                </li>
            </ul>
            <p class="text-2xs">{{ t(`setup.setup.fixAboveRunSame`) }}</p>
        </div>
        <SetupNudge v-if="nudging" :variant="nudgeVariant" :stalled="stalled" :command="selectedCommand" :copyable="nudgeCopyable" @copied="onCopied" />
        <p v-if="slowBuild" class="flex items-start gap-2 text-xs text-warning">
            <Icon name="exclamation-circle" class="shrink-0" />
            <span class="min-w-0">{{ t(`setup.setup.pickedUpNoSandbox`, { where: t(`setup.setup.thatTerminal`) }) }}</span>
        </p>
    </div>
</template>
