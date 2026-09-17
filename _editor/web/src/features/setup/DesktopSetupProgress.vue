<!-- THE APP'S INSTALL, DRAWN ON THE PAGE IT WAS STARTED FROM. -->
<script setup lang="ts">
import { Button, Notice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { DESKTOP_LAUNCHER_LINK, openDesktopLink, type DesktopSetupReport } from "../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { report, heardAt } = defineProps<{ report: DesktopSetupReport; heardAt: number | undefined }>();

// A live run reports every second. Past this with nothing heard, the app itself is the thing to go and check.
const QUIET_MS = 20_000;
const now = useNow(() => report.state === `running`);
const quiet = computed(() => report.state === `running` && heardAt !== undefined && now.value - heardAt > QUIET_MS);

const what = computed(() => (report.name === undefined ? `your sandbox` : report.name));
const showSetup = (): void => openDesktopLink(DESKTOP_LAUNCHER_LINK);
</script>

<template>
    <!-- `done` draws nothing: the app opens the workspace itself the moment the run ends well. -->
    <div v-if="report.state !== `done`" class="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
        <template v-if="report.state === `running` || report.state === `waiting`">
            <div class="flex items-baseline gap-2 text-2xs">
                <span class="flex-1 font-medium text-content">
                    <template v-if="report.state === `waiting`">{{ t(`setup.desktopSetupProgress.waitingInIntenticWindow`) }}</template>
                    <template v-else-if="quiet">{{ t(`setup.desktopSetupProgress.installingOnDeviceNo`, { what }) }}</template>
                    <template v-else>{{ t(`setup.desktopSetupProgress.installingOnDevice`, { what }) }}</template>
                </span>
                <span v-if="report.position" class="text-subtle">{{ report.position }}</span>
                <span v-if="report.remaining && report.state === `running`" class="text-subtle">· {{ report.remaining }}</span>
                <span class="font-mono tabular-nums text-muted">{{ report.percent }}%</span>
            </div>
            <div class="h-1.5 overflow-hidden rounded-full bg-canvas">
                <div
                    class="h-full rounded-full transition-[width] duration-500 ease-out"
                    :class="report.state === `waiting` ? `bg-warning` : `bg-primary-400`"
                    :style="{ width: `${Math.max(report.percent, 2)}%` }"
                />
            </div>
            <div class="flex items-center gap-3 text-2xs text-muted">
                <span class="min-w-0 flex-1">
                    <template v-if="report.state === `waiting`">
                        {{ t(`setup.desktopSetupProgress.foundThingsPcNeeds`) }}
                    </template>
                    <template v-else-if="quiet">
                        {{ t(`setup.desktopSetupProgress.reportsEverySecondWhile`) }}
                    </template>
                    <template v-else>{{ t(`setup.desktopSetupProgress.closingSetupCardDidnt`) }}</template>
                </span>
                <Button
                    size="small"
                    severity="secondary"
                    :label="report.state === `waiting` ? t(`setup.desktopSetupProgress.answer`) : t(`setup.desktopSetupProgress.showSetup`)"
                    class="shrink-0"
                    @click="showSetup"
                />
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
                    severity="secondary"
                    :label="report.state === `failed` ? t(`setup.desktopSetupProgress.seeWhy`) : t(`setup.desktopSetupProgress.openSetup`)"
                    class="ml-2 shrink-0"
                    @click="showSetup"
                />
            </Notice>
        </template>
    </div>
</template>
