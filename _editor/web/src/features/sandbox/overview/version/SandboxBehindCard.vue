<script setup lang="ts">
import { machinesOf } from "@intentic/sandbox-contract";
import { Button, Code, CopyButton, Notice, RowGroup, RowNote } from "@intentic/ui";
import { computed, ref } from "vue";
import { daemonBehind, daemonDrifted, driftedRoutes, missingRoutes } from "../useDaemonRoutes";
import { useEnvironment } from "../../environment/useEnvironment";
import { runSeveringDeviceCommand, useDevices, useHostHolding } from "../../devices/useDevices";
import { useHubWork } from "../../../../shell/hub/hubWork";
import ConnectDeviceHint from "../../devices/ConnectDeviceHint.vue";
import { useT } from "@intentic/ui/i18n";

// Checks the daemon's route surface against this app's contract, not version strings (SandboxUpdateCard); catches
// gaps a version compare misses (dev packages are all 0.0.0). A missing route names the daemon as older; a drifted
// payload only proves disagreement, so the heading never guesses. Non-blocking: an old sandbox keeps working.

// A route name with no dot is its own area, not a hole in the list.
const t = useT();

const areas = (names: readonly string[]): string[] => [...new Set(names.map((name) => name.split(`.`)[0] ?? name))].toSorted();
// Display label overrides for area name casing (`vpn` -> `VPN`).
const AREA_LABEL: Readonly<Record<string, string>> = { ci: `CI`, vpn: `VPN` };
const areaLabel = (name: string): string => AREA_LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
const missingLabel = computed(() => areas(missingRoutes.value).map(areaLabel).join(`, `));
const driftedLabel = computed(() => areas(driftedRoutes.value).map(areaLabel).join(`, `));
// Dev gets the reload; a non-dev user is pointed at the update card instead.
const isDev = import.meta.env.DEV;
const { slug, localImage } = useEnvironment();
// Dev daemon runs the bind-mounted working tree, not the image: a reload fixes drift, a rebuild doesn't.
const reloadCommand = computed(() => `sh _sandbox/sandbox/scripts/dev-reload.sh${slug.value === undefined ? `` : ` ${slug.value}`}`);
const reloadPage = (): void => location.reload();

// The environment holding this sandbox's checkout, when it is a connected device: then the reload is a button here
// and the command below is only for a checkout nothing can reach. The checkout, not merely the machine — a PC reports
// this container through its Windows side too, and the reload is a `sh` line in a folder only one side has.
const running = useHostHolding(
    () => slug.value,
    () => localImage.value?.root,
);
const { devices } = useDevices({ poll: false });
const onlineDevices = computed(() => devices.value.filter((device) => device.hostId !== undefined && device.online === true));
// dev-reload.sh is a unix line whatever else is true, so a door that runs one itself is the first choice; a Windows
// door is still offered when it is the only one, since the daemon crosses into that PC's distro from there.
const unixDoors = computed(() => onlineDevices.value.filter((device) => device.platform !== `windows`));
// Which machine runs this sandbox is itself read off the daemon's fleet payload, so a daemon far enough behind to
// disagree about that payload answers "none" — and the one button that fixes it would vanish with the field it was
// gated on, exactly when this card is on screen. A single online machine is not a guess, so it is offered: the reload's
// argv names this sandbox's own slug on the far side, so a machine that doesn't hold it refuses rather than restarting
// something else. Two of them is a guess, and stays the printed command; two doors onto one PC (Windows and a distro
// on it) are one machine, and the distro's door is the one that can run the script.
const hostId = computed(
    () => running.value ?? (machinesOf(onlineDevices.value).length === 1 ? (unixDoors.value[0] ?? onlineDevices.value[0])?.hostId : undefined),
);
const hubWork = useHubWork();
const reloading = ref(false);
const reloaded = ref(false);
const failed = ref<string | undefined>(undefined);
// A refusal (an older container with no checkout recorded, a device with commands switched off) hands the command
// back, since the button has just proved it cannot do this here.
const showCommand = computed(() => hostId.value === undefined || failed.value !== undefined);

const reloadOnDevice = async (): Promise<void> => {
    const id = hostId.value;
    if (id === undefined || reloading.value) {
        return;
    }
    reloading.value = true;
    failed.value = undefined;
    reloaded.value = false;
    const endMark = hubWork.begin(`Reloading the sandbox`);
    try {
        // Undefined is the expected ending: the container being restarted is the one answering this request.
        await runSeveringDeviceCommand(id, `dev-reload`);
        reloaded.value = true;
    } catch (error) {
        failed.value = error instanceof Error ? error.message : String(error);
    } finally {
        reloading.value = false;
        endMark();
    }
};

const heading = computed(() => (daemonBehind.value ? `Sandbox is behind the app` : `App and sandbox are out of sync`));
const detail = computed(() =>
    daemonBehind.value
        ? `${missingLabel.value} won't work until the sandbox is reloaded.`
        : `${driftedLabel.value} may show blank values or fail to save.`,
);
</script>

<template>
    <RowGroup v-if="daemonBehind || daemonDrifted" :label="heading">
        <RowNote variant="block">
            <div class="flex flex-col gap-3">
                <p class="text-xs text-muted">{{ detail }}</p>

                <div v-if="isDev" class="flex flex-col gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                        <!-- Compiles and restarts the daemon out there; this page's own connection dies with it. -->
                        <Button
                            v-if="hostId"
                            :label="reloading ? t(`sandbox.sandboxBehindCard.reloading`) : t(`sandbox.sandboxBehindCard.reloadSandbox`)"
                            size="small"
                            :loading="reloading"
                            @click="void reloadOnDevice()"
                        >
                            <template #icon><Icon name="bolt" /></template>
                        </Button>
                        <Button
                            v-if="daemonDrifted || reloaded"
                            :label="t(`sandbox.sandboxBehindCard.reloadPage`)"
                            size="small"
                            severity="secondary"
                            @click="reloadPage"
                        />
                        <span v-if="hostId" class="text-2xs text-subtle">
                            <template v-if="reloaded">{{ t(`sandbox.sandboxBehindCard.rebuiltOnReloadPage`, { hostId }) }}</template>
                            <template v-else-if="reloading">{{ t(`sandbox.sandboxBehindCard.compilingOnRestartingContainer`, { hostId }) }}</template>
                            <template v-else>{{ t(`sandbox.sandboxBehindCard.compilesWorkingTreeOn`, { hostId }) }}</template>
                        </span>
                    </div>
                    <Notice v-if="failed" tone="warning" class="text-2xs">{{ failed }}</Notice>
                    <div v-if="showCommand" class="flex flex-wrap items-center gap-2">
                        <span class="text-2xs text-subtle">{{
                            daemonDrifted && !failed ? t(`sandbox.sandboxBehindCard.stillHereRun`) : t(`sandbox.sandboxBehindCard.run`)
                        }}</span>
                        <div class="sandbox-reload-command flex min-w-0 flex-1 items-center rounded-md border border-line bg-canvas">
                            <Code class="min-w-0 flex-1" :code="reloadCommand" lang="bash" :copyable="false" />
                            <CopyButton
                                :text="reloadCommand"
                                :label="t(`ui.action.copy`)"
                                :aria-label="t(`sandbox.sandboxBehindCard.copyReloadCommand`)"
                                class="mr-1"
                            />
                        </div>
                    </div>
                    <!-- Only where the button never had a chance: a refusal means the door is open and something else went wrong, which connecting a second time would not fix. -->
                    <ConnectDeviceHint v-if="!hostId" :slug="slug" gains="this becomes a button." />
                </div>
                <div v-else-if="daemonDrifted" class="flex flex-wrap items-center gap-2">
                    <Button :label="t(`sandbox.sandboxBehindCard.reloadPage`)" size="small" @click="reloadPage" />
                    <span class="text-2xs text-subtle">{{ t(`sandbox.sandboxBehindCard.staysUpdateSandboxImage`) }}</span>
                </div>
                <p v-else class="text-2xs text-subtle">{{ t(`sandbox.sandboxBehindCard.updateSandboxImage`) }}</p>
            </div>
        </RowNote>
    </RowGroup>
</template>

<style scoped>
/* Keep Code's syntax highlighting and theme; let the row itself own the border and copy button styling. */
.sandbox-reload-command :deep(.shiki),
.sandbox-reload-command :deep(pre) {
    border: 0;
    background-color: transparent !important;
}
</style>
