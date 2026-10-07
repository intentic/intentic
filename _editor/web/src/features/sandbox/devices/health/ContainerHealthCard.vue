<script setup lang="ts">
import type { Device } from "@intentic/sandbox-contract";
import { Button, Icon, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiClient } from "../../../../lib/useApi";
import { containerNotices, offersReconnect, reconnectDoor } from "../../overview/containerHealth";
import { manageDeviceSandbox, useDevices } from "../useDevices";
import { deviceNotListing } from "../deviceRows";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useRole } from "../../../../client/sandbox/useRole";
import { beginDeviceWork, machineKeyOf } from "../runners/deviceWork";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { active, daemonUrl } = useSandbox();
const { isOwner } = useRole();
const { devices } = useDevices({ poll: false });

const notices = computed(() => (active.value === undefined ? [] : containerNotices(active.value)));

// The daemon hostname's first label is the sandbox slug.
const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));

// The machine this sandbox runs on, through the door of the side that made it where the listing says (reconnectDoor),
// else by the one rule every "run it out there" path shares. Kept as the row, not the id, since the confirmation below
// names the machine.
const hostId = computed(() => reconnectDoor(devices.value, ownSlug.value));
const host = computed<Device | undefined>(() =>
    hostId.value === undefined ? undefined : devices.value.find((device) => device.hostId === hostId.value),
);

// Owner-only: the platform rejects a non-owner's mint, so the button is hidden rather than left to fail.
const canRepair = computed(() => isOwner.value && host.value !== undefined && ownSlug.value !== undefined);

// No door lists this sandbox, yet a connected machine answered without listing and said why: naming it beats asking
// for a connection that exists (2026-10-07, a PC whose `ic` predated `sandbox list --json`).
const unlisted = computed(() => (host.value === undefined ? deviceNotListing(devices.value) : undefined));

// The repair runs out on the machine and ends by replacing this container, so the machine's card and the Devices tile
// say so for as long as it lasts. Asked first, inline: the press says what is replaced and what is kept.
const confirming = ref(false);
const busy = ref(false);
const failure = ref<string | undefined>(undefined);
const done = ref<string | undefined>(undefined);
const lines = ref<string[]>([]);

// The missing env names are evidence for a bug report or a `docker inspect`, not something to act on, so they open
// on asking. One open at a time: in practice there is only ever one drift notice.
const openDetails = ref<string | undefined>(undefined);
const toggleDetails = (key: string): void => {
    openDetails.value = openDetails.value === key ? undefined : key;
};

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
    const machine = host.value === undefined ? undefined : machineKeyOf(devices.value, host.value);
    const endMark =
        machine === undefined
            ? (): void => {}
            : beginDeviceWork({
                  machine,
                  sandboxes: [sandboxId],
                  doing: t(`sandbox.containerHealthCard.reconnectingSandbox`),
                  what: t(`sandbox.containerHealthCard.reconnectingSandbox`),
              });
    try {
        // Minted fresh per call so the code is always current; never cached or reused.
        const { code } = await apiClient.sandbox.setupCode({ sandboxId });
        done.value = await manageDeviceSandbox(deviceId, slug, `reconnect`, {
            setupCode: code,
            onLine: (line) => (lines.value = [...lines.value, line]),
        });
    } catch (error) {
        // The stream dying mid-flight is the success case: the daemon goes down with the container.
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
        confirming.value = false;
        endMark();
    }
};
</script>

<template>
    <!-- Title, one sentence, then the action row: the reader learns what is wrong, why, and the one thing that fixes it,
         without a paragraph. What the fix does is said beside its button, quietly, rather than above it as prose. -->
    <section v-if="notices.length > 0" class="flex flex-col gap-4 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
        <div v-for="(notice, index) of notices" :key="`${notice.fault}:${index}`" class="flex items-start gap-3">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <div class="flex min-w-0 flex-1 flex-col gap-1">
                <p class="text-sm font-medium text-content">{{ notice.title }}</p>
                <p class="text-xs text-muted">{{ notice.detail }}</p>
                <p v-if="notice.repair" class="text-xs text-muted">{{ notice.repair }}</p>

                <!-- Only an out-of-date setup is repaired by reinstalling; every other notice says what to run instead. -->
                <div v-if="offersReconnect(notice)" class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <!-- Named for what it does to the container, not for the fault: "Repair" hides that this replaces it. -->
                    <Button
                        v-if="canRepair && !confirming"
                        size="small"
                        severity="secondary"
                        :label="t(`sandbox.containerHealthCard.reconnectSandbox`)"
                        @click="confirming = true"
                    >
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                    <template v-else-if="canRepair">
                        <Button
                            size="small"
                            :loading="busy"
                            :disabled="busy"
                            :label="busy ? t(`sandbox.containerHealthCard.reconnecting`) : t(`sandbox.containerHealthCard.reconnectSandbox`)"
                            @click="repair"
                        />
                        <Button v-if="!busy" :label="t(`ui.action.cancel`)" size="small" severity="secondary" text @click="confirming = false" />
                    </template>
                    <!-- The same repair by hand, for the owner with no machine connected. Never a member's: /setup on a sandbox
                         they do not own starts a new one on their own account (setupArrival.ts `rowToOpen`). -->
                    <Button
                        v-else-if="isOwner"
                        :as="RouterLink"
                        :to="{ path: `/setup`, query: { sandbox: active?.id } }"
                        size="small"
                        severity="secondary"
                        :label="t(`sandbox.containerHealthCard.openSetupScreen`)"
                    >
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                    <!-- `basis-48`: below that width the caption takes a line of its own instead of squeezing beside the button. -->
                    <!-- Shown at the confirm moment, not as standing prose: what is replaced, and what is kept. -->
                    <p class="min-w-0 grow basis-48 text-2xs text-subtle">
                        <template v-if="canRepair">
                            <template v-if="confirming">
                                {{ t(`sandbox.containerHealthCard.confirmReconnect`, { host: host?.label ?? t(`shared.thisMachine`) }) }}
                            </template>
                        </template>
                        <template v-else-if="!isOwner">{{ t(`sandbox.containerHealthCard.onlySandboxsOwnerReconnect`) }}</template>
                        <template v-else-if="unlisted">
                            <span class="font-mono">{{ unlisted.label }}</span>
                            {{ t(`sandbox.containerHealthCard.machineNotListing`) }}
                            <span class="font-mono break-words">{{ unlisted.sandboxesUnread }}</span>
                        </template>
                        <template v-else>{{ t(`sandbox.containerHealthCard.connectComputerRunsSandbox`) }}</template>
                    </p>
                    <button
                        v-if="notice.keys?.length"
                        type="button"
                        :class="ui.textAction(`ml-auto shrink-0 gap-1 text-2xs`)"
                        :aria-expanded="openDetails === `${notice.fault}:${index}`"
                        @click="toggleDetails(`${notice.fault}:${index}`)"
                    >
                        {{ t(`sandbox.containerHealthCard.details`) }}
                        <Icon
                            name="chevron-right"
                            class="transition-transform"
                            :class="{ 'rotate-90': openDetails === `${notice.fault}:${index}` }"
                            aria-hidden="true"
                        />
                    </button>
                </div>

                <!-- Plain mono chips, selectable by hand: a copy button on a one-word chip sits on top of the word. -->
                <p v-if="notice.keys?.length && openDetails === `${notice.fault}:${index}`" class="flex flex-wrap items-center gap-1.5 text-2xs text-muted">
                    <span>{{ t(`sandbox.containerHealthCard.missingEnv`) }}</span>
                    <code v-for="key of notice.keys" :key="key" class="rounded bg-content/10 px-1 py-0.5 font-mono text-content select-all">{{ key }}</code>
                </p>
            </div>
        </div>

        <!-- The machine's own narration, verbatim; a reconnect takes a while and prints as it goes. Indented to the text column. -->
        <pre v-if="lines.length > 0" class="ml-7 max-h-40 overflow-auto rounded border border-line-subtle p-2 text-2xs text-muted">{{
            lines.join(`\n`)
        }}</pre>
        <p v-if="done" class="ml-7 text-xs text-content">{{ done }}</p>
        <p v-if="failure" class="ml-7 text-xs text-danger">
            {{ failure }}
            <!-- Said next to the error rather than instead of it: this call cuts its own connection by design. -->
            <span class="text-muted">{{ t(`sandbox.containerHealthCard.sandboxReplacedPageReconnects`) }}</span>
        </p>
    </section>
</template>
