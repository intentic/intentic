<!-- THE APP'S INSTALL, DRAWN ON THE PAGE IT WAS STARTED FROM. -->
<script setup lang="ts">
import { Button, Notice, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, watch } from "vue";
import { DESKTOP_LAUNCHER_LINK, openDesktopLink } from "../../app/environments/desktop";
import type { DesktopSetupReport } from "../../app/environments/desktopSetupReport";
import { useT } from "@intentic/ui/i18n";
import { appSilence, downloadFigures, minutesLeft, slowDownload } from "./desktopRun";
import { tellSlowDownloadOffered } from "./desktopSetup";

const t = useT();

// `putAway`: the app's card for this run was dismissed while the PC still waits for a restart or a sign-out, so there is
// no card left to open and no bar to draw; the press hands the setup to the app again, which lands on that same step.
// `stepSince`: when the app's current step was first heard, which is how long its download has run. `hostedOffered`: a
// machine of ours can be started on this row right now, so a slow download may offer one.
const {
    report,
    heardAt,
    putAway = false,
    stepSince = undefined,
    hostedOffered = false,
} = defineProps<{
    report: DesktopSetupReport;
    heardAt: number | undefined;
    putAway?: boolean;
    stepSince?: number | undefined;
    hostedOffered?: boolean;
}>();
const emit = defineEmits<{ reopen: []; elsewhere: []; hosted: [] }>();

// Parked behind this PC's own setup (Docker, WSL), which the app runs first: no bar of this run's to draw meanwhile.
const pcSetup = computed(() => report.waitingFor === `pcSetup` && (report.state === `running` || report.state === `waiting`));
// Ticks while there is a run that could go quiet, or a download that could outlast its patience.
const now = useNow(() => report.state === `running` || pcSetup.value);
// How long the app has gone unheard against what its kind of app ever does (desktopRun.ts): an older app is quiet for
// minutes during a long download, an app that heartbeats never is.
const silence = computed(() => appSilence(report, heardAt, now.value));
const figures = computed(() => (report.state === `running` ? downloadFigures(report) : undefined));
// The time left in this page's own words where the app gave it in seconds, else the app's own words.
const timeLeft = computed((): string | undefined => {
    const minutes = minutesLeft(report);
    if (minutes === undefined) {
        return report.remaining;
    }
    return minutes === 0
        ? t(`setup.desktopSetupProgress.lessThanMinuteLeft`)
        : t(`setup.desktopSetupProgress.minutesLeft`, { count: minutes }, minutes);
});
// A download too slow to wait for, beside a machine of ours that can start now.
const slow = computed(() => hostedOffered && !putAway && slowDownload(report, stepSince, now.value));
watch(
    slow,
    (offered) => {
        if (offered) {
            tellSlowDownloadOffered(report);
        }
    },
    { immediate: true },
);

const what = computed(() => (report.name === undefined ? t(`setup.desktopSetupProgress.yourSandbox`) : report.name));
const showSetup = (): void => (putAway ? emit(`reopen`) : openDesktopLink(DESKTOP_LAUNCHER_LINK));
// A restart and a sign-out are answered away from both windows, so they are named as themselves rather than as "answer
// it", and offer the hosted machine beside them: a restart in the first minutes is the moment a reader leaves.
const sessionEnd = computed(() => (report.state === `waiting` && (report.waitingFor === `restart` || report.waitingFor === `signOut`) ? report.waitingFor : undefined));
// A question on the app's card, the one wait the reader answers there.
const asking = computed(() => report.state === `waiting` && sessionEnd.value === undefined && !pcSetup.value);
</script>

<template>
    <!-- `done` draws nothing: the app opens the workspace itself the moment the run ends well. -->
    <div v-if="report.state !== `done`" class="flex flex-col gap-2 rounded-lg bg-card shadow-sm p-3">
        <template v-if="report.state === `running` || report.state === `waiting`">
            <div class="flex items-baseline gap-2 text-2xs">
                <span class="flex-1 font-medium text-content">
                    <template v-if="sessionEnd === `restart`">{{ t(`setup.desktopSetupProgress.waitingForRestart`) }}</template>
                    <template v-else-if="sessionEnd === `signOut`">{{ t(`setup.desktopSetupProgress.waitingForSignOut`) }}</template>
                    <template v-else-if="pcSetup">{{ t(`setup.desktopSetupProgress.waitingForPcSetup`) }}</template>
                    <template v-else-if="asking">{{ t(`setup.desktopSetupProgress.waitingForAnswer`) }}</template>
                    <template v-else-if="silence === `gone`">{{ t(`setup.desktopSetupProgress.installingOnDeviceNo`, { what }) }}</template>
                    <template v-else>{{ t(`setup.desktopSetupProgress.installingOnDevice`, { what }) }}</template>
                </span>
                <!-- The app's own account of its run: a replay keeps its words (app/replayText.ts). -->
                <template v-if="!pcSetup">
                    <span v-if="report.position" class="text-subtle" data-replay="diagnostic">{{ report.position }}</span>
                    <span v-if="timeLeft && report.state === `running`" class="text-subtle" data-replay="diagnostic">· {{ timeLeft }}</span>
                    <span v-if="!putAway" class="font-mono tabular-nums text-muted">{{ report.percent }}%</span>
                </template>
            </div>
            <div v-if="!putAway && !pcSetup" class="h-1.5 overflow-hidden rounded-full bg-canvas">
                <div
                    class="h-full rounded-full transition-[width] duration-500 ease-out"
                    :class="report.state === `waiting` ? `bg-warning` : `bg-primary-400`"
                    :style="{ width: `${Math.max(report.percent, 2)}%` }"
                />
            </div>
            <!-- The download in the app's own counts: what the bar alone could not say when its estimate ran out. -->
            <p v-if="figures" class="text-2xs text-muted" data-replay="diagnostic">
                {{
                    figures.unit === `GB`
                        ? t(`setup.desktopSetupProgress.downloadingImageGb`, { done: figures.done, total: figures.total })
                        : t(`setup.desktopSetupProgress.downloadingImageMb`, { done: figures.done, total: figures.total })
                }}
            </p>
            <div class="flex items-center gap-3 text-2xs text-muted">
                <span class="min-w-0 flex-1">
                    <template v-if="sessionEnd === `restart`">{{ t(`setup.desktopSetupProgress.restartBeforeDocker`) }}</template>
                    <template v-else-if="sessionEnd === `signOut`">{{ t(`setup.desktopSetupProgress.signOutBeforeDocker`) }}</template>
                    <!-- Only an app that heartbeats is ever called gone: an older one's silence can be a long download. -->
                    <template v-else-if="silence === `gone`">
                        {{ t(`setup.desktopSetupProgress.appStoppedReporting`, { button: t(`setup.desktopSetupProgress.showSetup`) }) }}
                    </template>
                    <!-- Never "restart the app": a restarted app started a second install beside the first (2026-10-12). -->
                    <template v-else-if="silence === `quiet`">{{ t(`setup.desktopSetupProgress.stillWorkingNoReport`) }}</template>
                    <template v-else-if="pcSetup">{{ t(`setup.desktopSetupProgress.settingUpPcFirst`) }}</template>
                    <template v-else-if="asking">
                        {{ t(`setup.desktopSetupProgress.foundThingsPcNeeds`) }}
                    </template>
                    <template v-else>{{ t(`setup.desktopSetupProgress.closingSetupCardDidnt`) }}</template>
                </span>
                <Button
                    size="small"
                    tier="boring"
                    :label="
                        sessionEnd !== undefined
                            ? t(`setup.desktopSetupProgress.openSetup`)
                            : asking
                              ? t(`setup.desktopSetupProgress.answer`)
                              : t(`setup.desktopSetupProgress.showSetup`)
                    "
                    class="shrink-0"
                    @click="showSetup"
                />
            </div>
            <button v-if="sessionEnd !== undefined" type="button" :class="ui.textButton({ size: `xs` }, `self-start`)" @click="emit(`elsewhere`)">
                {{ t(`setup.desktopSetupProgress.useHostedInstead`) }}
            </button>
            <!-- A calm offer, not a warning: the download is fine, only slow. Taking it stops the download on this PC (Setup.vue),
                 since the machine of ours takes over the sandbox's address, and the offer says so. -->
            <div v-if="slow" class="flex flex-col gap-2 text-2xs text-muted">
                <span>
                    <span class="font-medium text-content">{{ t(`setup.desktopSetupProgress.slowDownload`) }}</span>
                    {{ t(`setup.desktopSetupProgress.slowDownloadInstead`) }}
                </span>
                <Button size="small" :label="t(`setup.desktopSetupProgress.startOnOurServers`)" class="self-start" @click="emit(`hosted`)">
                    <template #icon><Icon name="bolt" /></template>
                </Button>
            </div>
        </template>

        <!-- Stopped by the user, or by something going wrong: told apart. -->
        <template v-else>
            <Notice :tone="report.state === `failed` ? `danger` : `info`" class="items-center text-2xs">
                <span class="flex-1">
                    <template v-if="report.state === `failed`">{{ t(`setup.desktopSetupProgress.settingUpOnDevice`, { what }) }}</template>
                    <template v-else>{{ t(`setup.desktopSetupProgress.stoppedSettingUpOn`, { what }) }}</template>
                </span>
                <Button
                    size="small"
                    tier="boring"
                    :label="report.state === `failed` ? t(`setup.desktopSetupProgress.seeWhy`) : t(`setup.desktopSetupProgress.openSetup`)"
                    class="ml-2 shrink-0"
                    @click="showSetup"
                />
            </Notice>
        </template>
    </div>
</template>
