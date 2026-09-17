<script setup lang="ts">
import type { Device } from "@intentic/sandbox-contract";
import { Button, Code, Icon } from "@intentic/ui";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiClient } from "../../../lib/useApi";
import { containerNotices } from "../overview/containerHealth";
import { manageDeviceSandbox, useDevices, useHostRunning } from "./useDevices";
import { useSandbox } from "../client/useSandbox";
import { useRole } from "../secrets/useRole";
import { useHubWork } from "../../../shell/hub/hubWork";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { active, daemonUrl } = useSandbox();
const { isOwner } = useRole();
const { devices } = useDevices({ poll: false });

const notices = computed(() => (active.value === undefined ? [] : containerNotices(active.value)));

// The daemon hostname's first label is the sandbox slug.
const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));

// The machine this sandbox runs on, by the one rule every "run it out there" path shares (hostRunningSandbox). Kept
// as the row, not the id, since the confirmation below names the machine.
const hostId = useHostRunning(() => ownSlug.value);
const host = computed<Device | undefined>(() =>
    hostId.value === undefined ? undefined : devices.value.find((device) => device.hostId === hostId.value),
);

// Owner-only: the platform rejects a non-owner's mint, so the button is hidden rather than left to fail.
const canRepair = computed(() => isOwner.value && host.value !== undefined && ownSlug.value !== undefined);

// The repair runs out on the machine and ends by replacing this container, so the row it was pressed on says so
// for as long as it lasts.
const hubWork = useHubWork();

const busy = ref(false);
const failure = ref<string | undefined>(undefined);
const done = ref<string | undefined>(undefined);
const lines = ref<string[]>([]);

const repair = async (): Promise<void> => {
    const deviceId = host.value?.hostId;
    const slug = ownSlug.value;
    const sandboxId = active.value?.id;
    if (busy.value || deviceId === undefined || slug === undefined || sandboxId === undefined) {
        return;
    }
    busy.value = true;
    failure.value = undefined;
    done.value = undefined;
    lines.value = [];
    try {
        done.value = await hubWork.track(`Reconnecting this sandbox`, async () => {
            // Minted fresh per call so the code is always current; never cached or reused.
            const { code } = await apiClient.sandbox.setupCode({ sandboxId });
            return manageDeviceSandbox(deviceId, slug, `reconnect`, {
                setupCode: code,
                onLine: (line) => (lines.value = [...lines.value, line]),
            });
        });
    } catch (error) {
        // The stream dying mid-flight is the success case: the daemon goes down with the container.
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <section v-if="notices.length > 0" class="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
        <div v-for="notice of notices" :key="notice.fault" class="flex flex-col gap-2">
            <div class="flex items-start gap-2">
                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
                <div class="flex min-w-0 flex-col gap-1">
                    <p class="text-sm font-medium text-content">{{ notice.title }}</p>
                    <p class="text-xs text-muted">{{ notice.detail }}</p>
                    <!-- The env by name, for a bug report or a `docker inspect` — evidence a reader may skip, so it sits under the sentence that does not need it. -->
                    <p v-if="notice.keys?.length" class="flex flex-wrap items-center gap-1 text-xs text-muted">
                        <span>{{ t(`sandbox.containerHealthCard.missingContainer`) }}</span>
                        <Code v-for="key of notice.keys" :key="key" :code="key" />
                    </p>
                    <p v-if="notice.repair" class="text-xs text-muted">{{ notice.repair }}</p>
                </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 pl-6">
                <!-- Named for what it does to the container, not for the fault: "Repair" hides that this replaces it. -->
                <Button
                    v-if="canRepair"
                    size="small"
                    severity="secondary"
                    :loading="busy"
                    :disabled="busy"
                    :label="busy ? t(`sandbox.containerHealthCard.reconnecting`) : t(`sandbox.containerHealthCard.reconnectSandbox`)"
                    @click="repair"
                />
                <!-- The same repair by hand, and the only one available to a member or with no machine connected. -->
                <Button
                    v-else
                    :as="RouterLink"
                    :to="{ path: `/setup`, query: { sandbox: active?.id } }"
                    size="small"
                    severity="secondary"
                    :text="true"
                    :label="t(`sandbox.containerHealthCard.openSetupScreen`)"
                >
                    <template #icon><Icon name="arrow-up-right" /></template>
                </Button>
                <p v-if="canRepair" class="text-xs text-muted">
                    {{ t(`sandbox.containerHealthCard.replacesContainer`, { host: host?.label ?? t(`sandbox.containerHealthCard.thisMachine`) }) }}
                </p>
                <p v-else-if="!isOwner" class="text-xs text-muted">{{ t(`sandbox.containerHealthCard.onlySandboxsOwnerReconnect`) }}</p>
                <p v-else class="text-xs text-muted">{{ t(`sandbox.containerHealthCard.connectComputerRunsSandbox`) }}</p>
            </div>
        </div>

        <!-- The machine's own narration, verbatim; a reconnect takes a while and prints as it goes. -->
        <pre v-if="lines.length > 0" class="max-h-40 overflow-auto rounded border border-line-subtle p-2 text-xs text-muted">{{
            lines.join(`\n`)
        }}</pre>
        <p v-if="done" class="text-xs text-content">{{ done }}</p>
        <p v-if="failure" class="text-xs text-danger">
            {{ failure }}
            <!-- Said next to the error rather than instead of it: this call cuts its own connection by design. -->
            <span class="text-muted">{{ t(`sandbox.containerHealthCard.sandboxReplacedPageReconnects`) }}</span>
        </p>
    </section>
</template>
