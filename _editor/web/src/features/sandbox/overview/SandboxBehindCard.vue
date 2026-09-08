<script setup lang="ts">
import { Button, Code, CopyButton, RowGroup, RowNote } from "@intentic/ui";
import { computed } from "vue";
import { daemonBehind, daemonDrifted, driftedRoutes, missingRoutes } from "./useDaemonRoutes";
import { useEnvironment } from "../environment/useEnvironment";

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
// Dev gets the reload command; a non-dev user is pointed at the update card instead.
const isDev = import.meta.env.DEV;
const { slug } = useEnvironment();
// Dev daemon runs the bind-mounted working tree, not the image: a reload fixes drift, a rebuild doesn't.
const reloadCommand = computed(() => `sh _sandbox/sandbox/scripts/dev-reload.sh${slug.value === undefined ? `` : ` ${slug.value}`}`);
const reloadPage = (): void => location.reload();

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

                <div v-if="isDev" class="flex flex-wrap items-center gap-2">
                    <Button v-if="daemonDrifted" label="Reload page" size="small" @click="reloadPage" />
                    <span class="text-2xs text-subtle">{{ daemonDrifted ? `Still here? Run` : `Run` }}</span>
                    <div class="sandbox-reload-command flex min-w-0 flex-1 items-center rounded-md border border-line bg-canvas">
                        <Code class="min-w-0 flex-1" :code="reloadCommand" lang="bash" :copyable="false" />
                        <CopyButton :text="reloadCommand" label="Copy" aria-label="Copy reload command" class="mr-1" />
                    </div>
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
