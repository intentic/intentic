<script setup lang="ts">
import type { Device } from "@intentic/sandbox-contract";
import { Button, ConfirmDialog, Icon, Notice, toneTint, ui } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { apiClient } from "../../../../lib/useApi";
import { useOperation } from "../../../../workbench/operations/operations";
import { containerNotices, offersReconnect, reconnectDoor } from "../../overview/containerHealth";
import { manageDeviceSandbox, useDevices } from "../useDevices";
import { deviceNotListing } from "../deviceRows";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useRole } from "../../../../client/sandbox/useRole";
import { beginDeviceWork, machineKeyOf } from "../runners/deviceWork";
import { expectRestart } from "../../live/sandboxRestart";
import { doorsHolding, type MachineDoor } from "../../live/sandboxDoors";
import { useDeviceRelays } from "../../live/useDeviceRelays";
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
// say so for as long as it lasts. Asked first, inline: the press says what is replaced and what is kept. The run, its
// narration and its end are the ledger's, keyed by the machine and this sandbox, so leaving the page mid-reconnect and
// coming back finds it still going (and the button still held) instead of offering it again.
const confirming = ref(false);
const machine = computed(() => (host.value === undefined ? undefined : machineKeyOf(devices.value, host.value)));
const reconnect = useOperation<string>(() => `devices/${machine.value ?? `unknown`}/reconnect/${ownSlug.value ?? ``}`);
const { busy, lines, failure } = reconnect;
const done = reconnect.value;

// TWO COPIES OF THIS SANDBOX, each on a machine one of the owner's sandboxes reaches: which one goes is the owner's call,
// so each is a press of its own rather than the `ic sandbox list` / `ic sandbox remove` recipe. Offered only when both
// copies are found; with one out of reach, the recipe is all there is. The machines are asked again as this shows.
const { relays, look } = useDeviceRelays();
const duplicate = computed(() => isOwner.value && notices.value.some((notice) => notice.fault === `duplicate`));
watch(duplicate, (now) => now && void look(), { immediate: true });
const copies = computed(() => (duplicate.value ? doorsHolding(relays.value, ownSlug.value, active.value?.id) : []));
const pickCopy = computed(() => copies.value.length > 1);
const removingCopy = ref<MachineDoor>();
const copyRemoval = useOperation<string>(() => `devices/duplicate/${ownSlug.value ?? ``}`);
const removeCopy = async (): Promise<void> => {
    const door = removingCopy.value;
    const slug = ownSlug.value;
    removingCopy.value = undefined;
    if (door === undefined || slug === undefined || copyRemoval.busy.value) {
        return;
    }
    await copyRemoval.run({
        what: t(`sandbox.containerHealthCard.removingCopyOn`, { machine: door.machineLabel }),
        failed: t(`sandbox.containerHealthCard.couldntRemoveCopy`, { machine: door.machineLabel }),
        // Either copy may be the one serving this page; through this sandbox, removing that one ends the call with it.
        task: async () => await manageDeviceSandbox(door.hostId, slug, `remove`, { at: door.relay === active.value?.id ? undefined : door.relay, severing: door.severs }),
    });
};

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
    const on = machine.value;
    if (busy.value || deviceId === undefined || slug === undefined || sandboxId === undefined) {
        return;
    }
    await reconnect.run({
        what: t(`sandbox.containerHealthCard.reconnectingSandbox`),
        failed: t(`sandbox.containerHealthCard.couldntReconnect`),
        task: async (report) => {
            const endMark =
                on === undefined
                    ? (): void => {}
                    : beginDeviceWork({
                          machine: on,
                          sandboxes: [sandboxId],
                          doing: t(`sandbox.containerHealthCard.reconnectingSandbox`),
                          what: t(`sandbox.containerHealthCard.reconnectingSandbox`),
                      });
            // This replaces the container serving this page, so the silence it causes is said to be the reconnect, by
            // every surface, rather than read as a fault. Armed for the whole run: the machine says nothing about
            // which minute the swap falls in.
            const restart = {
                sandbox: sandboxId,
                id: `recreate`,
                what: t(`sandbox.containerHealthCard.reconnectingSandbox`),
                quiet: {
                    title: t(`sandbox.containerHealthCard.reconnectingSandbox`),
                    detail: t(`sandbox.containerHealthCard.sandboxReplacedPageReconnects`),
                },
            } as const;
            const settle = expectRestart(restart);
            try {
                // Minted fresh per call so the code is always current; never cached or reused.
                const { code } = await apiClient.sandbox.setupCode({ sandboxId });
                try {
                    return await manageDeviceSandbox(deviceId, slug, `reconnect`, { setupCode: code, onLine: report.line });
                } catch (error) {
                    // The stream dying mid-flight is the success case: the daemon goes down with the container. Which
                    // one this was is only known once the sandbox answers again, so that is what ends the restart.
                    expectRestart({ ...restart, untilAnswered: true });
                    throw error;
                }
            } finally {
                settle();
                endMark();
            }
        },
    });
    confirming.value = false;
};
</script>

<template>
    <!-- Title, one sentence, then the action row: the reader learns what is wrong, why, and the one thing that fixes it,
         without a paragraph. What the fix does is said beside its button, quietly, rather than above it as prose. -->
    <section v-if="notices.length > 0" :class="toneTint(`warning`, `strong`, `flex flex-col gap-4 rounded-lg border px-4 py-3`)">
        <div v-for="(notice, index) of notices" :key="`${notice.fault}:${index}`" class="flex items-start gap-3">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <div class="flex min-w-0 flex-1 flex-col gap-1">
                <p class="text-sm font-medium text-content">{{ notice.title }}</p>
                <p class="text-xs text-muted">{{ notice.detail }}</p>
                <p v-if="notice.repair" class="text-xs text-muted">
                    {{ notice.fault === `duplicate` && pickCopy ? t(`sandbox.containerHealthCard.pickCopyToRemove`) : notice.repair }}
                </p>
                <div v-if="notice.fault === `duplicate` && pickCopy" class="mt-2 flex flex-col gap-2">
                    <div class="flex flex-wrap gap-2">
                        <Button
                            v-for="copy of copies"
                            :key="copy.machineKey"
                            size="small"
                            tier="boring"
                            :label="t(`sandbox.containerHealthCard.removeCopyOn`, { machine: copy.machineLabel })"
                            :disabled="copyRemoval.busy.value"
                            @click="removingCopy = copy"
                        >
                            <template #icon><Icon name="trash" /></template>
                        </Button>
                    </div>
                    <p v-if="copyRemoval.busy.value" class="flex items-center gap-1.5 text-2xs text-muted" role="status">
                        <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />{{ copyRemoval.operation.value?.what }}
                    </p>
                    <Notice v-else-if="copyRemoval.failure.value" :of="copyRemoval.failure.value" />
                    <p v-else-if="copyRemoval.value.value" class="text-2xs text-muted">{{ copyRemoval.value.value }}</p>
                </div>

                <!-- Only an out-of-date setup is repaired by reinstalling; every other notice says what to run instead. -->
                <div v-if="offersReconnect(notice)" class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <!-- Named for what it does to the container, not for the fault: "Repair" hides that this replaces it. -->
                    <Button
                        v-if="canRepair && !confirming && !busy"
                        size="small"
                        tier="boring"
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
                        <Button v-if="!busy" :label="t(`ui.action.cancel`)" size="small" tier="quiet" @click="confirming = false" />
                    </template>
                    <!-- The same repair by hand, for the owner with no machine connected. Never a member's: /setup on a sandbox
                         they do not own starts a new one on their own account (setupArrival.ts `rowToOpen`). -->
                    <Button
                        v-else-if="isOwner"
                        :as="RouterLink"
                        :to="{ path: `/setup`, query: { sandbox: active?.id } }"
                        size="small"
                        tier="boring"
                        :label="t(`sandbox.containerHealthCard.openSetupScreen`)"
                    >
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                    <!-- `basis-48`: below that width the caption takes a line of its own instead of squeezing beside the button. -->
                    <!-- Shown at the confirm moment, not as standing prose: what is replaced, and what is kept. -->
                    <p class="min-w-0 grow basis-48 text-2xs text-subtle">
                        <template v-if="canRepair">
                            <template v-if="confirming || busy">
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
                        :class="ui.textButton({ tone: `quiet`, size: `xs` }, `ml-auto shrink-0`)"
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
            <!-- The cause alone, as the machine said it: the stream dying is also how a replaced container sounds. -->
            {{ failure.detail ?? failure.title }}
            <!-- Said next to the error rather than instead of it: this call cuts its own connection by design. -->
            <span class="text-muted">{{ t(`sandbox.containerHealthCard.sandboxReplacedPageReconnects`) }}</span>
        </p>
        <ConfirmDialog
            :open="removingCopy !== undefined"
            :header="t(`sandbox.containerHealthCard.removeCopyHeader`, { machine: removingCopy?.machineLabel ?? `` })"
            :description="t(`sandbox.containerHealthCard.removeCopyBody`, { machine: removingCopy?.machineLabel ?? `` })"
            :confirm-label="t(`ui.action.remove`)"
            confirm-icon="trash"
            @cancel="removingCopy = undefined"
            @confirm="removeCopy"
        />
    </section>
</template>
