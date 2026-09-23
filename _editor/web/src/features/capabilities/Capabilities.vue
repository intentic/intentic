<script setup lang="ts">
import type { HostSummary, WebExtSummary } from "@intentic/sandbox-contract";
import {
    BrandMark,
    Button,
    ConfirmDialog,
    FilterBar,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    SegmentedControl,
    SplitView,
    StatusBadge,
    ui,
} from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import NetdiskMounts from "../../components/NetdiskMounts.vue";
import VpnConnections from "../../components/VpnConnections.vue";
import { startAgent } from "../agents/fleet/agentActions";
import { useExtensions } from "../extensions/useExtensions";
import { useRegistry } from "../extensions/useRegistry";
import { useDevices } from "../sandbox/devices/useDevices";
import { useNetdisk } from "../sandbox/devices/useNetdisk";
import { HOST_DOOR, usePeerConnect, WEBEXT_DOOR } from "../sandbox/devices/usePeerConnect";
import { useVpn } from "../sandbox/devices/useVpn";
import { useBackgroundProcesses, viewProcessLogs } from "../terminal/useBackgroundProcesses";
import { useCapabilityCatalog } from "./capabilityCatalog";
import { swallowFileDrag, useCapabilityForm } from "./capabilityForm";
import { useCapabilityPairing } from "./capabilityPairing";
import { useCapabilityProbe } from "./capabilityProbe";
import { useCapabilityRoute } from "./capabilityRoute";
import { useCapabilitySubmit } from "./capabilitySubmit";
import BrowserProfileDialog from "./connect/BrowserProfileDialog.vue";
import CapabilityConnections from "./connect/CapabilityConnections.vue";
import CapabilityContext from "./connect/CapabilityContext.vue";
import CapabilityEffects from "./connect/CapabilityEffects.vue";
import CapabilityFieldRow from "./connect/CapabilityFieldRow.vue";
import CapabilityInstanceRow from "./connect/CapabilityInstanceRow.vue";
import CapabilityRail from "./connect/CapabilityRail.vue";
import CapabilityRenameDialog from "./connect/CapabilityRenameDialog.vue";
import ForticlientImport from "./connect/ForticlientImport.vue";
import GitRefField from "./connect/GitRefField.vue";
import HostConnectDialog from "./connect/HostConnectDialog.vue";
import PluginRegistryBrowse from "./connect/PluginRegistryBrowse.vue";
import SyncOnlyDeviceRow from "./connect/SyncOnlyDeviceRow.vue";
import WebExtConnectDialog from "./connect/WebExtConnectDialog.vue";
import { useCapabilities } from "./connect/useCapabilities";
import { useConnectionActions } from "./connectionActions";
import { auditPrompt } from "./model/audit";
import type { ConnectionSources } from "./model/connectionRows";
import { deviceConnections } from "./model/deviceConnections";
import { advancedLabel, inlineField } from "./model/form";
import { hostGrantSummary, matchHostPreset } from "./model/previews";
import { picksVersion } from "./model/refs";
import { catalogEntries, entryIcon } from "./model/tiles";
import { useSetupWalk } from "./setupWalk";
import { useTilePane } from "./tilePane";

// Capabilities give the agent tools (GitHub, MCP servers, SSH hosts, Stripe) and scaffold managed repos. Core tiles are
// static catalog data; cli tiles derive from enabled extensions' contributes.capabilities. What the page decides lives
// in the headless modules beside this file; here they are wired to the page's sources and to the template.

const t = useT();
const route = useRoute();
const router = useRouter();

const { recommendationFor, capabilities, error: listError, add, remove, rename, refetch, dismissRecommendation } = useCapabilities();
const { contributionOf, enabled: enabledExtensions, settled: extensionsSettled } = useExtensions();
// A tunnel's live address for the Connected slice; the VPN tile reads the same query, so the two can't disagree.
const { links: vpnLinks } = useVpn();
// Same for a disk's mount point and whether it takes writes; the disk tile reads the same query.
const { links: netdiskLinks } = useNetdisk();
// Background gateway liveness for relay connectors (Discord, IMAP), scoped to this tile.
const { rows: processRows, busy: processBusy, start: startProcess, stop: stopProcess } = useBackgroundProcesses();
// Desktop sync, the other door a machine arrives through, holds no tile; read off the Devices tab's list, never polled here.
const { devices: fleet, readAt: fleetReadAt, refetch: refetchFleet } = useDevices({ poll: false });
// Devices (host-kind) and browsers (webext-kind) of the user's own, each paired through its own door.
const hosts = usePeerConnect<HostSummary>(HOST_DOOR);
const browsers = usePeerConnect<WebExtSummary>(WEBEXT_DOOR);
const { peerFor: hostFor } = hosts;
const { peerFor: browserFor } = browsers;
// Counts from whatever the registry cache already holds (`read: false`); absent until something has actually browsed.
const { entries: publishedExtensions } = useRegistry({ read: false });

const entries = computed(() => catalogEntries(enabledExtensions.value, capabilities.value));
const sources = computed<ConnectionSources>(() => ({
    host: hostFor,
    browser: browserFor,
    vpn: vpnLinks.value,
    netdisk: netdiskLinks.value,
    devices: fleet.value,
}));
const syncOnly = computed(() => deviceConnections(fleet.value, fleetReadAt.value));
// What this page's own actions were refused, shown before the list's failure; a freshly opened form clears it.
const error = ref<NoticeModel | null>(null);

const page = useCapabilityRoute({ route, router, entries, capabilities, settled: extensionsSettled });
const { selected, selectedInstances, soleInstance, editing, search, walking, pick, back, openEdit, stopEditing, openConnection } = page;

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

const form = useCapabilityForm({
    selected,
    editing,
    instances: selectedInstances,
    capabilities,
    device: page.device,
    recommendationFor,
    contributionOf,
    error,
});
const { name, nameEdited, savedName, namePreview, nameCollision, nameProblem, values, attempted, shaking, pasteNotes, advancedOpen } = form;
const { probeResult, finishName, finishField, onFieldInput, onFieldPaste, fieldAlarm, fieldQuiet, fieldChecked, fieldUrlFix, applyUrlFix } = form;
const { fieldConfSummary, fieldPlaceholder, mainFields, advancedFields, versionToken, formSummary, liveEffects, hostPresetOptions } = form;
const { applyHostPreset, applyRegistryPick, pickForticlient, auditable, updateFrom, submitLabel } = form;
const { probing, canProbe, runProbe } = useCapabilityProbe({ selected, form, error });
// Has an agent read the pinned code, or what an update changes, before the install is approved.
const startAudit = (): void => void startAgent(auditPrompt(name.value, values, updateFrom.value));

const pairing = useCapabilityPairing({ hosts, browsers, contributionOf, refetch, error });
const { profileVisible, profileCapability, profileLabel, profileMode, openBrowser, startAgentLogin, openPairing, removePairedAccess } = pairing;
const { connectVisible, connectId, connectPlatform, connectPermissions, connectUnnamed, onHostConnected, onHostRenamed } = pairing;
const { browserConnectVisible, browserConnectId, browserInstall, browserPermissions, onBrowserExtConnected, handOff } = pairing;
const { submit, submitting } = useCapabilitySubmit({
    selected,
    editing,
    capabilities,
    form,
    add,
    walk: { onwardFrom, leaveTile },
    handOff,
    stopEditing,
    error,
});

const actions = useConnectionActions({ remove, rename, refetchFleet, error });
const { confirmRemoveId, confirmRemove, renameId, renameError, askRename, confirmRename, disconnecting, disconnectingDevice } = actions;
const { confirmDisconnectDevice } = actions;

const topError = computed<NoticeModel | undefined>(() => {
    if (error.value !== null) {
        return error.value;
    }
    if (listError.value === undefined) {
        return undefined;
    }
    return { tone: `danger`, title: t(`capabilities.capabilities.couldntListCapabilities`), detail: listError.value };
});

// One roster read while this page is open, so a device can say "online" with no dialog open; only a live pairing polls.
onMounted(hosts.start);
onBeforeUnmount(hosts.stop);
onMounted(browsers.start);
onBeforeUnmount(browsers.stop);
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
    <SplitView :title="t(`capabilities.capabilities.capabilities`)" :description="description">
        <template #strips>
            <Notice v-if="topError" :of="topError" />
        </template>

        <!-- The rail narrows the grid rather than replacing it, so on mobile <SplitView> folds it above the grid (`mobile="collapse"`, the default). -->
        <template #rail>
            <CapabilityRail v-model="railScope" :pinned="pinnedScopes" :categories="categoryScopes" />
        </template>

        <template #detail>
            <!-- Capability configuration and apply share the tile layout. -->
            <div v-if="selected" class="scrollbar-stable @container min-h-0 flex-1 overflow-y-auto pr-2">
                <div class="mx-auto flex max-w-xl flex-col @3xl:max-w-none @3xl:flex-row @3xl:items-start @3xl:justify-center @3xl:gap-6">
                    <!-- Capped below the reading measure: this column holds single-line inputs, not prose. -->
                    <div class="flex min-w-0 flex-1 flex-col @3xl:max-w-lg">
                        <!-- Back to the slice the tile was picked from, named rather than a generic "All capabilities". -->
                        <button type="button" :class="ui.textAction(`mb-4 gap-1`)" @click="back">
                            <Icon name="arrow-left" class="text-2xs" /> {{ activeScope.label }}
                        </button>

                        <!-- The walk's own strip: position in it, and a way past a tile. -->
                        <div v-if="walking" class="mb-4 flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
                            <Icon name="sparkles" class="text-info" />
                            <span class="text-xs text-content">{{ t(`capabilities.capabilities.recommendedSetup`) }}</span>
                            <span class="text-2xs text-muted">{{ t(`capabilities.capabilities.left`, { count: walkQueue.length }) }}</span>
                            <Button
                                class="ml-auto"
                                :label="t(`capabilities.capabilities.skip`)"
                                size="small"
                                severity="secondary"
                                text
                                @click="skip"
                            />
                        </div>

                        <!-- Tile heading plus, for a singleton tile, its state (which describes the whole screen, not one row) and its removal control. -->
                        <div class="mb-4 flex items-center gap-3">
                            <BrandMark :size="32" :name="selected.name" :logo="selected.logo" :icon="entryIcon(selected)" />
                            <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <span class="font-medium text-content">{{ selected.name }}</span>
                                    <StatusBadge
                                        v-if="soleInstance"
                                        size="xs"
                                        :dot="true"
                                        :variant="rowState(selected, soleInstance).tone"
                                        :label="rowState(selected, soleInstance).label"
                                    />
                                </div>
                                <div class="text-xs text-muted">{{ selected.description }}</div>
                            </div>
                            <Button
                                v-if="soleInstance && selected.kind !== 'devops'"
                                :label="t(`ui.action.remove`)"
                                size="small"
                                severity="danger"
                                :text="true"
                                @click="confirmRemoveId = soleInstance.id"
                            >
                                <template #icon><Icon name="trash" /></template>
                            </Button>
                        </div>

                        <!-- A singleton tile with no finished setup has no row to carry its pending step, so it goes here instead. -->
                        <RouterLink
                            v-if="soleInstance && soleRebuildStep(soleInstance)"
                            to="/sandbox/environment"
                            class="mb-4 inline-flex w-fit items-center gap-1 text-xs text-warning hover:underline"
                        >
                            <Icon name="exclamation-triangle" />
                            {{ soleInstance.status.detail ?? t(`capabilities.capabilities.needsSandboxRebuild`)
                            }}{{ t(`capabilities.capabilities.finishSetup`) }}
                        </RouterLink>

                        <form class="flex flex-col gap-3" @submit.prevent="submit">
                            <!-- What you already have of this tile, suppressed on a singleton tile. -->
                            <VpnConnections
                                v-if="selected.kind === 'vpn' && selectedInstances.length > 0"
                                :instances="selectedInstances"
                                :editing-id="editing?.id"
                                @edit="openEdit"
                                @rename="askRename"
                                @remove="confirmRemoveId = $event"
                            />
                            <NetdiskMounts
                                v-else-if="selected.kind === 'netdisk' && selectedInstances.length > 0"
                                :instances="selectedInstances"
                                :editing-id="editing?.id"
                                @edit="openEdit"
                                @rename="askRename"
                                @remove="confirmRemoveId = $event"
                            />
                            <RowGroup
                                v-else-if="(selectedInstances.length > 0 || selectedDevices.length > 0) && !selected.singleton"
                                :label="t(`capabilities.capabilities.connections`)"
                            >
                                <CapabilityInstanceRow
                                    v-for="instance in selectedInstances"
                                    :key="instance.id"
                                    :entry="selected"
                                    :instance="instance"
                                    :host="hostFor(instance.id)"
                                    :browser="browserFor(instance.id)"
                                    :state="rowState(selected, instance)"
                                    :facts="cardRowFacts(instance)"
                                    :editing="editing?.id === instance.id"
                                    @connect="openPairing(selected, instance)"
                                    @revoke="removePairedAccess(selected, instance.id)"
                                    @browse="openBrowser(instance.id, instance.id, `browse`)"
                                    @login="openBrowser(instance.id, instance.id)"
                                    @agent-login="startAgentLogin(instance.id)"
                                    @edit="openEdit(instance.id)"
                                    @rename="askRename(instance.id)"
                                    @remove="confirmRemoveId = instance.id"
                                />
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
                            <RowGroup
                                v-if="cardProcesses.length > 0"
                                :label="t(`capabilities.capabilities.backgroundProcess`)"
                                :caption="t(`capabilities.capabilities.relaysEventsToAgent`)"
                            >
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
                                        <span :class="row.running ? 'text-muted' : 'text-warning'">{{ row.running ? "running" : "stopped" }}</span>
                                    </template>
                                    <template #control>
                                        <Button
                                            v-if="row.session"
                                            :label="t(`capabilities.capabilities.logs`)"
                                            size="small"
                                            :text="true"
                                            @click="viewProcessLogs(row)"
                                        >
                                            <template #icon><Icon name="align-left" /></template>
                                        </Button>
                                        <Button
                                            :label="row.running ? t(`capabilities.capabilities.restart`) : t(`ui.action.start`)"
                                            size="small"
                                            :text="true"
                                            :disabled="processBusy === row.id"
                                            @click="startProcess(row)"
                                        >
                                            <template #icon><Icon :name="row.running ? 'refresh' : 'play'" /></template>
                                        </Button>
                                        <Button
                                            v-if="row.running"
                                            :label="t(`ui.action.stop`)"
                                            size="small"
                                            severity="danger"
                                            :text="true"
                                            :disabled="processBusy === row.id"
                                            @click="stopProcess(row)"
                                        >
                                            <template #icon><Icon name="stop" /></template>
                                        </Button>
                                    </template>
                                </Row>
                            </RowGroup>

                            <!-- Fills this form from FortiClient's own file; keyed on the tile so switching tiles clears the zone. -->
                            <ForticlientImport v-if="selected.kind === 'vpn'" :key="selected.id" @pick="pickForticlient" @notice="error = $event" />

                            <!-- Where extensions are found, on the tile people arrive at wanting one. -->
                            <RouterLink
                                v-if="selected.kind === 'extension'"
                                to="/sandbox/extensions?view=browse"
                                class="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5 transition-colors hover:border-line-strong hover:bg-overlay"
                            >
                                <Icon name="search" class="shrink-0 text-link" />
                                <span class="min-w-0 flex-1">
                                    <span class="block text-xs font-medium text-content">{{
                                        t(`capabilities.capabilities.browsePublishedExtensions`)
                                    }}</span>
                                    <span class="block text-2xs text-muted">
                                        <template v-if="publishedCount > 0"
                                            >{{ publishedCount }} {{ t(`capabilities.capabilities.published`)
                                            }}<template v-if="verifiedCount > 0">{{
                                                t(`capabilities.capabilities.sourceReadByHuman`, { verifiedCount })
                                            }}</template
                                            >. </template
                                        >{{ t(`capabilities.capabilities.installInClickRegistry`) }}
                                    </span>
                                </span>
                                <Icon name="arrow-right" class="shrink-0 text-subtle" />
                            </RouterLink>

                            <!-- Registry browse for plugins only; extensions have their own Browse tab, linked above. -->
                            <PluginRegistryBrowse
                                v-if="selected.kind === 'plugin'"
                                :key="selected.id"
                                :kind="selected.kind"
                                @pick="applyRegistryPick"
                                @notice="error = $event"
                            />

                            <!-- States the form's intent up front, since the same fields mean "add" or "change this one". -->
                            <div
                                v-if="editing || selected.singleton || selectedInstances.length > 0"
                                class="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
                            >
                                <div :class="ui.sectionLabel()">
                                    <!-- A singleton tile always says "Settings": it never adds a second anything, and has no name to show. -->
                                    <template v-if="selected.singleton">{{ t(`capabilities.capabilities.settings`) }}</template>
                                    <template v-else-if="editing">
                                        {{ t(`capabilities.capabilities.editing`) }} <span class="font-mono normal-case">{{ editing.id }}</span>
                                    </template>
                                    <template v-else>{{ t(`capabilities.capabilities.addAnother`) }}</template>
                                </div>
                                <!-- Way out of an edit, beside what it's editing, not by the submit button, which stays reachable from anywhere already. -->
                                <button v-if="editing && !selected.singleton" type="button" :class="ui.linkButton(`text-2xs`)" @click="stopEditing">
                                    {{ t(`capabilities.capabilities.cancelAddAnotherInstead`) }}
                                </button>
                            </div>

                            <!-- No name box while editing or on a singleton tile: renaming moves state a form can't (askRename), so a second box here would be a lossy shortcut for it. -->
                            <label v-if="!selected.singleton && !editing" class="ui-field">
                                <span class="ui-field-label">{{ t(`capabilities.capabilities.name`) }}</span>
                                <input
                                    v-model="name"
                                    placeholder="my-tool"
                                    :class="[ui.input(), nameCollision || (attempted && nameProblem) ? 'ui-field-error-box' : '']"
                                    @input="nameEdited = true"
                                    @blur="finishName"
                                />
                                <!-- A taken name is refused, not saved over: this form holds the tile's defaults, which would overwrite a live connection's settings. -->
                                <span v-if="nameCollision" class="ui-field-error">
                                    <Icon name="exclamation-triangle" class="text-2xs" />
                                    "{{ savedName }}{{ t(`capabilities.capabilities.alreadyExistsOpenAbove`) }}
                                </span>
                                <span v-else-if="attempted && nameProblem" class="ui-field-error">
                                    <Icon name="exclamation-triangle" class="text-2xs" />
                                    {{ nameProblem }}
                                </span>
                                <!-- Shows the repair (spaces/punctuation to hyphens) rather than applying it silently; blur commits it, after which there's nothing to show. -->
                                <span v-else-if="namePreview" class="mt-1 flex items-center gap-1 text-2xs text-muted">
                                    <Icon name="check" class="text-2xs text-success" />
                                    {{ t(`capabilities.capabilities.saved`) }} <span class="font-mono text-content">{{ namePreview }}</span>
                                </span>
                                <span v-else-if="selectedInstances.length > 0" class="mt-1 text-2xs text-subtle">
                                    {{ t(`capabilities.capabilities.whatAgentCallConnection`) }}
                                </span>
                            </label>
                            <!-- Narrow reference column shown inline below @3xl; the docked aside version takes over above it. -->
                            <CapabilityContext :entry="selected" :values="values" :effects="liveEffects" class="@3xl:hidden" />
                            <!-- A device's access as a posture: the preset sets all switches at once; the sentence states what they currently spell. -->
                            <label v-if="selected.kind === 'device'" class="flex items-start justify-between gap-4">
                                <span class="min-w-0">
                                    <span class="ui-field-label">{{ t(`capabilities.capabilities.access`) }}</span>
                                    <span class="mt-0.5 block text-2xs text-muted">{{ hostGrantSummary(values) }}</span>
                                </span>
                                <SegmentedControl
                                    class="shrink-0"
                                    :model-value="matchHostPreset(values) ?? ''"
                                    :options="hostPresetOptions"
                                    @update:model-value="applyHostPreset($event)"
                                />
                            </label>

                            <!-- Main fields first, rarely-changed ones folded behind Advanced. -->
                            <template v-for="field in mainFields(selected)" :key="field.key">
                                <!-- An extension pins a commit, so that box is answered from the repository rather than typed into. -->
                                <GitRefField
                                    v-if="picksVersion(selected, field)"
                                    :field="field"
                                    :values="values"
                                    :url="values['url'] ?? ''"
                                    :token="versionToken"
                                    :keeping="editing?.id"
                                    :alarm="fieldAlarm(field)"
                                    @left="finishField(field)"
                                />
                                <CapabilityFieldRow
                                    v-else
                                    :field="field"
                                    :values="values"
                                    :inline="inlineField(field)"
                                    :placeholder="fieldPlaceholder(field)"
                                    :alarm="fieldAlarm(field)"
                                    :quiet="fieldQuiet(field)"
                                    :checked="fieldChecked(field)"
                                    :url-fix="fieldUrlFix(field)"
                                    :note="pasteNotes[field.key]"
                                    :summary="fieldConfSummary(field)"
                                    @edited="onFieldInput(field)"
                                    @pasted="onFieldPaste(field, $event)"
                                    @left="finishField(field)"
                                    @fix="applyUrlFix(field)"
                                />
                            </template>
                            <template v-if="advancedFields(selected).length > 0">
                                <button type="button" :class="ui.textAction(`gap-1`)" @click="advancedOpen = !advancedOpen">
                                    <Icon :name="advancedOpen ? 'chevron-down' : 'chevron-right'" class="text-2xs" />
                                    {{ advancedLabel(selected) }}
                                </button>
                                <template v-if="advancedOpen">
                                    <CapabilityFieldRow
                                        v-for="field in advancedFields(selected)"
                                        :key="field.key"
                                        :field="field"
                                        :values="values"
                                        :inline="inlineField(field)"
                                        :placeholder="fieldPlaceholder(field)"
                                        :alarm="fieldAlarm(field)"
                                        :quiet="fieldQuiet(field)"
                                        :checked="fieldChecked(field)"
                                        :url-fix="fieldUrlFix(field)"
                                        :note="pasteNotes[field.key]"
                                        :summary="fieldConfSummary(field)"
                                        @edited="onFieldInput(field)"
                                        @pasted="onFieldPaste(field, $event)"
                                        @left="finishField(field)"
                                        @fix="applyUrlFix(field)"
                                    />
                                </template>
                            </template>
                            <!-- Why the grid badged this one: the claim plus the evidence that produced it, which "Not needed" dismisses. -->
                            <!-- The sentence the answers add up to, computed live so it matches what submit actually agrees to. -->
                            <p v-if="formSummary" class="flex items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs text-content">
                                <Icon name="info-circle" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                                {{ formSummary }}
                            </p>

                            <Notice v-if="selectedRecommendation" tone="info">
                                <div class="flex items-start gap-3">
                                    <div class="min-w-0 flex-1">
                                        <div>{{ t(`capabilities.capabilities.recommended`, { reason: selectedRecommendation.reason }) }}</div>
                                        <div class="mt-0.5 truncate font-mono text-2xs text-subtle">{{ selectedRecommendation.evidence }}</div>
                                    </div>
                                    <Button
                                        :label="t(`capabilities.capabilities.notNeeded`)"
                                        size="small"
                                        severity="secondary"
                                        text
                                        :loading="dismissRecommendation.isPending.value"
                                        @click="dismiss(selected)"
                                    />
                                </div>
                            </Notice>

                            <!-- Submit stays stuck to the pane's foot: some tiles (VPN, a device's permissions) are long. -->
                            <!-- What the probe itself said, shown above the submit since "will this work" belongs before the commitment. -->
                            <p
                                v-if="probeResult"
                                class="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
                                :class="
                                    probeResult.ok
                                        ? 'border-success/30 bg-success/5 text-content'
                                        : probeResult.checked
                                          ? 'border-danger/30 bg-danger/5 text-content'
                                          : 'border-line bg-card text-muted'
                                "
                            >
                                <Icon
                                    :name="probeResult.ok ? 'check-circle' : probeResult.checked ? 'exclamation-triangle' : 'info-circle'"
                                    class="mt-0.5 shrink-0 text-2xs"
                                    :class="probeResult.ok ? 'text-success' : probeResult.checked ? 'text-danger' : 'text-subtle'"
                                />
                                {{ probeResult.message }}
                            </p>

                            <div
                                :class="[
                                    'sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 px-1 py-3',
                                    auditable ? 'justify-between' : 'justify-end',
                                    shaking ? 'ui-shake' : '',
                                ]"
                                @animationend="shaking = false"
                            >
                                <!-- The read sits beside the approval, since that's when it matters. -->
                                <button v-if="auditable" type="button" :class="ui.linkButton(`text-2xs`)" @click="startAudit">
                                    {{
                                        updateFrom !== undefined
                                            ? t(`capabilities.capabilities.agentReadWhatChanged`)
                                            : t(`capabilities.capabilities.agentReadFirstWhat`)
                                    }}
                                </button>
                                <!-- Testing is optional and stays secondary to Save; hidden once a tile has answered that no test exists (canProbe). -->
                                <Button
                                    v-if="canProbe"
                                    class="ml-auto"
                                    :label="t(`capabilities.capabilities.test`)"
                                    size="small"
                                    severity="secondary"
                                    text
                                    :loading="probing"
                                    @click="runProbe"
                                >
                                    <template #icon><Icon name="wave-pulse" /></template>
                                </Button>
                                <Button type="submit" size="small" :label="submitLabel" :loading="submitting">
                                    <template #icon><Icon name="check" /></template>
                                </Button>
                            </div>
                        </form>
                    </div>

                    <!-- Docked reference column, shown only above @3xl (below that width, the inline version renders in the form instead). -->
                    <aside class="hidden @3xl:block @3xl:w-80 @3xl:shrink-0 @4xl:w-96">
                        <CapabilityContext :entry="selected" :values="values" :effects="liveEffects" />
                    </aside>
                </div>
            </div>

            <!-- Step 1: the catalog. -->
            <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
                <!-- Offered as one action rather than badges to hunt for, above the filter since it's not one. -->
                <div v-if="walkQueue.length > 0" class="flex flex-wrap items-center gap-3 rounded-lg border border-info/30 bg-info/5 px-4 py-3">
                    <Icon name="sparkles" class="text-info" />
                    <div class="min-w-0 flex-1">
                        <div class="text-sm text-content">
                            {{ t(`capabilities.capabilities.workspaceAsksFor`, { count: walkQueue.length }, walkQueue.length) }}
                        </div>
                        <div class="text-xs text-muted">
                            {{ t(`capabilities.capabilities.eachOneSomethingOwn`) }}
                        </div>
                    </div>
                    <Button :label="t(`capabilities.capabilities.setUp`)" size="small" @click="startSetup">
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
                        <div v-for="group in groupedCatalog" :key="group.label" class="flex flex-col gap-2">
                            <!-- Label alone: the category's own sentence is already the page description once the rail points at it. -->
                            <div v-if="!inCategory" :class="ui.sectionLabel()">{{ group.label }}</div>
                            <!-- Container query, not viewport: how many tiles fit is a fact about this pane, not the screen. -->
                            <div class="grid grid-cols-1 gap-2 @xl:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4">
                                <!-- Padding is the text's, not the tile's, so the mark can reach the tile's edges; `overflow-hidden` clips it to the radius. -->
                                <button
                                    v-for="tile in group.entries"
                                    :key="tile.entry.id"
                                    type="button"
                                    class="flex h-full w-full items-stretch overflow-hidden rounded-lg border border-line-subtle bg-card text-left transition-colors hover:border-line-strong hover:bg-overlay"
                                    @click="pick(tile.entry)"
                                >
                                    <!-- Mark spans the tile's full height as a left-edge band, for scanning a grid of many by logo. -->
                                    <BrandMark
                                        flush
                                        class="border-r border-line"
                                        :size="44"
                                        :name="tile.entry.name"
                                        :logo="tile.entry.logo"
                                        :icon="entryIcon(tile.entry)"
                                    />
                                    <div class="min-w-0 flex-1 px-2.5 py-2">
                                        <!-- One line only: a grid row is as tall as its tallest tile, so any growing line costs every tile beside it. -->
                                        <div class="flex items-center gap-x-1.5">
                                            <span class="truncate text-xs font-semibold text-content">{{ tile.entry.name }}</span>
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
                                                v-tooltip.top="`${tile.recommendation.reason}: ${tile.recommendation.evidence}`"
                                                class="shrink-0 text-2xs text-info"
                                                :aria-label="t(`capabilities.capabilities.recommended2`, { reason: tile.recommendation.reason })"
                                            >
                                                <Icon name="sparkles" />
                                            </span>
                                            <CapabilityEffects :effects="badgeEffects(tile.entry)" :compact="true" />
                                        </div>
                                        <!-- Truncated, not just short: a derived tile's description comes from a manifest nobody here wrote and must not set row height. -->
                                        <div class="truncate text-2xs text-muted">{{ tile.entry.description }}</div>
                                    </div>
                                </button>
                            </div>
                        </div>
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
                :loading="remove.isPending.value"
                @cancel="confirmRemoveId = undefined"
                @confirm="confirmRemove"
            >
                <p class="text-sm text-content">
                    {{ t(`ui.action.remove`) }} <b>{{ confirmRemoveId }}</b> {{ t(`capabilities.capabilities.sandboxTearsDownConfiguration`) }}
                </p>
            </ConfirmDialog>

            <!-- Names what stops as precisely as the Devices board does: this is the same revoke, pressed from the tile. -->
            <ConfirmDialog
                :open="disconnecting !== undefined"
                :header="
                    t(`capabilities.capabilities.disconnectHeader`, { machine: disconnecting?.title ?? t(`capabilities.capabilities.thisMachine`) })
                "
                :confirm-label="t(`ui.action.disconnect`)"
                confirm-icon="times"
                :destructive="true"
                :loading="disconnectingDevice"
                @cancel="disconnecting = undefined"
                @confirm="void confirmDisconnectDevice()"
            >
                <p class="text-sm text-content">
                    <span class="font-mono">{{ disconnecting?.title }}</span> {{ t(`capabilities.capabilities.losesAccessToSandbox`) }}
                </p>
                <p class="mt-2 text-sm text-muted">{{ t(`capabilities.capabilities.connectingAgainMeansRunning`) }}</p>
            </ConfirmDialog>

            <!-- The one edit that's a migration rather than a form field; see askRename. -->
            <CapabilityRenameDialog
                :visible="renameId !== undefined"
                :id="renameId ?? ''"
                :busy="rename.isPending.value"
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

            <!-- One-time command that connects a device of the user's own (host-kind capabilities). -->
            <HostConnectDialog
                v-model:visible="connectVisible"
                :id="connectId"
                :platform="connectPlatform"
                :permissions="connectPermissions"
                :unnamed="connectUnnamed"
                @connected="onHostConnected"
                @renamed="onHostRenamed"
            />

            <!-- One-time code that connects a browser of the user's own (webext-kind capabilities). -->
            <WebExtConnectDialog
                v-model:visible="browserConnectVisible"
                :id="browserConnectId"
                :install="browserInstall"
                :permissions="browserPermissions"
                @connected="onBrowserExtConnected"
            />
        </template>
    </SplitView>
</template>
