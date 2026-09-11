<script setup lang="ts">
import { Button, Code, CopyButton, Notice, RowGroup, RowNote } from "@intentic/ui";
import { computed, ref } from "vue";
import { daemonBehind, daemonDrifted, driftedRoutes, missingRoutes } from "./useDaemonRoutes";
import { useEnvironment } from "../environment/useEnvironment";
import { runSeveringDeviceCommand, useHostRunning } from "../devices/useDevices";
import ConnectDeviceHint from "../devices/ConnectDeviceHint.vue";

// Checks the daemon's route surface against this app's contract, not version strings (SandboxUpdateCard); catches
// gaps a version compare misses (dev packages are all 0.0.0). A missing route names the daemon as older; a drifted
// payload only proves disagreement, so the heading never guesses. Non-blocking: an old sandbox keeps working.

// A route name with no dot is its own area, not a hole in the list.
const areas = (names: readonly string[]): string[] => [...new Set(names.map((name) => name.split(`.`)[0] ?? name))].toSorted();
// Display label overrides for area name casing (`vpn` -> `VPN`).
const AREA_LABEL: Readonly<Record<string, string>> = { ci: `CI`, vpn: `VPN` };
const areaLabel = (name: string): string => AREA_LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
const missingLabel = computed(() => areas(missingRoutes.value).map(areaLabel).join(`, `));
const driftedLabel = computed(() => areas(driftedRoutes.value).map(areaLabel).join(`, `));
// Dev gets the reload; a non-dev user is pointed at the update card instead.
const isDev = import.meta.env.DEV;
const { slug } = useEnvironment();
// Dev daemon runs the bind-mounted working tree, not the image: a reload fixes drift, a rebuild doesn't.
const reloadCommand = computed(() => `sh _sandbox/sandbox/scripts/dev-reload.sh${slug.value === undefined ? `` : ` ${slug.value}`}`);
const reloadPage = (): void => location.reload();

// The machine this sandbox runs on, when it is a connected device: then the reload is a button here and the
// command below is only for a checkout nothing can reach.
const hostId = useHostRunning(() => slug.value);
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
    try {
        // Undefined is the expected ending: the container being restarted is the one answering this request.
        await runSeveringDeviceCommand(id, `dev-reload`);
        reloaded.value = true;
    } catch (error) {
        failed.value = error instanceof Error ? error.message : String(error);
    } finally {
        reloading.value = false;
    }
};

const heading = computed(() => (daemonBehind.value ? `Sandbox is behind the app` : `App and sandbox are out of sync`));
const detail = computed(() =>
    daemonBehind.value ? `${missingLabel.value} won't work until the sandbox is reloaded.` : `${driftedLabel.value} may show blank values or fail to save.`,
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
                            :label="reloading ? `Reloading…` : `Reload sandbox`"
                            size="small"
                            :loading="reloading"
                            @click="void reloadOnDevice()"
                        >
                            <template #icon><Icon name="bolt" /></template>
                        </Button>
                        <Button v-if="daemonDrifted || reloaded" label="Reload page" size="small" severity="secondary" @click="reloadPage" />
                        <span v-if="hostId" class="text-2xs text-subtle">
                            <template v-if="reloaded">Rebuilt on {{ hostId }} — reload this page to pick it up.</template>
                            <template v-else-if="reloading">
                                Compiling on {{ hostId }} and restarting the container: this can take a minute, and the connection drops as it
                                comes back.
                            </template>
                            <template v-else>Compiles the working tree on {{ hostId }} and restarts this sandbox.</template>
                        </span>
                    </div>
                    <Notice v-if="failed" tone="warning" class="text-2xs">{{ failed }}</Notice>
                    <div v-if="showCommand" class="flex flex-wrap items-center gap-2">
                        <span class="text-2xs text-subtle">{{ daemonDrifted && !failed ? `Still here? Run` : `Run` }}</span>
                        <div class="sandbox-reload-command flex min-w-0 flex-1 items-center rounded-md border border-line bg-canvas">
                            <Code class="min-w-0 flex-1" :code="reloadCommand" lang="bash" :copyable="false" />
                            <CopyButton :text="reloadCommand" label="Copy" aria-label="Copy reload command" class="mr-1" />
                        </div>
                    </div>
                    <!--
                        Only where the button never had a chance: a refusal means the door is open and something else
                        went wrong, which connecting a second time would not fix.
                    -->
                    <ConnectDeviceHint v-if="!hostId" :slug="slug" gains="this becomes a button." />
                </div>
                <div v-else-if="daemonDrifted" class="flex flex-wrap items-center gap-2">
                    <Button label="Reload page" size="small" @click="reloadPage" />
                    <span class="text-2xs text-subtle">If it stays, update the sandbox image.</span>
                </div>
                <p v-else class="text-2xs text-subtle">Update the sandbox image.</p>
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
