<!-- THE APP'S INSTALL, DRAWN ON THE PAGE IT WAS STARTED FROM. -->
<script setup lang="ts">
import { Button, Notice, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { DESKTOP_LAUNCHER_LINK, openDesktopLink, type DesktopSetupReport } from "../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

const t = useT();

// `putAway`: the app's card for this run was dismissed while the PC still waits for a restart or a sign-out, so there is
// no card left to open and no bar to draw; the press hands the setup to the app again, which lands on that same step.
const { report, heardAt, putAway = false } = defineProps<{ report: DesktopSetupReport; heardAt: number | undefined; putAway?: boolean }>();
const emit = defineEmits<{ reopen: []; elsewhere: [] }>();

// A live run reports every second. Past this with nothing heard, the app itself is the thing to go and check.
const QUIET_MS = 20_000;
const now = useNow(() => report.state === `running`);
const quiet = computed(() => report.state === `running` && heardAt !== undefined && now.value - heardAt > QUIET_MS);

const what = computed(() => (report.name === undefined ? t(`setup.desktopSetupProgress.yourSandbox`) : report.name));
const showSetup = (): void => (putAway ? emit(`reopen`) : openDesktopLink(DESKTOP_LAUNCHER_LINK));
// A restart and a sign-out are answered away from both windows, so they are named as themselves rather than as "answer
// it", and offer the hosted machine beside them: a restart in the first minutes is the moment a reader leaves.
const sessionEnd = computed(() => (report.state === `waiting` && (report.waitingFor === `restart` || report.waitingFor === `signOut`) ? report.waitingFor : undefined));
</script>

<template>
    <!-- `done` draws nothing: the app opens the workspace itself the moment the run ends well. -->
    <div v-if="report.state !== `done`" class="flex flex-col gap-2 rounded-lg bg-card shadow-sm p-3">
        <template v-if="report.state === `running` || report.state === `waiting`">
            <div class="flex items-baseline gap-2 text-2xs">
                <span class="flex-1 font-medium text-content">
                    <template v-if="sessionEnd === `restart`">{{ t(`setup.desktopSetupProgress.waitingForRestart`) }}</template>
                    <template v-else-if="sessionEnd === `signOut`">{{ t(`setup.desktopSetupProgress.waitingForSignOut`) }}</template>
                    <template v-else-if="report.state === `waiting`">{{ t(`setup.desktopSetupProgress.waitingForAnswer`) }}</template>
                    <template v-else-if="quiet">{{ t(`setup.desktopSetupProgress.installingOnDeviceNo`, { what }) }}</template>
                    <template v-else>{{ t(`setup.desktopSetupProgress.installingOnDevice`, { what }) }}</template>
                </span>
                <!-- The app's own account of its run: a replay keeps its words (app/replayText.ts). -->
                <span v-if="report.position" class="text-subtle" data-replay="diagnostic">{{ report.position }}</span>
                <span v-if="report.remaining && report.state === `running`" class="text-subtle" data-replay="diagnostic">· {{ report.remaining }}</span>
                <span v-if="!putAway" class="font-mono tabular-nums text-muted">{{ report.percent }}%</span>
            </div>
            <div v-if="!putAway" class="h-1.5 overflow-hidden rounded-full bg-canvas">
                <div
                    class="h-full rounded-full transition-[width] duration-500 ease-out"
                    :class="report.state === `waiting` ? `bg-warning` : `bg-primary-400`"
                    :style="{ width: `${Math.max(report.percent, 2)}%` }"
                />
            </div>
            <div class="flex items-center gap-3 text-2xs text-muted">
                <span class="min-w-0 flex-1">
                    <template v-if="sessionEnd === `restart`">{{ t(`setup.desktopSetupProgress.restartBeforeDocker`) }}</template>
                    <template v-else-if="sessionEnd === `signOut`">{{ t(`setup.desktopSetupProgress.signOutBeforeDocker`) }}</template>
                    <template v-else-if="report.state === `waiting`">
                        {{ t(`setup.desktopSetupProgress.foundThingsPcNeeds`) }}
                    </template>
                    <template v-else-if="quiet">
                        {{ t(`setup.desktopSetupProgress.reportsEverySecondWhile`) }}
                    </template>
                    <template v-else>{{ t(`setup.desktopSetupProgress.closingSetupCardDidnt`) }}</template>
                </span>
                <Button
                    size="small"
                    tier="boring"
                    :label="
                        sessionEnd !== undefined
                            ? t(`setup.desktopSetupProgress.openSetup`)
                            : report.state === `waiting`
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
