<!-- THE APP'S INSTALL, DRAWN ON THE PAGE IT WAS STARTED FROM.
     The desktop app runs the install in its own card and hands the window back to this page when the user
     presses "Back to your workspace"; what this page could say about it afterwards was nothing, which is the
     reported problem: no way to tell whether leaving the card stopped the install, or how it was going. So the
     app reports its bar here on every change (desktopSetup.ts) and this draws the same bar: the same
     percentage, the same "Step 4 of 10", the same estimate, and the way back to the card for the detail.
     Five states, one sentence each, because the reader of this strip is deciding one thing: wait, or go and
     look. A run that needs them (the requirements list) says so; a run that stopped says whether they stopped
     it; a run that has gone quiet says the app may have gone. -->
<script setup lang="ts">
import { Button, Notice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { DESKTOP_LAUNCHER_LINK, openDesktopLink, type DesktopSetupReport } from "../../app/environments/desktop";

const { report, heardAt } = defineProps<{ report: DesktopSetupReport; heardAt: number | undefined }>();

// A live run reports every second. Past this with nothing heard, the app itself is the thing to go and check.
const QUIET_MS = 20_000;
const now = useNow(() => report.state === `running`);
const quiet = computed(() => report.state === `running` && heardAt !== undefined && now.value - heardAt > QUIET_MS);

const what = computed(() => (report.name === undefined ? `your sandbox` : report.name));
const showSetup = (): void => openDesktopLink(DESKTOP_LAUNCHER_LINK);
</script>

<template>
    <!-- `done` draws nothing: the app opens the workspace itself the moment the run ends well, and a strip
         saying "done" under a page that is about to navigate away is a flash of the wrong screen. -->
    <div v-if="report.state !== `done`" class="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
        <template v-if="report.state === `running` || report.state === `waiting`">
            <div class="flex items-baseline gap-2 text-2xs">
                <span class="flex-1 font-medium text-content">
                    <template v-if="report.state === `waiting`">Waiting for you in the Intentic window</template>
                    <template v-else-if="quiet">Installing {{ what }} on this device: no word from the app for a while</template>
                    <template v-else>Installing {{ what }} on this device</template>
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
                        It found things this PC needs first and is asking before changing anything. Nothing continues until you answer.
                    </template>
                    <template v-else-if="quiet">
                        It reports every second while it runs. If the Intentic window is gone, start the app again: the install picks up
                        from where it was.
                    </template>
                    <template v-else>Closing the setup card didn't stop it. This page opens your workspace the moment it answers.</template>
                </span>
                <Button
                    size="small"
                    severity="secondary"
                    :label="report.state === `waiting` ? `Answer it` : `Show the setup`"
                    class="shrink-0"
                    @click="showSetup"
                />
            </div>
        </template>

        <!-- Stopped by the user, or by something going wrong: told apart, because "you stopped it" needs no
             investigation and "it stopped" needs the card that has the reason. -->
        <template v-else>
            <Notice :tone="report.state === `failed` ? `danger` : `info`" class="items-center text-2xs">
                <span class="flex-1">
                    <template v-if="report.state === `failed`">
                        Setting up {{ what }} on this device stopped. The Intentic window has the reason, and a way to try again.
                    </template>
                    <template v-else>You stopped setting up {{ what }} on this device. Nothing else is running there.</template>
                </span>
                <Button size="small" severity="secondary" :label="report.state === `failed` ? `See why` : `Open the setup`" class="ml-2 shrink-0" @click="showSetup" />
            </Notice>
        </template>
    </div>
</template>
