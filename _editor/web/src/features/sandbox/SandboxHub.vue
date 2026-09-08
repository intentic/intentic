<script setup lang="ts">
import type { NavGroup } from "@intentic/ui";
import { computed } from "vue";
import { useCapabilities } from "../capabilities/connect/useCapabilities";
import { useExtensions } from "../extensions/useExtensions";
import { usePanels } from "../extensions/usePanels";
import { useRegistry } from "../extensions/useRegistry";
import { useRole } from "./secrets/useRole";
import { useSandbox } from "./client/useSandbox";
import { useSyncHealth } from "./devices/useDevices";
import { type ActiveExtension, activationBadge, detectActivations } from "../../core-views/registry";
import ExtensionView from "../../core-views/ExtensionView.vue";
import HubLayout from "../../shell/hub/HubLayout.vue";
import type { HubTab } from "../../shell/hub/hubNav";
import SandboxAccess from "./access/SandboxAccess.vue";
import SandboxAgent from "./overview/SandboxAgent.vue";
import SandboxDevices from "./devices/SandboxDevices.vue";
import SandboxEnvironment from "./environment/SandboxEnvironment.vue";
import SandboxExtensions from "./extensions/SandboxExtensions.vue";
import { toListing, updateCount } from "./extensions/discoverListing";
import SandboxPersonas from "./personas/SandboxPersonas.vue";
import SandboxOverview from "./overview/SandboxOverview.vue";
import SandboxSecrets from "./secrets/SandboxSecrets.vue";
import SandboxUsage from "./usage/SandboxUsage.vue";

// One home for the active sandbox, reached from the rail's chip; the selected section lives in the URL, and only it
// mounts (composables are module singletons, so remounting is cheap). Index is the hub's own sections, then
// extension-contributed `sandbox`-surface views, which render a body through ExtensionView rather than their own Page.

// Extensions row covers finding, installing, managing and disabling as one. Badge counts installed extensions with a
// newer registry commit; info, not warning, since nothing here auto-updates.
const configurationRows = (updates: number): readonly HubTab[] => [
    { slug: `environment`, label: `Environment`, icon: `box` },
    { slug: `secrets`, label: `Secrets`, icon: `key` },
    { slug: `agent`, label: `Agent`, icon: `sparkles` },
    {
        slug: `extensions`,
        label: `Extensions`,
        icon: `sliders-h`,
        badge: updates > 0 ? { count: updates, tone: `info` as const } : undefined,
    },
];
const reachRows = (contendedPorts: number): readonly HubTab[] => [
    // Who may use this box: members, invites, roles. `shield`, not `users` (Personas' glyph, one row below).
    { slug: `access`, label: `Access`, icon: `shield` },
    // Who this box acts as outward; not beside `agent` in Configuration, easy to conflate, opposite in stakes.
    { slug: `personas`, label: `Personas`, icon: `user` },
    // "Devices", not "Sync": a machine is the thing that has folders, ports and sandboxes on it, and the
    // enrollment this tab used to be named after is one property of one of them.
    {
        slug: `devices`,
        label: `Devices`,
        icon: `desktop`,
        badge: contendedPorts > 0 ? { count: contendedPorts, tone: `info` as const } : undefined,
    },
];
// No live-status row or badge; Devices' contended-port count is the only thing here anyone looks for.
const BOX_ROWS: readonly HubTab[] = [
    { slug: `overview`, label: `Overview`, icon: `info-circle` },
    // Clock, not a bank card: plan allowances and reopen time; billing itself lives in Settings ▸ Billing.
    { slug: `usage`, label: `Usage`, icon: `clock` },
];
// Every built-in slug, derived from the rows themselves so adding a section cannot forget to guard its name.
const BUILT_IN = new Set([...BOX_ROWS, ...configurationRows(0), ...reachRows(0)].map((tab) => tab.slug));
const DEFAULT = `overview`;

const sandbox = useSandbox();
// Operating surfaces need the top revokable grant too; the daemon enforces it, this just keeps the index honest.
const { canShip } = useRole();
// The one count in this index anyone looks for; rides the /system/sync poll the sandbox chip already does, free.
const { contendedPorts } = useSyncHealth();
const { panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();
// Extensions row's count reads the cached registry only (`read: false`), never triggering a clone.
const { entries: listedExtensions } = useRegistry({ read: false });
const { extensions: installedExtensions } = useExtensions();
const updatable = computed(() => updateCount(listedExtensions.value.map((entry) => toListing(entry, installedExtensions.value))));

// A colliding activation key is dropped, not shadowed by the v-if chain; built-ins own their names.
const contributed = computed<readonly ActiveExtension[]>(() =>
    detectActivations(panels.value, capabilities.value).filter(
        ({ extension, activation }) => extension.surface === `sandbox` && !BUILT_IN.has(activation.key),
    ),
);
const extensionFor = (slug: string): ActiveExtension | undefined => contributed.value.find(({ activation }) => activation.key === slug);

// Activation's own icon and badge, no room for them in the rail strip. Unknown or missing icon falls back to the icon
// set's generic glyph.
const contributedRow = (active: ActiveExtension): HubTab => ({
    slug: active.activation.key,
    label: active.activation.title,
    icon: (active.activation.icon ?? `th-large`) as HubTab[`icon`],
    badge: activationBadge(active),
});

const groups = computed<readonly NavGroup<HubTab>[]>(() => [
    { key: `box`, label: `This box`, items: BOX_ROWS.filter((tab) => tab.slug !== `usage` || canShip.value) },
    {
        key: `configuration`,
        label: `Configuration`,
        items: configurationRows(updatable.value).filter((tab) => (tab.slug !== `secrets` && tab.slug !== `agent`) || canShip.value),
    },
    {
        key: `reach`,
        label: `Reach`,
        // Personas gates like Secrets/Agent, floored at maintainer; Access stays, revoking your own grant is anyone's.
        items: reachRows(contendedPorts.value.length).filter((tab) => (tab.slug !== `devices` && tab.slug !== `personas`) || canShip.value),
    },
    ...(contributed.value.length === 0 ? [] : [{ key: `contributed`, label: `Added by extensions`, items: contributed.value.map(contributedRow) }]),
]);
</script>

<template>
    <HubLayout :title="sandbox.active.value?.name ?? `Sandbox`" route-name="sandbox" :default-slug="DEFAULT" :groups="groups" :ready="!isLoading">
        <template #default="{ slug }">
            <SandboxOverview v-if="slug === `overview`" />
            <SandboxUsage v-else-if="slug === `usage`" />
            <SandboxSecrets v-else-if="slug === `secrets`" />
            <SandboxEnvironment v-else-if="slug === `environment`" />
            <SandboxAccess v-else-if="slug === `access`" />
            <SandboxPersonas v-else-if="slug === `personas`" />
            <SandboxAgent v-else-if="slug === `agent`" />
            <SandboxExtensions v-else-if="slug === `extensions`" />
            <SandboxDevices v-else-if="slug === `devices`" />
            <!-- Extension-contributed sections, with the same error boundary and lazy-view cache the rail's routed host uses. -->
            <ExtensionView v-else-if="extensionFor(slug) !== undefined" v-bind="extensionFor(slug)!" />
        </template>
    </HubLayout>
</template>
