<script setup lang="ts">
import {
    type AddCapabilityInput,
    CAPABILITY_CATALOG,
    CAPABILITY_CATEGORIES,
    type CapabilityCatalogEntry,
    type CapabilityCategory,
    type CapabilityEffect,
    capabilityEffects,
} from "@intentic/capability-catalog";
import type { CapabilityProbe, CapabilityRecommendation, CapabilitySummary } from "@intentic/api-contract";
import {
    BrandMark,
    Button,
    ConfirmDialog,
    FilterBar,
    type IconName,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    RowNote,
    SegmentedControl,
    SplitView,
    StatusBadge,
    ui,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { type CapabilityField, contributionDiscriminator } from "@intentic/extension-manifest";
import { type CapabilityKind, type ForticlientConnection, type HostSummary, VAULTED, type WebExtSummary } from "@intentic/sandbox-contract";
import { type ComputedRef, computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import BrowserProfileDialog from "./connect/BrowserProfileDialog.vue";
import CapabilityFieldRow from "./connect/CapabilityFieldRow.vue";
import ForticlientImport from "./connect/ForticlientImport.vue";
import GitRefField from "./connect/GitRefField.vue";
import HostConnectDialog from "./connect/HostConnectDialog.vue";
import WebExtConnectDialog from "./connect/WebExtConnectDialog.vue";
import PluginRegistryBrowse from "./connect/PluginRegistryBrowse.vue";
import CapabilityConnections, { type CapabilityConnection, type CapabilityConnectionGroup } from "./connect/CapabilityConnections.vue";
import CapabilityContext from "./connect/CapabilityContext.vue";
import CapabilityEffects from "./connect/CapabilityEffects.vue";
import CapabilityInstanceRow from "./connect/CapabilityInstanceRow.vue";
import CapabilityRenameDialog from "./connect/CapabilityRenameDialog.vue";
import CapabilityRail, { type CapabilityScope } from "./connect/CapabilityRail.vue";
import SyncOnlyDeviceRow from "./connect/SyncOnlyDeviceRow.vue";
import NetdiskMounts from "../../components/NetdiskMounts.vue";
import VpnConnections from "../../components/VpnConnections.vue";
import { startAgent } from "../agents/fleet/agentActions";
import { sandboxJson } from "../sandbox/client/sandboxClient";
import { auditBrief, updateBrief } from "../sandbox/extensions/extensionBrief";
import {
    CATEGORY_ICONS,
    entryHaystack,
    contributedTiles,
    entryIcon,
    instancesOf,
    isDefaultName,
    suggestName,
    withIdentityPicker,
} from "./model/tiles";
import {
    type ConnectionState,
    awaitingLogin,
    connectionFacts,
    connectionState,
    machineGrants,
    rebuildStep,
    signsInByHand,
    netdiskFacts,
    vpnFacts,
} from "./model/connections";
import { rememberedSecrets, rememberSecrets } from "./model/devSecrets";
import {
    type StoredSecrets,
    buildConfig,
    cleanName,
    fieldConfig,
    fieldInvalid,
    fieldMissing,
    fieldVerified,
    forticlientAnswers,
    formComplete,
    inlineField,
    isCommitSha,
    keepsSecret,
    nameError,
    seedValues,
    shownFields,
} from "./model/form";
import { type ConfSummary, containerUrlFix, expandPaste, normalizeFieldValue, summarisesWireguard, wireguardSummary } from "./model/normalize";
import { picksVersion } from "./model/refs";
import { hostPresets, hostGrantSummary, localModelMemorySummary, matchHostPreset, walletPolicySummary } from "./model/previews";
import { pushWalletPolicy } from "./model/walletPolicy";
import { probeCapability, useCapabilities } from "./connect/useCapabilities";
import { useExtensions } from "../extensions/useExtensions";
import { useRegistry } from "../extensions/useRegistry";
import { type BackgroundProcessRow, useBackgroundProcesses, viewProcessLogs } from "../terminal/useBackgroundProcesses";
import { useTerminalPanel } from "../terminal/useTerminalPanel";
import { HOST_DOOR, usePeerConnect, WEBEXT_DOOR } from "../sandbox/devices/usePeerConnect";
import { useNetdisk } from "../sandbox/devices/useNetdisk";
import { useVpn } from "../sandbox/devices/useVpn";
import { revokeSyncDevice, useDevices } from "../sandbox/devices/useDevices";
import { type DeviceConnection, deviceConnections, isDeviceConnection, machineNamed, sameMachineNote } from "./model/deviceConnections";
import { useT } from "@intentic/ui/i18n";

// Capabilities give the agent tools (GitHub, MCP servers, SSH hosts, Stripe) and scaffold managed repos. Core tiles are
// static catalog data; cli tiles derive from enabled extensions' contributes.capabilities. Tile facts live in
// ./model/tiles, form logic in ./model/form, connection facts in ./model/connections.

const t = useT();

const { recommendationFor, capabilities, error: listError, add, remove, rename, refetch, dismissRecommendation } = useCapabilities();
const { contributionOf, enabled: enabledExtensions, extensions, settled: extensionsSettled } = useExtensions();
// A tunnel's live address for the Connected slice; the VPN tile reads the same query, so the two can't disagree.
const { links: vpnLinks } = useVpn();
// Same for a disk's mount point and whether it takes writes; the disk tile reads the same query.
const { links: netdiskLinks } = useNetdisk();

// Identities a browser tile can file under; instance state, which the manifest can't know.
const identityIds = computed(() => capabilities.value.filter((instance) => instance.kind === `identity`).map((instance) => instance.id));

// Full tile list: extension-contributed tiles, then the static core catalog.
const allEntries = computed<CapabilityCatalogEntry[]>(() =>
    [...contributedTiles(enabledExtensions.value), ...CAPABILITY_CATALOG].map((entry) => withIdentityPicker(entry, identityIds.value)),
);

const route = useRoute();
const router = useRouter();

// Picked tile is URL-driven (/capabilities/<id>); an unknown or absent slug resolves to undefined.
const selected = computed<CapabilityCatalogEntry | undefined>(() => allEntries.value.find((entry) => entry.id === route.params[`entry`]));
const name = ref(``);
// Whether the user (or a picked tile) chose the name; until then the field tracks the live suggestion.
const nameEdited = ref(false);
// Repaired save name (spaces/punctuation to hyphens); every consumer of the name reads this, not the raw input.
const savedName = computed(() => cleanName(name.value));
const namePreview = computed(() => (savedName.value !== `` && savedName.value !== name.value.trim() ? savedName.value : undefined));

const instancesFor = (entry: CapabilityCatalogEntry): CapabilitySummary[] => instancesOf(entry, capabilities.value);
const selectedInstances = computed<CapabilitySummary[]>(() => (selected.value === undefined ? [] : instancesFor(selected.value)));

// Editing a connection from the tile that made it: URL-driven (`edit=`), replaced not pushed, so reload and Back land
// correctly. A singleton tile is always editing; it has one connection and no query is needed.
const editingId = computed<string>({
    get: () => (typeof route.query[`edit`] === `string` ? route.query[`edit`] : ``),
    set: (value) =>
        void router.replace({ name: `capabilities`, params: route.params, query: { ...route.query, edit: value === `` ? undefined : value } }),
});
// A singleton tile has no list: its one connection IS the tile, so its state goes on the heading.
const soleInstance = computed<CapabilitySummary | undefined>(() => (selected.value?.singleton === true ? selectedInstances.value[0] : undefined));
// The connection the form is over; an unknown or stale `edit` id falls back to adding instead of a blank edit.
const editing = computed<CapabilitySummary | undefined>(
    () => soleInstance.value ?? selectedInstances.value.find((instance) => instance.id === editingId.value),
);

// Credentials this form is keeping; cleared when the form's subject changes (e.g. a FortiClient import).
const keptSecrets = ref<StoredSecrets>(new Set<string>());

// Background gateway liveness for relay connectors (Discord, IMAP), scoped to this tile.
const { rows: processRows, busy: processBusy, start: startProcess, stop: stopProcess } = useBackgroundProcesses();

// The extension serving an instance's processes, resolved per instance since one tile's providers can differ.
const ownerExtensionId = (instance: CapabilitySummary): string | undefined => {
    if (instance.kind === `extension`) {
        return instance.id;
    }
    const provider = String(instance.config[contributionDiscriminator(instance.kind) ?? ``]);
    return enabledExtensions.value.find((extension) =>
        (extension.manifest.contributes?.capabilities ?? []).some(
            (contribution) => contribution.kind === instance.kind && contribution.id === provider,
        ),
    )?.id;
};

// Empty until something is connected: an idle gateway on an unconfigured tile is noise, not health.
const cardProcesses = computed<BackgroundProcessRow[]>(() => {
    const owners = new Set(selectedInstances.value.map(ownerExtensionId).filter((id) => id !== undefined));
    return processRows.value.filter((row) => row.extensionId !== undefined && owners.has(row.extensionId));
});

// A typed name that matches an existing connection is now refused rather than silently overwritten.
const nameCollision = computed(() => editing.value === undefined && selectedInstances.value.some((instance) => instance.id === savedName.value));

// Every tile with the facts all three panes read, computed once rather than per tile. Instances ride along so the
// Connected slice need not re-derive them.
interface CatalogTile {
    readonly entry: CapabilityCatalogEntry;
    readonly instances: readonly CapabilitySummary[];
    readonly connected: number;
    readonly recommendation: CapabilityRecommendation | undefined;
}

const tiles = computed<CatalogTile[]>(() =>
    allEntries.value.map((entry) => {
        const instances = instancesFor(entry);
        return { entry, instances, connected: instances.length, recommendation: recommendationFor(entry.id) };
    }),
);
// The other door a machine can arrive through. Desktop sync is capability-free by design, so a laptop syncing files
// holds no tile — which used to mean this page showed no trace of a machine the Devices board called live. Both read
// the daemon's one device registry now; shared without polling it, since the Devices tab owns that cadence.
const { devices: fleet, readAt: fleetReadAt, refetch: refetchFleet } = useDevices({ poll: false });
const syncOnlyDevices = computed<DeviceConnection[]>(() => deviceConnections(fleet.value, fleetReadAt.value));
// This tile's share of them, for the tile pane's own list.
const selectedDevices = computed<DeviceConnection[]>(() =>
    selected.value === undefined ? [] : syncOnlyDevices.value.filter((row) => row.entryId === selected.value?.id),
);

const connectedTiles = computed<CatalogTile[]>(() => tiles.value.filter((tile) => tile.connected > 0));
const recommendedTiles = computed<CatalogTile[]>(() => tiles.value.filter((tile) => tile.recommendation !== undefined));
// Counts connections, not tiles: one tile can hold several (two Reddit accounts, three SSH boxes).
const connectionCount = computed(() => tiles.value.reduce((total, tile) => total + tile.connected, 0));

// The slices the rail offers beyond categories, and the spelling of "no slice at all".
const ALL = ``;
const CONNECTED = `connected`;
const RECOMMENDED = `recommended`;

const scopeOf = (key: string, label: string, icon: IconName, subset: readonly { connected: number }[]): CapabilityScope => ({
    key,
    label,
    icon,
    total: subset.length,
    connected: subset.filter((tile) => tile.connected > 0).length,
});

const countOf = (total: number, one: string, many: string): string => `${total} ${total === 1 ? one : many}`;

const allScope = computed<CapabilityScope>(() => scopeOf(ALL, `All capabilities`, `bolt`, tiles.value));
// Counts connections so its number matches the list it opens; `meta` spells that out for the tooltip.
const connectedScope = computed<CapabilityScope>(() => ({
    key: CONNECTED,
    label: t(`capabilities.capabilities.connected2`),
    icon: `check-circle`,
    total: connectionCount.value,
    connected: connectionCount.value,
    meta: `${countOf(connectionCount.value, `connection`, `connections`)} across ${countOf(connectedTiles.value.length, `capability`, `capabilities`)}`,
}));
// A cross-cutting row appears only once it holds something, not as a promise of an empty page.
const pinnedScopes = computed<CapabilityScope[]>(() => {
    const scopes = [allScope.value];
    if (connectedTiles.value.length > 0) {
        scopes.push(connectedScope.value);
    }
    if (recommendedTiles.value.length > 0) {
        scopes.push(scopeOf(RECOMMENDED, `Recommended`, `sparkles`, recommendedTiles.value));
    }
    return scopes;
});
// A category with no tiles is not a row; several stay empty until the extension that fills them is enabled.
const categoryScopes = computed<CapabilityScope[]>(() =>
    CAPABILITY_CATEGORIES.flatMap((category) => {
        const subset = tiles.value.filter((tile) => tile.entry.category === category.id);
        return subset.length === 0 ? [] : [scopeOf(category.id, category.label, CATEGORY_ICONS[category.id], subset)];
    }),
);

// What survives leaving this tile: the slice and filter, not the connection being edited, which means nothing
// elsewhere.
const elsewhere = () => ({ ...route.query, edit: undefined });

// Slice and search live in the URL, replaced not pushed (Back undoes opening a tile, not each keystroke). Derived
// from the query, not mirrored into refs.
const queryParam = (key: string) =>
    computed<string>({
        get: () => (typeof route.query[key] === `string` ? route.query[key] : ``),
        set: (value) => void router.replace({ name: `capabilities`, query: { ...elsewhere(), [key]: value === `` ? undefined : value } }),
    });
const scope = queryParam(`category`);
const search = queryParam(`q`);

// An unknown slice (stale link, or Connected once empty) falls back to All rather than a blank grid.
const activeScope = computed<CapabilityScope>(
    () => [...pinnedScopes.value, ...categoryScopes.value].find((entry) => entry.key === scope.value) ?? allScope.value,
);
const railScope = computed<string>({ get: () => activeScope.value.key, set: (value) => (scope.value = value) });
const inCategory = computed(() => categoryScopes.value.some((entry) => entry.key === activeScope.value.key));

// Tiles a slice covers; Connected renders them as connection rows instead of tiles (connectionGroups). Anything
// else here is a category.
const SLICES: Readonly<Record<string, ComputedRef<CatalogTile[]>>> = { [ALL]: tiles, [CONNECTED]: connectedTiles, [RECOMMENDED]: recommendedTiles };
const inScope = computed<CatalogTile[]>(
    () => SLICES[activeScope.value.key]?.value ?? tiles.value.filter((tile) => tile.entry.category === activeScope.value.key),
);

const visibleTiles = computed<CatalogTile[]>(() => {
    const needle = search.value.trim().toLowerCase();
    if (needle === ``) {
        return inScope.value;
    }
    return inScope.value.filter((tile) => entryHaystack(tile.entry).includes(needle));
});

// Visible tiles grouped into display sections in category order; empty sections dropped, derived tiles ordered first.
const groupedCatalog = computed(() =>
    CAPABILITY_CATEGORIES.flatMap((category) => {
        const entries = visibleTiles.value.filter((tile) => tile.entry.category === category.id);
        return entries.length === 0 ? [] : [{ label: category.label, entries }];
    }),
);

// Page description follows the active slice, or the category's hint, or falls back to the catalog blurb.
const SLICE_DESCRIPTIONS: Readonly<Record<string, string>> = {
    [CONNECTED]: `Every connection your agent can reach right now. Open one to change it, to add another of the same kind, or to take it away.`,
    [RECOMMENDED]: `Suggested from what is checked out in your workspace, each one is something your own code already asks for.`,
};
const CATALOG_DESCRIPTION = `Grow your sandbox: each capability gives your agent new tools or connects your accounts. Everything is stored only in your sandbox.`;
const description = computed(
    () =>
        SLICE_DESCRIPTIONS[activeScope.value.key] ??
        CAPABILITY_CATEGORIES.find((category) => category.id === activeScope.value.key)?.hint ??
        CATALOG_DESCRIPTION,
);

watch(capabilities, () => {
    if (selected.value === undefined || nameEdited.value || editing.value !== undefined) {
        return;
    }
    name.value = suggestName(selected.value, selectedInstances.value, probedWho.value);
});

const values = reactive<Record<string, string>>({});
const submitting = ref(false);
const error = ref<NoticeModel | null>(null);
// undefined = confirm dialog closed; a string = the capability id awaiting confirmed removal.
const confirmRemoveId = ref<string>();
// Field keys the user has blurred; errors show only after a field has been visited.
const touched = reactive(new Set<string>());
// True once a submit has been refused; only then does an empty required field turn red.
const attempted = ref(false);
const shaking = ref(false);
const markTouched = (key: string): void => {
    touched.add(key);
};
const finishName = (): void => {
    if (namePreview.value !== undefined) {
        name.value = savedName.value;
    }
    markTouched(`name`);
};

// Runs on blur, when a field's value is done: trims a pasted newline, adds a scheme to a bare host, keeps only a
// port's digits. Written back into the box so the reader sees the correction.
const finishField = (field: CapabilityField): void => {
    values[field.key] = normalizeFieldValue(field, values[field.key] ?? ``);
    markTouched(field.key);
};

// One-line account of what a paste unpacked into, keyed by the field that took it.
const pasteNotes = reactive<Record<string, string>>({});
const onFieldInput = (field: CapabilityField): void => {
    // Editing by hand outdates the paste summary.
    delete pasteNotes[field.key];
};
// A paste recognisably holding more than one field (an ssh command, connection string, deep link, known-provider
// email) fills every field it can and notes where; anything else falls through to an ordinary paste.
const onFieldPaste = (field: CapabilityField, event: ClipboardEvent): void => {
    const entry = selected.value;
    const text = event.clipboardData?.getData(`text`) ?? ``;
    if (entry === undefined || text.trim() === ``) {
        return;
    }
    const expansion = expandPaste(entry, field, values, text);
    if (expansion === undefined) {
        return;
    }
    event.preventDefault();
    Object.assign(values, expansion.values);
    pasteNotes[field.key] = expansion.summary;
};

// Refusals split by severity: fieldAlarm is red (a malformed value, or after a refused submit, a required empty
// box); fieldQuiet is the muted "Required" for a box merely tabbed past.
const nameProblem = computed<string | undefined>(() => nameError(name.value));
const fieldAlarm = (field: CapabilityField): string | undefined => {
    if (!touched.has(field.key) && !attempted.value) {
        return undefined;
    }
    const invalid = fieldInvalid(field, values[field.key], keptSecrets.value);
    if (invalid !== undefined) {
        return invalid;
    }
    return attempted.value && fieldMissing(field, values[field.key], keptSecrets.value) ? `This field is required.` : undefined;
};
const fieldQuiet = (field: CapabilityField): boolean =>
    !attempted.value && touched.has(field.key) && fieldMissing(field, values[field.key], keptSecrets.value);
// Green check beside a label for values a rule can vouch for (a URL that parses, a full sha, a port in range).
const fieldChecked = (field: CapabilityField): boolean => fieldVerified(field, values[field.key]);
// Defined only while a URL field points at the container itself; the one-click localhost fix.
const fieldUrlFix = (field: CapabilityField): string | undefined => containerUrlFix(field, values[field.key]);
const applyUrlFix = (field: CapabilityField): void => {
    const fix = fieldUrlFix(field);
    if (fix !== undefined) {
        values[field.key] = fix;
    }
};
// What a WireGuard blob actually holds, read live so the check happens in the box, not after a failed connect.
const fieldConfSummary = (field: CapabilityField): ConfSummary | undefined => {
    const entry = selected.value;
    return entry !== undefined && summarisesWireguard(entry, field) ? wireguardSummary(values[field.key]) : undefined;
};
// Whether a credential field may be left alone because one is already stored behind it.
const keptField = (field: CapabilityField): boolean => keepsSecret(field, values[field.key], keptSecrets.value);
// Empty credential box placeholder: the tile's default on add, or "already set, leave blank to keep" on edit.
const fieldPlaceholder = (field: CapabilityField): string | undefined =>
    keptField(field) ? `•••••••••••• already set, leave blank to keep it` : field.placeholder;
// Fields shown for a tile: const-valued ones are baked in; `when`-gated ones appear as their toggle changes.
const formFields = (entry: CapabilityCatalogEntry): readonly CapabilityField[] => shownFields(entry, values);
// What the version read authorizes with: the token typed here, or the marker for one this edit is keeping, which the
// daemon resolves against the connection. Without it, editing a private repo's install could never list its versions.
const versionToken = computed<string>(() => {
    const typed = (values[`token`] ?? ``).trim();
    return typed === `` && keptSecrets.value.has(`token`) ? VAULTED : typed;
});
// Main fields are the tile's actual questions; advanced ones default correctly for nearly everyone and fold behind
// one line. The fold opens by default only when an edit holds a non-default advanced value.
const mainFields = (entry: CapabilityCatalogEntry): readonly CapabilityField[] => formFields(entry).filter((field) => field.advanced !== true);
const advancedFields = (entry: CapabilityCatalogEntry): readonly CapabilityField[] => formFields(entry).filter((field) => field.advanced === true);
const advancedOpen = ref(false);
// A browser tile's fold is a specific offer (stored sign-in credentials), not generic "Advanced".
const advancedLabel = (entry: CapabilityCatalogEntry): string => (entry.kind === `browser` ? `Let the agent sign in for you (optional)` : `Advanced`);
const advancedDefault = (field: CapabilityField): string => field.default ?? (field.boolean === true ? `off` : ``);

// What the answers compose into (a spending policy, a RAM bill), kept current with what submit agrees to.
const formSummary = computed<string | undefined>(() => {
    if (selected.value?.kind === `wallet`) {
        return walletPolicySummary(values);
    }
    if (selected.value?.kind === `localmodel`) {
        return localModelMemorySummary(values);
    }
    return undefined;
});

// A device's access as a posture: a preset sets all the switches at once; the sentence states what they currently
// spell. A hand-tuned mix matches no preset and shows nothing selected.
const hostPresetOptions = hostPresets().map((preset) => ({ value: preset.key, label: preset.label }));
const applyHostPreset = (key: string): void => {
    const preset = hostPresets().find((candidate) => candidate.key === key);
    if (preset !== undefined) {
        Object.assign(values, preset.grants);
    }
};

// Live-browser window for a browser capability (an actual signed-in session, not a token), serving both sign-in and
// later browsing. Opens one connection, never a site, since a tile can hold several accounts.
const profileVisible = ref(false);
const profileCapability = ref(``);
const profileLabel = ref(``);
const profileMode = ref<`login` | `browse`>(`login`);
// An ACP agent's interactive sign-in: starts loginCommand in the capability's job session and opens its terminal tab.
const startAgentLogin = async (id: string): Promise<void> => {
    try {
        const { session } = await sandboxJson<{ session: string }>(`/capabilities/${encodeURIComponent(id)}/login`, { method: `POST` });
        useTerminalPanel().openFocused(session);
    } catch (caught) {
        error.value = noticeFrom(caught, `Sign-in could not start.`);
    }
};

const openBrowser = (capability: string, label: string, mode: `login` | `browse` = `login`): void => {
    profileCapability.value = capability;
    profileLabel.value = label;
    profileMode.value = mode;
    profileVisible.value = true;
};

// A completed login flips the capability pending -> active; refetch so it shows.
const onBrowserDone = (): void => {
    void refetch();
};

const touchAll = (): void => {
    touched.add(`name`);
    if (selected.value === undefined) {
        return;
    }
    for (const field of formFields(selected.value)) {
        touched.add(field.key);
    }
};
// The contribution behind a config, via the kind's discriminator; undefined for a kind with no secret/image
// declarations or a core-only kind.
const contributionFor = (kind: CapabilityKind, config: Record<string, string | number | boolean | undefined>) => {
    const key = contributionDiscriminator(kind);
    if (key === undefined) {
        return undefined;
    }
    return contributionOf(kind, String(config[key] ?? ``));
};
// Live over form state so a plugin clone URL tracks typing; the selected tile's extension is always enabled, so
// contributionOf always resolves here.
const liveEffects = computed<readonly CapabilityEffect[]>(() => {
    const entry = selected.value;
    if (entry === undefined) {
        return [];
    }
    const config = fieldConfig(entry, (field) => (values[field.key] ?? ``).trim());
    return capabilityEffects({ kind: entry.kind, id: name.value.trim() || undefined, config, contribution: contributionFor(entry.kind, config) });
});
// Consequential effects a tile statically implies, badged on its grid tile; defaults decide config-dependent ones
// (e.g. SQL's default engine).
const BADGED_EFFECTS = new Set([`image`, `runtime`, `trusted-code`]);
const badgeEffects = (entry: CapabilityCatalogEntry): readonly CapabilityEffect[] => {
    const config = fieldConfig(entry, (field) => field.default);
    return capabilityEffects({ kind: entry.kind, config, contribution: contributionFor(entry.kind, config) }).filter((effect) =>
        BADGED_EFFECTS.has(effect.kind),
    );
};
// A connected instance's effects from its stripped config, plus its manifest if it's an extension. Read only for
// the one per-instance fact that matters here: a machine's granted access (hostGrants).
const instanceEffects = (instance: CapabilitySummary): readonly CapabilityEffect[] =>
    capabilityEffects({
        kind: instance.kind,
        id: instance.id,
        config: instance.config,
        contribution: contributionFor(instance.kind, instance.config),
        manifest: instance.kind === `extension` ? extensions.value.find((extension) => extension.id === instance.id)?.manifest : undefined,
    });

// Connecting a device of the user's own (host-kind): unreachable from here, so the flow is a one-time command run on
// that machine. This page owns dialog identity; roster and revoke live in the shared composable.
const { peerFor: hostFor, revoke: revokeHost, refresh: refreshHosts, start: startHosts, stop: stopHosts } = usePeerConnect<HostSummary>(HOST_DOOR);
const connectVisible = ref(false);
const connectId = ref(``);
const connectPlatform = ref(``);
const connectPermissions = ref(``);
// Still wearing its tile's name (`linux`, `linux-2`): the dialog may then offer the machine's own hostname instead.
const connectUnnamed = ref(false);
const openConnect = (instance: CapabilitySummary): void => {
    connectId.value = instance.id;
    connectPlatform.value = String(instance.config[`platform`] ?? `linux`);
    connectUnnamed.value = isDefaultName(String(instance.config[`platform`] ?? `linux`), instance.id);
    // Grant in the machine's own words (model/connections), shared with the Devices tab, which opens this same
    // dialog on a machine that has stopped answering.
    connectPermissions.value = machineGrants(instance);
    connectVisible.value = true;
};

// Connecting a browser of the user's own (webext-kind): same shape one layer in, but the far end may be a different
// browser, so the flow is a pasted code rather than a command. `install` comes off the tile since that's what
// differs per browser family.
const {
    peerFor: browserFor,
    revoke: revokeBrowser,
    refresh: refreshBrowsers,
    start: startBrowsers,
    stop: stopBrowsers,
} = usePeerConnect<WebExtSummary>(WEBEXT_DOOR);
const browserConnectVisible = ref(false);
const browserConnectId = ref(``);
const browserInstall = ref(``);
const browserPermissions = ref(``);
// What the switches add up to, read off the same effects the tile renders, so dialog and disclosure agree.
const browserGrants = (instance: CapabilitySummary): string => {
    const browser = instanceEffects(instance).find((effect) => effect.kind === `own-browser`);
    const grants = browser === undefined ? [] : browser.grants;
    return grants.length === 0 ? `nothing until you turn a switch on` : grants.join(`, `);
};
const openBrowserConnect = (instance: CapabilitySummary): void => {
    const contribution = contributionFor(instance.kind, instance.config);
    browserConnectId.value = instance.id;
    // Install link comes off the tile that declared this browser family; empty while that family has no listing yet.
    browserInstall.value = (contribution?.kind === `webext` ? contribution.install : undefined) ?? ``;
    browserPermissions.value = browserGrants(instance);
    browserConnectVisible.value = true;
};
// Which of the two dialogs a row's Connect means; the row itself draws one button for both kinds.
const openPairing = (entry: CapabilityCatalogEntry, instance: CapabilitySummary): void =>
    entry.kind === `webext` ? openBrowserConnect(instance) : openConnect(instance);
const removePairedAccess = async (entry: CapabilityCatalogEntry, id: string): Promise<void> => {
    await (entry.kind === `webext` ? revokeBrowser(id) : revokeHost(id));
    void refetch();
};
const onBrowserExtConnected = (): void => {
    void refreshBrowsers();
    void refetch();
};
// A machine coming online flips the capability pending -> active; refetch so the tile follows.
const onHostConnected = (): void => {
    void refreshHosts();
    void refetch();
};
// The dialog took the machine's hostname as the name: the dialog now watches that id, and the row under it moved.
const onHostRenamed = (to: string): void => {
    connectId.value = to;
    connectUnnamed.value = false;
    void refreshHosts();
    void refetch();
};
const removeHostAccess = async (id: string): Promise<void> => {
    await revokeHost(id);
    void refetch();
};
// One roster read while this page is open, so a connected device can say "online" without a dialog open; steady
// polling only runs during a live pairing.
onMounted(startHosts);
onBeforeUnmount(stopHosts);
onMounted(startBrowsers);
onBeforeUnmount(stopBrowsers);

const canSubmit = computed(
    () =>
        selected.value !== undefined &&
        !nameCollision.value &&
        formComplete(selected.value, values, name.value, keptSecrets.value),
);

// Counts from whatever the registry cache already holds (`read: false`); absent until something has actually
// browsed.
const { entries: publishedExtensions } = useRegistry({ read: false });
const publishedCount = computed(() => publishedExtensions.value.length);
const verifiedCount = computed(() => publishedExtensions.value.filter((entry) => entry.trust === `verified`).length);

// Fills the form from a registry pick in <PluginRegistryBrowse>.
const applyRegistryPick = (answers: { name: string; url: string; ref: string; path: string; token: string }): void => {
    name.value = answers.name;
    nameEdited.value = true;
    values[`url`] = answers.url;
    values[`ref`] = answers.ref;
    values[`path`] = answers.path;
    values[`token`] = answers.token;
};

// True once there's a commit sha to read: offers to have an agent read the pinned code before install.
const auditable = computed(() => selected.value?.kind === `extension` && isCommitSha(values[`ref`]) && (values[`url`] ?? ``) !== ``);
// When editing an installed extension to a different sha, the sha being replaced, so the audit can offer a diff
// instead of a fresh read.
const updateFrom = computed<string | undefined>(() => {
    if (!auditable.value || editing.value === undefined) {
        return undefined;
    }
    const installed = editing.value.config[`ref`];
    if (typeof installed !== `string` || !isCommitSha(installed) || installed === values[`ref`]) {
        return undefined;
    }
    return installed;
});
const startAudit = (): void => {
    const typed = name.value.trim();
    const shared = { label: typed === `` ? String(values[`url`]) : typed, url: String(values[`url`]), path: String(values[`path`] ?? ``) };
    if (updateFrom.value === undefined) {
        startAgent(auditBrief({ ...shared, ref: String(values[`ref`]) }));
        return;
    }
    startAgent(updateBrief({ ...shared, fromRef: updateFrom.value, toRef: String(values[`ref`]) }));
};

// The Connected slice: an inventory of instances, not a filtered catalog (see <CapabilityConnections>). What's kept
// here needs the page's own sources (host roster, vpn links, daemon status).

// A tunnel's live address and routes, which no stored config can answer.
const vpnAddress = (id: string): string | undefined => vpnFacts(id, vpnLinks.value);
const netdiskMount = (id: string): string | undefined => netdiskFacts(id, netdiskLinks.value);
// A connection's state, with the machine/browser roster's online answer folded in where there is one.
const rowState = (entry: CapabilityCatalogEntry, instance: CapabilitySummary): ConnectionState =>
    connectionState(entry.kind, instance, (entry.kind === `webext` ? browserFor(instance.id) : hostFor(instance.id))?.online);

// One row per live connection, carrying its category (for grouping) and a haystack of what a reader would actually
// search for: the name they gave it and the address they typed, neither in any tile's prose.
type ConnectionRow = CapabilityConnection & { readonly category: CapabilityCategory; readonly rank: number; readonly haystack: string };

// A device's facts line: its OS, and the other doors onto the same PC when it has any, so two ids that are one
// computer read as one on this screen too.
const hostFacts = (instance: CapabilitySummary): string =>
    [hostFor(instance.id)?.facts?.os ?? connectionFacts(instance), sameMachineNote(fleet.value, instance.id)]
        .filter((fact): fact is string => fact !== undefined && fact !== ``)
        .join(` · `);

const connectionRow = (tile: CatalogTile, instance: CapabilitySummary): ConnectionRow => {
    const state = rowState(tile.entry, instance);
    const facts =
        (tile.entry.kind === `vpn` ? vpnAddress(instance.id) : undefined) ??
        (tile.entry.kind === `netdisk` ? netdiskMount(instance.id) : undefined) ??
        (tile.entry.kind === `device` ? hostFacts(instance) : connectionFacts(instance));
    // An unnamed connection took the tile's id; the tile is then the name, and the line below is free for facts.
    const named = instance.id !== tile.entry.id;
    return {
        title: named ? instance.id : tile.entry.name,
        tile: named ? tile.entry.name : undefined,
        entryId: tile.entry.id,
        id: instance.id,
        logo: tile.entry.logo,
        icon: entryIcon(tile.entry),
        detail: facts,
        state: state.label,
        tone: state.tone,
        // Only shown where something is outstanding, so a working connection's row stays quiet.
        note: state.rank <= 1 ? instance.status.detail : undefined,
        code: state.rank <= 1 ? instance.status.code : undefined,
        category: tile.entry.category,
        rank: state.rank,
        haystack: `${instance.id} ${tile.entry.name} ${tile.entry.kind} ${facts}`.toLowerCase(),
    };
};

// A machine reached by desktop sync alone, stated on the tile it would be connected on. Its word and colour come
// from the Devices board's own rules, so one machine cannot read as live on one screen and missing on the other; the
// note is what this tile can't do with it yet.
const deviceConnectionRow = (tile: CatalogTile, device: DeviceConnection): ConnectionRow => ({
    title: device.title,
    tile: tile.entry.name,
    entryId: tile.entry.id,
    id: device.id,
    logo: tile.entry.logo,
    icon: entryIcon(tile.entry),
    detail: device.detail,
    state: device.state,
    tone: device.tone,
    note: device.note,
    category: tile.entry.category,
    rank: device.rank,
    haystack: `${device.machine} ${tile.entry.name} ${tile.entry.kind} ${device.detail}`.toLowerCase(),
});

const connections = computed<ConnectionRow[]>(() => [
    ...tiles.value.flatMap((tile) => tile.instances.map((instance) => connectionRow(tile, instance))),
    // Joined to the catalog here rather than in the model, so a machine whose tile this sandbox doesn't carry is
    // dropped by the same rule that decides the tile exists at all.
    ...syncOnlyDevices.value.flatMap((device) => {
        const tile = tiles.value.find((candidate) => candidate.entry.id === device.entryId);
        return tile === undefined ? [] : [deviceConnectionRow(tile, device)];
    }),
]);

const visibleConnections = computed<ConnectionRow[]>(() => {
    const needle = search.value.trim().toLowerCase();
    if (needle === ``) {
        return connections.value;
    }
    return connections.value.filter((row) => row.haystack.includes(needle));
});

// Same headings as the grid; sorted within each group so a row needing attention rises past its group, not past
// others.
const connectionGroups = computed<CapabilityConnectionGroup[]>(() =>
    CAPABILITY_CATEGORIES.flatMap((category) => {
        const rows = visibleConnections.value
            .filter((row) => row.category === category.id)
            .toSorted((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
        return rows.length === 0 ? [] : [{ label: category.label, rows }];
    }),
);

const showingConnections = computed(() => activeScope.value.key === CONNECTED);
const nothingMatches = computed(() => (showingConnections.value ? connectionGroups.value.length === 0 : groupedCatalog.value.length === 0));

// A tile's own connection rows (vs. the Connected slice above) share the same state vocabulary (connectionState),
// plus live facts a stored config can't answer. VPN and network disks are drawn separately by <VpnConnections> and
// <NetdiskMounts> since a link's facts change live.
const cardRowFacts = (instance: CapabilitySummary): string => {
    if (selected.value?.kind === `device`) {
        return hostFacts(instance);
    }
    // A browser names itself and how many sites it may work on; no stored config can answer either.
    if (selected.value?.kind === `webext`) {
        const facts = browserFor(instance.id)?.facts;
        return facts === undefined
            ? connectionFacts(instance)
            : `${facts.browser} · ${facts.grants.length} site${facts.grants.length === 1 ? `` : `s`} allowed`;
    }
    return connectionFacts(instance);
};

// The one step a row can't offer itself: a sandbox rebuild, done from the Sandbox screen.
const soleRebuildStep = (instance: CapabilitySummary): boolean => rebuildStep(selected.value?.kind, instance);

// A file dropped outside the FortiClient import zone would navigate the tab away with a half-filled form; swallow
// page-wide drags, the zone's own handler still gets its file.
const swallowFileDrag = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes(`Files`) === true) {
        event.preventDefault();
    }
};
onMounted(() => {
    window.addEventListener(`dragover`, swallowFileDrag);
    window.addEventListener(`drop`, swallowFileDrag);
});
onBeforeUnmount(() => {
    window.removeEventListener(`dragover`, swallowFileDrag);
    window.removeEventListener(`drop`, swallowFileDrag);
});

// Fills the form from an imported FortiClient connection; credentials are never among them (FortiClient encrypts
// them), so `needs` marks which fields still need typing. Clears the kept-secrets set: an open edit's old password
// must not silently apply to the imported gateway.
const pickForticlient = (connection: ForticlientConnection): void => {
    name.value = connection.id;
    nameEdited.value = true;
    keptSecrets.value = new Set<string>();
    Object.assign(values, forticlientAnswers(selected.value?.fields ?? [], connection));
    // Land on the fields still needed, not the top of the form.
    touched.clear();
};

// Lets the daemon dial the service the way the connection would (capabilities/probe.ts) and shows its own words
// back. Offered only where a check exists; `checked: false` retires the button rather than claiming failure.
const probing = ref(false);
const probeResult = ref<CapabilityProbe>();
// Whose credential the last successful probe said it was; the name suggestion carries it until the form clears, so a
// list refetch re-suggesting the name lands on the same `<tile>-<who>` rather than falling back to `-2`.
const probedWho = ref<string>();
// Hidden once a tile has answered that no test exists for it.
const canProbe = computed(() => selected.value !== undefined && probeResult.value?.checked !== false);
const runProbe = async (): Promise<void> => {
    const entry = selected.value;
    if (entry === undefined || probing.value) {
        return;
    }
    probing.value = true;
    probeResult.value = undefined;
    try {
        probeResult.value = await probeCapability({
            id: savedName.value || entry.id,
            kind: entry.kind,
            config: buildConfig(entry, values, keptSecrets.value),
        });
        // The service has named the account: a name nobody typed yet follows it (`github-ada`, not `github-2`).
        if (probeResult.value.ok && probeResult.value.who !== undefined) {
            probedWho.value = probeResult.value.who;
            if (!nameEdited.value && editing.value === undefined) {
                name.value = suggestName(entry, selectedInstances.value, probedWho.value);
            }
        }
    } catch (caught) {
        error.value = noticeFrom(caught, `Could not test that connection.`);
    } finally {
        probing.value = false;
    }
};

const clearForm = (): void => {
    name.value = ``;
    nameEdited.value = false;
    for (const key of Object.keys(values)) {
        delete values[key];
    }
    for (const key of Object.keys(pasteNotes)) {
        delete pasteNotes[key];
    }
    probeResult.value = undefined;
    probedWho.value = undefined;
    keptSecrets.value = new Set<string>();
    error.value = null;
    touched.clear();
    attempted.value = false;
    shaking.value = false;
};

// The name a freshly opened form carries, and whether it counts as chosen — a chosen one is never overwritten by the
// live suggestion as connections come and go. Editing keeps the connection's own name; adding suggests a free one.
const openingName = (entry: CapabilityCatalogEntry, instance: CapabilitySummary | undefined): { name: string; chosen: boolean } => {
    if (instance !== undefined) {
        return { name: instance.id, chosen: false };
    }
    // Arrived from a machine that already syncs, to grant it the door it lacks. Its own name comes along deliberately:
    // naming both doors the same is what lets the daemon fold them into one row (mergeDevices) rather than list the
    // machine twice.
    const machine = typeof route.query[`device`] === `string` ? route.query[`device`] : ``;
    return machine === `` ? { name: suggestName(entry, instancesFor(entry)), chosen: false } : { name: machine, chosen: true };
};

// Re-seeds the form whenever the URL's tile or connection changes, so a deep link to an edit works. Keyed on ids
// rather than objects: both come from the live capability list, and watching objects would empty the form on every
// refetch.
watch(
    // `device` rides along: arriving at a tile already open (a Connect on one of its own machine rows) changes
    // nothing else, and the name it carries is the whole point of that navigation.
    [() => selected.value?.id, () => editing.value?.id, () => route.query[`device`]],
    () => {
        const entry = selected.value;
        const instance = editing.value;
        if (entry === undefined) {
            return;
        }
        clearForm();
        const opening = openingName(entry, instance);
        name.value = opening.name;
        nameEdited.value = opening.chosen;
        // Seed is the live config plus dev autofill; credentials aren't included (see keptSecrets).
        Object.assign(values, seedValues(entry, instance?.config, recommendationFor(entry.id)?.prefill ?? {}), rememberedSecrets(entry));
        keptSecrets.value = new Set(instance?.secrets ?? []);
        // Opens by default when a value in the fold differs from default, so an edit never hides what it's set to.
        advancedOpen.value = entry.fields.some((field) => field.advanced === true && (values[field.key] ?? ``) !== advancedDefault(field));
    },
    { immediate: true },
);

// An unknown tile slug resolves to no tile, so bounce to the grid. Gated on extensions having settled: a
// deep-linked connector tile is unknown until /extensions delivers its contribution.
watch(
    [() => route.params[`entry`], extensionsSettled],
    ([tile]) => {
        if (typeof tile === `string` && tile.length > 0 && extensionsSettled.value && selected.value === undefined) {
            void router.replace({ name: `capabilities`, query: elsewhere() });
        }
    },
    { immediate: true },
);

// Picking or going back is a navigation: the URL is the source of truth. Query carries over (minus edit) so Back
// lands on the same slice.
const openTile = (entry: string): void => {
    void router.push({ name: `capabilities`, params: { entry }, query: elsewhere() });
};
const pick = (entry: CapabilityCatalogEntry): void => {
    openTile(entry.id);
};

const back = (): void => {
    void router.push({ name: `capabilities`, query: elsewhere() });
};

// Opens a connection of the tile on screen; `replace` since stepping between connections isn't a history stop.
const openEdit = (id: string): void => {
    editingId.value = id;
};
// Same landing from Connected, a click away from the tile, so it pushes; Back returns to the list. A machine that is
// only syncing has no connection to open, so it lands on the tile's own add form with its name carried over, which
// is the step it is actually missing.
const openConnection = (entry: string, connection: string): void => {
    const query = isDeviceConnection(connection) ? { device: machineNamed(connection) } : { edit: connection };
    void router.push({ name: `capabilities`, params: { entry }, query: { ...elsewhere(), ...query } });
};
const stopEditing = (): void => {
    editingId.value = ``;
};
// Connect, from a machine's own row on the tile that would grant it. Fills the add form with its name and nothing
// else: connecting a device hands over a shell, its files and its screen, so the switches stay a decision made here
// rather than something a single click does quietly.
const connectSyncedDevice = (device: DeviceConnection): void => openConnection(device.entryId, device.id);

// Disconnect, from the same row. The machine holds no capability to remove, so this ends the enrollment it is listed
// for — the daemon takes every other door that machine holds with it, including one whose tile is already gone.
const disconnecting = ref<DeviceConnection>();
const disconnectingDevice = ref(false);
const askDisconnectDevice = (device: DeviceConnection): void => {
    disconnecting.value = device;
};
const confirmDisconnectDevice = async (): Promise<void> => {
    const device = disconnecting.value;
    if (device === undefined) {
        return;
    }
    disconnectingDevice.value = true;
    error.value = null;
    try {
        await revokeSyncDevice(device.machine);
    } catch (err) {
        error.value = noticeFrom(err, `Could not disconnect that machine.`);
    } finally {
        disconnectingDevice.value = false;
        disconnecting.value = undefined;
        // Refetched whether or not the call threw: the row is losing its enrollment either way.
        refetchFleet();
    }
};

// Walks the recommended tiles one at a time, reusing each tile's own ordinary form rather than a separate wizard.
// The queue is derived from the query, never snapshotted, so connecting or dismissing a tile removes it by itself.
const SETUP = `recommended`;
const walking = computed(() => route.query[`setup`] === SETUP);
const walkQueue = computed<CapabilityCatalogEntry[]>(() => recommendedTiles.value.filter((tile) => tile.connected === 0).map((tile) => tile.entry));

// Next tile after this one, read before the change that removes it from the queue, or "next" answers wrong.
const nextAfter = (entry: CapabilityCatalogEntry): string | undefined => {
    const at = walkQueue.value.findIndex((candidate) => candidate.id === entry.id);
    return (at === -1 ? walkQueue.value[0] : walkQueue.value[at + 1])?.id;
};
// Nothing left means the walk is over, back to the catalog it just populated.
const goNext = (entry: string | undefined): void => {
    void router.push(
        entry === undefined
            ? { name: `capabilities`, query: { ...elsewhere(), setup: undefined } }
            : { name: `capabilities`, params: { entry }, query: elsewhere() },
    );
};
const startSetup = (): void => {
    const first = walkQueue.value[0];
    if (first !== undefined) {
        void router.push({ name: `capabilities`, params: { entry: first.id }, query: { ...elsewhere(), setup: SETUP } });
    }
};
const skip = (): void => {
    if (selected.value !== undefined) {
        goNext(nextAfter(selected.value));
    }
};
// Where a finished tile goes: onward through the walk, or back to its slice.
const leaveTile = (next: string | undefined): void => {
    if (walking.value) {
        goNext(next);
        return;
    }
    back();
};

const selectedRecommendation = computed(() => (selected.value === undefined ? undefined : recommendationFor(selected.value.id)));

// "Not needed" quiets the suggestion until its evidence changes; the tile itself is untouched, only the badge goes.
const dismiss = async (entry: CapabilityCatalogEntry): Promise<void> => {
    const next = walking.value ? nextAfter(entry) : undefined;
    error.value = null;
    try {
        await dismissRecommendation.mutateAsync(entry.id);
    } catch (err) {
        error.value = noticeFrom(err, `Could not dismiss that suggestion.`);
        return;
    }
    leaveTile(next);
};

// A pending result means setup isn't finished, so stay on the tile (whose row already names the missing step)
// instead of returning to the grid. The dialog-based steps open immediately; a rebuild step only links to the
// Sandbox screen.
const handOff = (entry: CapabilityCatalogEntry, added: CapabilitySummary): void => {
    // A machine that's never checked in is waiting on the one-liner; one that has is merely asleep.
    if (entry.kind === `device` && hostFor(added.id)?.lastSeen === undefined) {
        openConnect(added);
        return;
    }
    // A browser that's never checked in is waiting on the pairing code.
    if (entry.kind === `webext` && browserFor(added.id)?.lastSeen === undefined) {
        openBrowserConnect(added);
        return;
    }
    // An identity's sign-in is a manual login: open the window immediately, as for a fresh account.
    if (signsInByHand(entry.kind) && awaitingLogin(added)) {
        openBrowser(added.id, added.id);
    }
};

// The submit as refused: raise the alarm tier, so from here on a required-but-empty box is the thing actually
// blocking the reader and is allowed to say so in red, and make the refusal visible.
const refuseSubmit = (entry: NonNullable<typeof selected.value>): void => {
    attempted.value = true;
    // A refusal the reader cannot see is a form that looks broken: if what blocks the submit sits in the
    // Advanced fold, open it.
    if (
        advancedFields(entry).some(
            (field) =>
                fieldMissing(field, values[field.key], keptSecrets.value) || fieldInvalid(field, values[field.key], keptSecrets.value) !== undefined,
        )
    ) {
        advancedOpen.value = true;
    }
    shaking.value = false;
    void nextTick(() => {
        shaking.value = true;
    });
};

/* THE WALLET'S CAPS ARE THE PLATFORM'S TO ENFORCE, so its tile is two writes (model/walletPolicy.ts):. */
const pushedWalletPolicy = async (entry: NonNullable<typeof selected.value>, config: Record<string, string>): Promise<boolean> => {
    if (entry.kind !== `wallet`) {
        return true;
    }
    try {
        await pushWalletPolicy(config);
        return true;
    } catch (caught) {
        error.value = noticeFrom(
            caught,
            `The tile was saved, but the platform did not take its spending caps, so the signer still enforces the previous ones. Save the tile again to retry.`,
        );
        return false;
    }
};

const submit = async (): Promise<void> => {
    const entry = selected.value;
    if (entry === undefined || submitting.value) {
        return;
    }
    // Mark every field touched; a refusal past this point is one the reader is shown.
    touchAll();
    if (!canSubmit.value) {
        refuseSubmit(entry);
        return;
    }
    submitting.value = true;
    error.value = null;
    /* One write for both, because the daemon's is one write: adding and editing are the same upsert over. */
    const config = buildConfig(entry, values, keptSecrets.value);
    const input: AddCapabilityInput = { id: savedName.value, kind: entry.kind, config };
    // Read BEFORE the write, like `next` below: a one-per-sandbox tile that is being connected for the first
    // time becomes an edit the moment its entry lands, and asking afterwards would call every first add an edit.
    const wasEditing = editing.value !== undefined;
    // Where the walk goes next, decided against the queue before this add removes the tile from it.
    const next = walking.value ? nextAfter(entry) : undefined;
    try {
        await add(input, (line) => {
            // Opens the install's own terminal tab so progress is the real commands, not a separate summary retelling
            // them.
            if (line[`kind`] === `terminal` && typeof line[`session`] === `string`) {
                useTerminalPanel().openFocused(line[`session`]);
            }
        });
        rememberSecrets(entry, values);
        if (!(await pushedWalletPolicy(entry, config))) {
            return;
        }
        attempted.value = false;
        const added = capabilities.value.find((capability) => capability.id === input.id);
        if (added?.status.state === `pending`) {
            handOff(entry, added);
            // A pending add is the one path that leaves the form up, so reset it down to the next free name; an edit
            // keeps its
            // name by design.
            if (!wasEditing) {
                clearForm();
                name.value = suggestName(entry, instancesFor(entry));
            }
            return;
        }
        // An edit stays on the tile so the reader can check the row now matches; an add returns to the catalog it just
        // populated.
        if (wasEditing) {
            stopEditing();
            return;
        }
        leaveTile(next);
    } catch (err) {
        error.value = noticeFrom(err, wasEditing ? `Could not save that connection.` : `Could not add the capability.`);
    } finally {
        submitting.value = false;
    }
};

const removeCapability = async (id: string): Promise<void> => {
    error.value = null;
    try {
        await remove.mutateAsync(id);
    } catch (err) {
        error.value = noticeFrom(err, `Could not remove the capability.`);
    }
};

const askRemove = (id: string): void => {
    confirmRemoveId.value = id;
};

// Renaming a connection has no path elsewhere: every other field is retyped and saved over the same name, but
// changing the name itself needed a remove-and-recreate. The refusal sits beside the dialog since it's about the
// name still in the field.
const renameId = ref<string>();
const renameError = ref<NoticeModel>();
const askRename = (id: string): void => {
    renameError.value = undefined;
    renameId.value = id;
};
const confirmRename = async (to: string): Promise<void> => {
    const id = renameId.value;
    if (id === undefined) {
        return;
    }
    renameError.value = undefined;
    try {
        await rename.mutateAsync({ id, to });
    } catch (err) {
        renameError.value = noticeFrom(err, `Could not rename that connection.`);
        return;
    }
    renameId.value = undefined;
};
const confirmRemove = async (): Promise<void> => {
    const id = confirmRemoveId.value;
    if (id === undefined) {
        return;
    }
    await removeCapability(id);
    confirmRemoveId.value = undefined;
};

const topError = computed<NoticeModel | undefined>(() => {
    if (error.value !== null) {
        return error.value;
    }
    if (listError.value === undefined) {
        return undefined;
    }
    return { tone: `danger`, title: t(`capabilities.capabilities.couldntListCapabilities`), detail: listError.value };
});

// Submit's word in the tile's own vocabulary: editing leads, since a pre-filled form must not offer to "Add" a live
// connection; DevOps activates.
const submitLabel = computed(() => {
    if (editing.value !== undefined) {
        return `Save changes`;
    }
    if (selected.value?.kind === `devops`) {
        return `Activate`;
    }
    return `Add`;
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
                                @click="askRemove(soleInstance.id)"
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
                                @remove="askRemove"
                            />
                            <NetdiskMounts
                                v-else-if="selected.kind === 'netdisk' && selectedInstances.length > 0"
                                :instances="selectedInstances"
                                :editing-id="editing?.id"
                                @edit="openEdit"
                                @rename="askRename"
                                @remove="askRemove"
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
                                    @remove="askRemove(instance.id)"
                                />
                                <!-- Last, after what is actually connected: machines already reachable through desktop sync, which this tile would give commands, files and screen. -->
                                <SyncOnlyDeviceRow
                                    v-for="device in selectedDevices"
                                    :key="device.id"
                                    :device="device"
                                    @connect="connectSyncedDevice(device)"
                                    @disconnect="askDisconnectDevice(device)"
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
                @done="onBrowserDone"
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
