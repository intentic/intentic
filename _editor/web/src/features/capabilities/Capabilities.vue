<script setup lang="ts">
import { useSandbox } from "../../client/sandbox/useSandbox";
import {
    Button,
    ConfirmDialog,
    FilterBar,
    InfoHint,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    Section,
    SplitView,
    StatusBadge,
    toneTint,
    ui,
    useDevice,
} from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { isPeerKind } from "@intentic/sandbox-contract/policy/capabilities/capability-kinds";
import type { CapabilityKind } from "@intentic/sandbox-contract/schemas/capabilities";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import LiveLinkRows from "./LiveLinkRows.vue";
import { useExtensions } from "../../models/extensions/useExtensions";
import { useRegistry } from "../extensions/useRegistry";
import { useDevices } from "../../models/sandbox/devices/useDevices";
import { PEER_DOORS, usePeerConnect } from "../../models/sandbox/devices/usePeerConnect";
import { useLiveLinks } from "../../models/sandbox/devices/useLiveLinks";
import { useTier } from "../../client/sandbox/useTier";
import { useBackgroundProcesses, viewProcessLogs } from "../../models/terminal/useBackgroundProcesses";
import { useCapabilityCatalog } from "./capabilityCatalog";
import { swallowFileDrag, useCapabilityForm } from "./capabilityForm";
import { type PairingPeers, useCapabilityPairing } from "./capabilityPairing";
import { slotsOf } from "./kinds/kindSlots";
import { useCapabilityProbe } from "./capabilityProbe";
import { useCapabilityRoute } from "./capabilityRoute";
import { here, page as pages } from "../../lib/routes/links";
import { useCapabilitySubmit } from "./capabilitySubmit";
import BrowserProfileDialog from "./connect/BrowserProfileDialog.vue";
import CapabilityConnections from "./connect/CapabilityConnections.vue";
import CapabilityContext from "./connect/CapabilityContext.vue";
import CapabilityDraftRow from "./connect/CapabilityDraftRow.vue";
import CapabilityEffects from "./connect/CapabilityEffects.vue";
import CapabilitySetupForm from "./connect/CapabilitySetupForm.vue";
import CatalogDetail from "../../components/catalog/CatalogDetail.vue";
import CatalogGrid from "../../components/catalog/CatalogGrid.vue";
import CatalogTile from "../../components/catalog/CatalogTile.vue";
import CapabilityInstanceRow from "./connect/CapabilityInstanceRow.vue";
import CapabilityRail from "./connect/CapabilityRail.vue";
import CapabilityRenameDialog from "./connect/CapabilityRenameDialog.vue";
import { useFieldStandIns } from "./model/fieldStandIns";
import SyncOnlyDeviceRow from "./connect/SyncOnlyDeviceRow.vue";
import { registerWakeOnce } from "./connect/phoneWake";
import { useCapabilities } from "../../models/capabilities/useCapabilities";
import { useConnectionActions } from "./connectionActions";
import { entryDescription, entryName } from "../../models/capabilities/catalogCopy";
import type { ConnectionSources } from "./model/connectionRows";
import { deviceConnections } from "./model/deviceConnections";
import { catalogEntries, entryIcon } from "../../models/capabilities/tiles";
import { useSetupWalk } from "./setupWalk";
import { useTileHub, useTilePane } from "./tilePane";

// Capabilities give the agent tools (GitHub, MCP servers, SSH hosts, Stripe) and scaffold managed repos. Core tiles are
// static catalog data; cli tiles derive from enabled extensions' contributes.capabilities. What the page decides lives
// in the headless modules beside this file; here they are wired to the page's sources and to the template.

const t = useT();
const route = useRoute();
const router = useRouter();

const { recommendationFor, capabilities, error: listError, add, remove, rename, refetch, dismissRecommendation } = useCapabilities();
const { contributionOf, manifestOf, enabled: enabledExtensions, loaded: extensionsRead } = useExtensions();
// A tunnel's live address for the Connected slice; the VPN tile reads the same query, so the two can't disagree.
const { links: vpnLinks } = useLiveLinks(`vpn`);
// Same for a disk's mount point and whether it takes writes; the disk tile reads the same query.
const { links: netdiskLinks } = useLiveLinks(`netdisk`);
// Background gateway liveness for relay connectors (Discord, IMAP), scoped to this tile.
const { rows: processRows, busy: processBusy, start: startProcess, stop: stopProcess } = useBackgroundProcesses();
// Desktop sync, the other door a machine arrives through, holds no tile; read off the Devices tab's list, never polled here.
const { devices: fleet, readAt: fleetReadAt, refetch: refetchFleet } = useDevices({ poll: false });
const { mobile } = useDevice();
// Devices (host-kind), browsers (webext-kind) and phones (phone-kind) of the user's own, each paired through its own
// door, read from the one table every peer kind must have a door in.
const hosts = usePeerConnect(PEER_DOORS.device);
const browsers = usePeerConnect(PEER_DOORS.webext);
const phones = usePeerConnect(PEER_DOORS.phone);
const { peerFor: hostFor } = hosts;
const { peerFor: browserFor } = browsers;
const { peerFor: phoneFor } = phones;
const peers: PairingPeers = { device: hosts, webext: browsers, phone: phones };
// The roster's answer for a peer's connection: whether it has ever paired, and whether it is up now.
const peerOf = (kind: CapabilityKind, id: string): { readonly lastSeen?: number | undefined } | undefined =>
    isPeerKind(kind) ? peers[kind].peerFor(id) : undefined;
// Counts from whatever the registry cache already holds (`read: false`); absent until something has actually browsed.
const { entries: publishedExtensions } = useRegistry({ read: false });

const entries = computed(() => catalogEntries(enabledExtensions.value, capabilities.value));
const sources = computed<ConnectionSources>(() => ({
    host: hostFor,
    browser: browserFor,
    phone: phoneFor,
    vpn: vpnLinks.value,
    netdisk: netdiskLinks.value,
    devices: fleet.value,
}));
const syncOnly = computed(() => deviceConnections(fleet.value, fleetReadAt.value));
// What this page's own actions were refused, shown before the list's failure; a freshly opened form clears it.
const error = ref<NoticeModel | null>(null);

// Only an answered list can say a tile slug is unknown: a failed read leaves the address where it is.
const page = useCapabilityRoute({ route, router, entries, capabilities, settled: computed(() => extensionsRead.value.state === `ready`) });
const { selected, selectedInstances, soleInstance, editing, adding, search, walking, pick, back, openEdit, stopEditing, startAdding, openConnection } = page;

const catalog = useCapabilityCatalog({ entries, capabilities, recommendationFor, scope: page.scope, search, sources, syncOnly, contributionOf });
const { tiles, pinnedScopes, categoryScopes, activeScope, railScope, inCategory, groupedCatalog, connectionGroups } = catalog;
const { showingConnections, nothingMatches, description, badgeEffects } = catalog;
const { walkQueue, leaveTile, onwardFrom, startSetup, skip, dismiss } = useSetupWalk({
    tiles,
    selected,
    walking,
    move: page.move,
    dismissRecommendation,
    error,
});

const pane = useTilePane({
    selected,
    instances: selectedInstances,
    sources,
    syncOnly,
    processRows,
    enabled: enabledExtensions,
    published: publishedExtensions,
    recommendationFor,
});
const { selectedDevices, cardProcesses, rowState, cardRowFacts, soleRebuildStep, publishedCount, verifiedCount, selectedRecommendation } = pane;
const { want: hubWant, rowOf: hubRow, save: saveToHub, failure: hubFailure } = useTileHub({ selected, instances: selectedInstances, contributionOf });

const hosted = computed(() => useSandbox().active.value?.hosted != null);
const form = useCapabilityForm({
    hosted,
    selected,
    editing,
    adding,
    instances: selectedInstances,
    capabilities,
    device: page.device,
    recommendationFor,
    contributionOf,
    manifestOf,
    error,
});
const { savedName, values, liveEffects } = form;
const probe = useCapabilityProbe({ selected, form });
const standIns = useFieldStandIns({ selected, editing, values, kept: form.keptSecrets, alarm: form.fieldAlarm });

const pairing = useCapabilityPairing({ peers, contributionOf, refetch, error });
const { profileVisible, profileCapability, profileLabel, profileMode, openBrowser, startAgentLogin, openPairing, removePairedAccess } = pairing;
const { dialog: pairingDialog, handOff } = pairing;
const saving = useCapabilitySubmit({
    hosted,
    selected,
    editing,
    capabilities,
    form,
    add,
    walk: { onwardFrom, leaveTile, walking },
    handOff,
    stopEditing,
    error,
    ownsSandbox: useTier().isOwner,
});

const actions = useConnectionActions({ remove, rename, refetchFleet });
const { confirmRemoveId, confirmRemove, renameId, renameError, askRename, confirmRename, disconnecting, disconnectingDevice } = actions;
const { confirmDisconnectDevice, removing, renaming } = actions;

const topError = computed<NoticeModel | undefined>(() => {
    // What this page refused itself first, then the tile's save and test, then a connection's removal: each kept in the
    // operations ledger, so a reader who left while one ran comes back to how it went.
    const refused = error.value ?? saving.failure.value ?? probe.failure.value ?? actions.failure.value ?? hubFailure.value;
    if (refused !== null && refused !== undefined) {
        return refused;
    }
    if (listError.value === undefined) {
        return undefined;
    }
    return { tone: `danger`, title: t(`capabilities.capabilities.couldntListCapabilities`), detail: listError.value };
});

// THE FORM IS OPEN IN ONE PLACE AT A TIME: under the new connection's row, inside the open connection's row, or as a
// one-per-sandbox tile's whole page. Each place draws it with the same props and answers its events the same way.
const formProps = computed(() => ({
    sole: soleInstance.value,
    entries: entries.value,
    form,
    probe,
    standIns,
    saving,
    save: add,
    hosted: hosted.value,
    recommendation: selectedRecommendation.value,
    dismissing: dismissRecommendation.isPending.value,
    hubWant: hubWant.value,
}));
const formEvents = {
    notice: (notice: NoticeModel | null): void => {
        error.value = notice;
    },
    dismiss: (): void => {
        if (selected.value !== undefined) {
            void dismiss(selected.value);
        }
    },
    cancel: stopEditing,
};
// A row's chevron opens its settings in place, closing whichever row was open; closing it opens nothing.
const toggleRow = (id: string, open: boolean): void => (open ? openEdit(id) : stopEditing());
// The new row closes into its connection's row once the add lands, but not before: the first connection of a tile is
// listed mid-write, which would otherwise take the form away while it is still writing.
const draftOpen = computed(() => adding.value || (saving.submitting.value && editing.value === undefined && selected.value?.singleton !== true));
// VPN tunnels and network disks list their live links too: their rows dial and mount from the list.
const liveKind = computed(() => slotsOf(selected.value?.kind).liveLinks);
// What the tile's own kind adds above its list (where extensions are found, on the tile people arrive at wanting one).
const headerExtra = computed(() => slotsOf(selected.value?.kind).headerExtra?.({ publishedCount: publishedCount.value, verifiedCount: verifiedCount.value }));
// What the tile does and how to get its credential: beside an open form on a wide pane, else folded under the list.
const contextOpen = ref(false);
watch(
    () => selected.value?.id,
    () => {
        contextOpen.value = false;
    },
);
const formOpen = computed(() => draftOpen.value || editing.value !== undefined || selected.value?.singleton === true);

// The three rosters are live cache entries while this page is open, so a device can say "online" with no dialog open.
// A phone whose push token rotated, or that paired while no dialog was open, is made wakeable again from here: only a
// page signed in to the platform can register it with the push relay.
watch(phones.peers, (listed) => {
    for (const phone of listed) {
        void registerWakeOnce(phone).then((outcome) => (outcome === `ready` ? phones.refresh() : undefined));
    }
});
onMounted(() => {
    window.addEventListener(`dragover`, swallowFileDrag);
    window.addEventListener(`drop`, swallowFileDrag);
});
onBeforeUnmount(() => {
    window.removeEventListener(`dragover`, swallowFileDrag);
    window.removeEventListener(`drop`, swallowFileDrag);
});
</script>

<template>
    <!-- A phone scrolls the page, not the catalog inside it: clamped, the title, the scope and the filter held a third of the
         screen still while the tiles scrolled in what was left, under a second scrollbar. -->
    <SplitView :title="t(`shared.capabilities`)" :description="description" :scroll="mobile ? `page` : `panes`">
        <template #strips>
            <Notice v-if="topError" :of="topError" />
        </template>

        <!-- The rail narrows the grid rather than replacing it, so on mobile <SplitView> folds it above the grid (`mobile="collapse"`, the default). -->
        <template #rail>
            <CapabilityRail v-model="railScope" :pinned="pinnedScopes" :categories="categoryScopes" />
        </template>

        <template #detail>
            <!-- Capability configuration and apply share the tile layout. -->
            <div v-if="selected" class="scrollbar-stable min-h-0 flex-1 overflow-y-auto pr-2">
                <!-- Back to the slice the tile was picked from, named rather than a generic "All capabilities". -->
                <CatalogDetail
                    :back="activeScope.label"
                    :name="entryName(selected)"
                    :description="entryDescription(selected)"
                    :logo="selected.logo"
                    :icon="entryIcon(selected)"
                    @back="back"
                >
                    <!-- The walk's own strip: position in it, and a way past a tile. -->
                    <template v-if="walking" #lead>
                        <div class="mb-4 flex items-center gap-2 rounded-lg bg-card shadow-sm px-3 py-2">
                            <Icon name="sparkles" class="text-info" />
                            <span class="text-xs text-content">{{ t(`capabilities.capabilities.recommendedSetup`) }}</span>
                            <span class="text-2xs text-muted">{{ t(`capabilities.capabilities.left`, { count: walkQueue.length }) }}</span>
                            <Button class="ml-auto" :label="t(`ui.action.skip`)" size="small" tier="quiet" @click="skip" />
                        </div>
                    </template>

                    <!-- For a singleton tile, its state (which describes the whole screen, not one row) and its removal control. -->
                    <template v-if="soleInstance" #badge>
                        <StatusBadge
                            size="xs"
                            :dot="true"
                            :variant="rowState(selected, soleInstance).tone"
                            :label="rowState(selected, soleInstance).label"
                        />
                    </template>
                    <template v-if="soleInstance" #actions>
                        <Button :label="t(`ui.action.remove`)" size="small" tier="quiet" tone="danger" @click="confirmRemoveId = soleInstance.id">
                            <template #icon><Icon name="trash" /></template>
                        </Button>
                    </template>

                    <div class="flex flex-col gap-6">
                        <!-- A singleton tile with no finished setup has no row to carry its pending step, so it goes here instead. -->
                        <RouterLink
                            v-if="soleInstance && soleRebuildStep(soleInstance)"
                            :to="here(pages.sandboxSettings(`environment`))"
                            class="inline-flex w-fit items-center gap-1 text-xs text-warning hover:underline"
                        >
                            <Icon name="exclamation-triangle" />
                            {{ soleInstance.status.detail ?? t(`capabilities.words.needsSandboxRebuild`)
                            }}{{ t(`capabilities.capabilities.finishSetup`) }}
                        </RouterLink>

                        <!-- What the tile's kind adds above its list: where extensions are found, on the tile people arrive at wanting one. -->
                        <component v-if="headerExtra" :is="headerExtra.is" v-bind="headerExtra.props" />

                        <!-- Nothing listed yet: what the tile does and how to get its credential lead, before the new row's form
                             (on a wide pane the side column carries them), on the page rather than boxed inside the row. -->
                        <CapabilityContext
                            v-if="!selected.singleton && selectedInstances.length === 0"
                            class="@3xl:hidden"
                            :entry="selected"
                            :values="values"
                            :effects="liveEffects"
                        />

                        <!-- A singleton tile has no list: its one connection is the tile, and its settings are the page. -->
                        <CapabilitySetupForm v-if="selected.singleton" v-bind="formProps" :entry="selected" :editing="editing" :guide="true" v-on="formEvents" />

                        <!-- Tunnels and disks: the same rows, each also dialling or mounting its live link from the list. -->
                        <LiveLinkRows
                            v-else-if="liveKind"
                            :kind="liveKind"
                            :instances="selectedInstances"
                            :open-id="editing?.id"
                            @toggle="toggleRow"
                            @rename="askRename"
                            @remove="confirmRemoveId = $event"
                        >
                            <template v-if="!draftOpen" #actions>
                                <Button :label="t(`ui.action.add`)" size="small" tier="boring" @click="startAdding">
                                    <template #icon><Icon name="plus" /></template>
                                </Button>
                            </template>
                            <template v-if="draftOpen" #draft>
                                <CapabilityDraftRow :name="savedName">
                                    <CapabilitySetupForm
                                        v-bind="formProps"
                                        :entry="selected"
                                        :editing="undefined"
                                        :cancellable="selectedInstances.length > 0"
                                        v-on="formEvents"
                                    />
                                </CapabilityDraftRow>
                            </template>
                            <template #settings="{ id }">
                                <CapabilitySetupForm
                                    v-if="editing?.id === id"
                                    v-bind="formProps"
                                    :entry="selected"
                                    :editing="editing"
                                    :cancellable="true"
                                    v-on="formEvents"
                                />
                            </template>
                        </LiveLinkRows>

                        <!-- Every other tile: its connections, the new one opening at the top where Add put it. -->
                        <RowGroup v-else :label="t(`shared.connections`)">
                            <template v-if="!draftOpen" #actions>
                                <Button :label="t(`ui.action.add`)" size="small" tier="boring" @click="startAdding">
                                    <template #icon><Icon name="plus" /></template>
                                </Button>
                            </template>
                            <CapabilityDraftRow v-if="draftOpen" :name="savedName">
                                <CapabilitySetupForm
                                    v-bind="formProps"
                                    :entry="selected"
                                    :editing="undefined"
                                    :cancellable="selectedInstances.length > 0"
                                    v-on="formEvents"
                                />
                            </CapabilityDraftRow>
                            <CapabilityInstanceRow
                                v-for="instance in selectedInstances"
                                :key="instance.id"
                                :entry="selected"
                                :instance="instance"
                                :peer="peerOf(selected.kind, instance.id)"
                                :state="rowState(selected, instance)"
                                :facts="cardRowFacts(instance)"
                                :open="editing?.id === instance.id"
                                :hub="hubRow(instance.id)"
                                @update:open="toggleRow(instance.id, $event)"
                                @connect="openPairing(selected, instance)"
                                @revoke="removePairedAccess(selected, instance.id)"
                                @browse="openBrowser(instance.id, instance.id, `browse`)"
                                @login="openBrowser(instance.id, instance.id)"
                                @agent-login="startAgentLogin(instance.id)"
                                @rename="askRename(instance.id)"
                                @remove="confirmRemoveId = instance.id"
                                @save="saveToHub(instance.id, $event)"
                            >
                                <CapabilitySetupForm
                                    v-if="editing?.id === instance.id"
                                    v-bind="formProps"
                                    :entry="selected"
                                    :editing="editing"
                                    :cancellable="true"
                                    v-on="formEvents"
                                />
                                <!-- The pairing a Connect or a fresh add started, under the row it pairs rather than over the page. -->
                                <template v-if="pairingDialog?.id === instance.id" #pairing>
                                    <component :is="pairingDialog.is" v-bind="pairingDialog.props" />
                                </template>
                            </CapabilityInstanceRow>
                            <!-- Last, after what is actually connected: machines already reachable through desktop sync, which this tile would give commands, files and screen. -->
                            <SyncOnlyDeviceRow
                                v-for="device in selectedDevices"
                                :key="device.id"
                                :device="device"
                                @connect="openConnection(device.entryId, device.id)"
                                @disconnect="disconnecting = device"
                            />
                        </RowGroup>

                        <!-- The gateway serving these connections, answering "is this still working" where the connector page is actually read. -->
                        <RowGroup v-if="cardProcesses.length > 0" :label="t(`capabilities.capabilities.backgroundProcess`)">
                            <template #info>
                                <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`capabilities.capabilities.backgroundProcess`) })">
                                    <span class="block text-xs text-content">{{ t(`capabilities.capabilities.relaysEventsToAgent`) }}</span>
                                </InfoHint>
                            </template>
                            <Row v-for="row in cardProcesses" :key="row.id">
                                <!-- State dot goes in `#lead`, where every other list in the app puts one. -->
                                <template #lead>
                                    <span
                                        class="h-1.5 w-1.5 shrink-0 rounded-full"
                                        :class="row.running ? 'bg-success' : 'bg-content/25'"
                                        aria-hidden="true"
                                    />
                                </template>
                                <template #title>{{ row.name }}</template>
                                <template #meta>
                                    <span :class="row.running ? 'text-muted' : 'text-warning'">{{
                                        row.running ? t(`capabilities.capabilities.running`) : t(`capabilities.capabilities.stopped`)
                                    }}</span>
                                </template>
                                <template #control>
                                    <Button
                                        v-if="row.session"
                                        :label="t(`capabilities.capabilities.logs`)"
                                        size="small"
                                        tier="quiet"
                                        @click="viewProcessLogs(row)"
                                    >
                                        <template #icon><Icon name="align-left" /></template>
                                    </Button>
                                    <Button
                                        :label="row.running ? t(`ui.action.restart`) : t(`ui.action.start`)"
                                        size="small"
                                        tier="quiet"
                                        :disabled="processBusy === row.id"
                                        @click="startProcess(row)"
                                    >
                                        <template #icon><Icon :name="row.running ? 'refresh' : 'play'" /></template>
                                    </Button>
                                    <Button
                                        v-if="row.running"
                                        :label="t(`ui.action.stop`)"
                                        size="small"
                                        tier="quiet"
                                        tone="danger"
                                        :disabled="processBusy === row.id"
                                        @click="stopProcess(row)"
                                    >
                                        <template #icon><Icon name="stop" /></template>
                                    </Button>
                                </template>
                            </Row>
                        </RowGroup>

                        <!-- Once there is something listed, what the tile does folds into one line under the list; beside an open
                             row's settings on a wide pane, the side column carries it instead. -->
                        <div v-if="!selected.singleton && selectedInstances.length > 0" :class="formOpen ? `@3xl:hidden` : ``">
                            <button
                                type="button"
                                :class="ui.textButton({ tone: `quiet` })"
                                :aria-expanded="contextOpen"
                                @click="contextOpen = !contextOpen"
                            >
                                <Icon :name="contextOpen ? 'chevron-down' : 'chevron-right'" class="text-2xs" />
                                {{ t(`capabilities.capabilities.howItWorks`) }}
                            </button>
                            <CapabilityContext v-if="contextOpen" class="mt-3" :entry="selected" :values="values" :effects="liveEffects" />
                        </div>
                    </div>

                    <!-- Docked reference column while a form is open, shown only above @3xl (below it, the form or the fold carries it). -->
                    <template v-if="formOpen" #aside>
                        <CapabilityContext :entry="selected" :values="values" :effects="liveEffects" />
                    </template>
                </CatalogDetail>
            </div>

            <!-- Step 1: the catalog. -->
            <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
                <!-- Offered as one action rather than badges to hunt for, above the filter since it's not one. -->
                <div v-if="walkQueue.length > 0" :class="toneTint(`info`, `soft`, `flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3`)">
                    <Icon name="sparkles" class="text-info" />
                    <div class="min-w-0 flex-1">
                        <div class="text-sm text-content">
                            {{ t(`capabilities.capabilities.workspaceAsksFor`, { count: walkQueue.length }, walkQueue.length) }}
                        </div>
                        <div class="text-xs text-muted">
                            {{ t(`capabilities.capabilities.eachOneSomethingOwn`) }}
                        </div>
                    </div>
                    <Button tier="accent" :label="t(`capabilities.capabilities.setUp`)" size="small" @click="startSetup">
                        <template #icon><Icon name="arrow-right" /></template>
                    </Button>
                </div>

                <!-- Bar sits on the grid it narrows, spanning it; picking the slice is the rail's job, not repeated here. -->
                <FilterBar
                    v-model="search"
                    :placeholder="
                        showingConnections ? t(`capabilities.capabilities.filterByNameHost`) : t(`capabilities.capabilities.filterByNameWhat`)
                    "
                />

                <!-- `pr-2` keeps tiles clear of the scrollbar; the reserved gutter stops the grid shifting when a filter removes the last row. -->
                <div class="scrollbar-stable @container flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pr-2">
                    <!-- The one slice that isn't a shorter catalog: it answers "what have I got" with the connections themselves, named and stated. -->
                    <CapabilityConnections v-if="showingConnections" :groups="connectionGroups" @open="openConnection" />

                    <!-- Headings only when the grid spans more than one category; a single category's heading is already the page description. -->
                    <template v-else>
                        <!-- Label alone: the category's own sentence is already the page description once the rail points at it. -->
                        <Section v-for="group in groupedCatalog" :key="group.label" :label="inCategory ? undefined : group.label">
                            <CatalogGrid>
                                <CatalogTile
                                    v-for="tile in group.entries"
                                    :key="tile.entry.id"
                                    :name="entryName(tile.entry)"
                                    :description="entryDescription(tile.entry)"
                                    :logo="tile.entry.logo"
                                    :icon="entryIcon(tile.entry)"
                                    @click="pick(tile.entry)"
                                >
                                    <template #marks>
                                        <!-- Count shown only above one: a lone tick already means connected. -->
                                        <span
                                            v-if="tile.connected > 0"
                                            v-tooltip.top="t(`capabilities.capabilities.connected`, { connected: tile.connected })"
                                            class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-success"
                                            :aria-label="t(`capabilities.capabilities.connected`, { connected: tile.connected })"
                                        >
                                            <Icon name="check-circle" />
                                            <template v-if="tile.connected > 1">{{ tile.connected }}</template>
                                        </span>
                                        <!-- The scan's finding rides its own badge; the tooltip carries the claim and the evidence so it stays checkable. -->
                                        <span
                                            v-if="tile.recommendation"
                                            v-tooltip.top="{
                                                title: t(`capabilities.capabilities.recommendedTitle`),
                                                tone: `info`,
                                                rows: [{ label: t(`capabilities.capabilities.evidence`), value: tile.recommendation.evidence }],
                                                note: tile.recommendation.reason,
                                            }"
                                            class="shrink-0 text-2xs text-info"
                                            :aria-label="t(`capabilities.capabilities.recommended2`, { reason: tile.recommendation.reason })"
                                        >
                                            <Icon name="sparkles" />
                                        </span>
                                        <CapabilityEffects :effects="badgeEffects(tile.entry)" :compact="true" />
                                    </template>
                                </CatalogTile>
                            </CatalogGrid>
                        </Section>
                    </template>

                    <!-- Reachable only via the filter, since every slice the rail offers has something in it; answers about whichever list is actually on screen. -->
                    <div v-if="nothingMatches" :class="ui.emptyState()">
                        <p class="text-sm">
                            {{ t(`capabilities.capabilities.nothingInMatches`, { label: activeScope.label, trim: search.trim() }) }}
                        </p>
                        <p v-if="showingConnections" class="mt-1 text-xs text-muted">
                            {{ t(`capabilities.capabilities.connectionsSearchedByName`) }}
                        </p>
                        <p v-else class="mt-1 text-xs text-muted">
                            {{ t(`capabilities.capabilities.capabilitiesSearchedByName`) }}
                        </p>
                    </div>
                </div>
            </div>

            <!-- Removal tears down real sandbox state (MCP config, SSH host, service provisioning); confirm first. -->
            <ConfirmDialog
                :open="confirmRemoveId !== undefined"
                :header="t(`capabilities.capabilities.removeCapability`)"
                :confirm-label="t(`ui.action.remove`)"
                confirm-icon="trash"
                :loading="removing"
                @cancel="confirmRemoveId = undefined"
                @confirm="confirmRemove"
            >
                <template #description>
                    {{ t(`ui.action.remove`) }} <b>{{ confirmRemoveId }}</b> {{ t(`capabilities.capabilities.sandboxTearsDownConfiguration`) }}
                </template>
            </ConfirmDialog>

            <!-- Names what stops as precisely as the Devices board does: this is the same revoke, pressed from the tile. -->
            <ConfirmDialog
                :open="disconnecting !== undefined"
                :header="t(`capabilities.capabilities.disconnectHeader`, { machine: disconnecting?.title ?? t(`shared.thisMachine`) })"
                :confirm-label="t(`ui.action.disconnect`)"
                confirm-icon="times"
                :loading="disconnectingDevice"
                @cancel="disconnecting = undefined"
                @confirm="void confirmDisconnectDevice()"
            >
                <template #description>
                    <span class="font-mono">{{ disconnecting?.title }}</span> {{ t(`capabilities.capabilities.losesAccessToSandbox`) }}
                </template>
                <p class="text-muted">{{ t(`capabilities.capabilities.connectingAgainMeansRunning`) }}</p>
            </ConfirmDialog>

            <!-- The one edit that's a migration rather than a form field; see askRename. -->
            <CapabilityRenameDialog
                :visible="renameId !== undefined"
                :id="renameId ?? ''"
                :busy="renaming"
                :error="renameError"
                @update:visible="renameId = undefined"
                @rename="confirmRename"
            />

            <!-- Guided login for one account: a live Chromium shown as video and driven back, signed into by hand. -->
            <BrowserProfileDialog
                v-model:visible="profileVisible"
                :capability="profileCapability"
                :label="profileLabel"
                :mode="profileMode"
                @done="refetch()"
            />

        </template>
    </SplitView>
</template>
