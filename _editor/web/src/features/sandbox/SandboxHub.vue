<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import type { NavGroup } from "@intentic/ui";
import { computed } from "vue";
import { SANDBOX_BUILT_IN_SLUGS, SANDBOX_DEFAULT_SECTION, SANDBOX_SECTION_GROUPS } from "./sandboxNav";
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
// mounts (composables are module singletons, so remounting is cheap). Index is the hub's own sections (sandboxNav.ts,
// shared with the palette's "Sandbox: …" destinations), then extension-contributed `sandbox`-surface views, which
// render a body through ExtensionView rather than their own Page.

const DEFAULT = SANDBOX_DEFAULT_SECTION;

// The two counts the index carries. Extensions counts installed extensions with a newer registry commit; info, not
// warning, since nothing here auto-updates.
const sectionBadge = (slug: string, updates: number, contendedPorts: number): ViewBadge | undefined => {
    if (slug === `extensions`) {
        return updates > 0 ? { count: updates, tone: `info` } : undefined;
    }
    if (slug === `devices`) {
        return contendedPorts > 0 ? { count: contendedPorts, tone: `info` } : undefined;
    }
    return undefined;
};

const sandbox = useSandbox();
// Operating surfaces need the top revokable grant too; the daemon enforces it, this just keeps the index honest.
const { canShip } = useRole();
// The one count in this index anyone looks for; rides the /system/sync poll the sandbox chip already does, free.
const { contendedPorts } = useSyncHealth();
const { allPanels: panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();
// Extensions row's count reads the cached registry only (`read: false`), never triggering a clone.
const { entries: listedExtensions } = useRegistry({ read: false });
const { extensions: installedExtensions } = useExtensions();
const updatable = computed(() => updateCount(listedExtensions.value.map((entry) => toListing(entry, installedExtensions.value))));

// A colliding activation key is dropped, not shadowed by the v-if chain; built-ins own their names.
const contributed = computed<readonly ActiveExtension[]>(() =>
    detectActivations(panels.value, capabilities.value).filter(
        ({ extension, activation }) => extension.surface === `sandbox` && !SANDBOX_BUILT_IN_SLUGS.has(activation.key),
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

// The table's own grouping, kept intact, with this reader's gating and the two live counts laid over it.
const groups = computed<readonly NavGroup<HubTab>[]>(() => [
    ...SANDBOX_SECTION_GROUPS.map((group) => ({
        key: group.key,
        label: group.label,
        items: group.items
            .filter((section) => canShip.value || section.maintainer !== true)
            .map((section) => ({ ...section, badge: sectionBadge(section.slug, updatable.value, contendedPorts.value.length) })),
    })).filter((group) => group.items.length > 0),
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
