<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import type { NavGroup } from "@intentic/ui";
import { computed } from "vue";
import { GUEST_SECTION, sandboxBuiltInSlugs, SANDBOX_DEFAULT_SECTION, sandboxSectionGroups } from "./sandboxNav";
import { useCapabilities } from "../capabilities/connect/useCapabilities";
import { useExtensions } from "../extensions/useExtensions";
import { usePanels } from "../extensions/usePanels";
import { useRegistry } from "../extensions/useRegistry";
import { useHostedBuild } from "./secrets/useHostedBuild";
import { useRole } from "./secrets/useRole";
import { useSandbox } from "./client/useSandbox";
import { useSyncHealth } from "./devices/useDevices";
import { type ActiveExtension, activationBadge, detectActivations } from "../../core-views/registry";
import ExtensionView from "../../core-views/ExtensionView.vue";
import HubLayout from "../../shell/hub/HubLayout.vue";
import type { HubTab } from "../../shell/hub/hubNav";
import { hubWorkKey, hubWorkRunning } from "../../shell/hub/hubWork";
import SandboxAccess from "./access/SandboxAccess.vue";
import SandboxAgent from "./overview/SandboxAgent.vue";
import SandboxDevices from "./devices/SandboxDevices.vue";
import SandboxEnvironment from "./environment/SandboxEnvironment.vue";
import SandboxExtensions from "./extensions/SandboxExtensions.vue";
import { toListing, updateCount } from "./extensions/discoverListing";
import SandboxPersonas from "./personas/SandboxPersonas.vue";
import SandboxAreas from "./areas/SandboxAreas.vue";
import SandboxOverview from "./overview/SandboxOverview.vue";
import SandboxSecrets from "./secrets/SandboxSecrets.vue";
import SandboxUsage from "./usage/SandboxUsage.vue";
import { useT } from "@intentic/ui/i18n";

// One home for the active sandbox, reached from the rail's chip; the selected section lives in the URL, and only it
// mounts (composables are module singletons, so remounting is cheap). Index is the hub's own sections (sandboxNav.ts,
// shared with the palette's "Sandbox: …" destinations), then extension-contributed `sandbox`-surface views, which
// render a body through ExtensionView rather than their own Page.

const t = useT();

const DEFAULT = SANDBOX_DEFAULT_SECTION;
// The route these sections live on, and half of the address their long-running work reports under.
const HUB = `sandbox`;

// The two counts the index carries, and whatever is running behind the row. Extensions counts installed extensions
// with a newer registry commit; info, not warning, since nothing here auto-updates. A run is not an errand, so it
// adds no count of its own: it rides `running`, which the row draws as a turning mark.
const sectionBadge = (slug: string, updates: number, heldPorts: number, running: string | undefined): ViewBadge | undefined => {
    const count = slug === `extensions` ? updates : slug === `devices` ? heldPorts : 0;
    if (count === 0 && running === undefined) {
        return undefined;
    }
    return { ...(count > 0 ? { count, tone: `info` as const } : {}), ...(running === undefined ? {} : { running }) };
};

const sandbox = useSandbox();
// Operating surfaces need the top revokable grant too; the daemon enforces it, this just keeps the index honest.
const { canShip, isGuest } = useRole();
// A guest's hub is one section, so it opens on it rather than on an overview the daemon would refuse.
const defaultSlug = computed(() => (isGuest.value ? GUEST_SECTION : DEFAULT));
// The one count in this index anyone looks for; rides the /system/sync poll the sandbox chip already does, free.
const { heldPorts } = useSyncHealth();
const { allPanels: panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();
// Extensions row's count reads the cached registry only (`read: false`), never triggering a clone.
const { entries: listedExtensions } = useRegistry({ read: false });
const { extensions: installedExtensions } = useExtensions();
const updatable = computed(() => updateCount(listedExtensions.value.map((entry) => toListing(entry, installedExtensions.value))));

// The environment build the platform runs for a hosted sandbox: minutes long, server-side, and followed here rather
// than by the section, since the row has to keep saying so while the section is closed. Everything else a section
// starts reports itself through the ledger as it runs (hubWork.ts).
const hosted = computed(() => (sandbox.active.value?.hosted ? sandbox.active.value.id : undefined));
const { build: hostedBuild } = useHostedBuild(() => hosted.value);
const runningIn = (slug: string): string | undefined =>
    hubWorkRunning(hubWorkKey(HUB, slug), sandbox.activeSandboxId.value) ??
    (slug === `environment` && hostedBuild.value?.state === `building` ? `Building your environment` : undefined);

// A colliding activation key is dropped, not shadowed by the v-if chain; built-ins own their names.
const contributed = computed<readonly ActiveExtension[]>(() =>
    detectActivations(panels.value, capabilities.value).filter(
        ({ extension, activation }) => extension.surface === `sandbox` && !sandboxBuiltInSlugs().has(activation.key),
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

// The table's own grouping, kept intact, with this reader's gating, the two live counts and whatever is running
// laid over it.
const groups = computed<readonly NavGroup<HubTab>[]>(() => [
    ...sandboxSectionGroups()
        .map((group) => ({
            key: group.key,
            label: group.label,
            items: group.items
                .filter((section) => (isGuest.value ? section.slug === GUEST_SECTION : canShip.value || section.maintainer !== true))
                .map((section) => ({
                    ...section,
                    badge: sectionBadge(section.slug, updatable.value, heldPorts.value.length, runningIn(section.slug)),
                })),
        }))
        .filter((group) => group.items.length > 0),
    ...(contributed.value.length === 0
        ? []
        : [{ key: `contributed`, label: t(`sandbox.sandboxHub.addedByExtensions`), items: contributed.value.map(contributedRow) }]),
]);
</script>

<template>
    <HubLayout
        :title="sandbox.active.value?.name ?? t(`sandbox.sandboxHub.sandbox`)"
        :route-name="HUB"
        :default-slug="defaultSlug"
        :addressable="isGuest"
        :groups="groups"
        :ready="!isLoading"
    >
        <template #default="{ slug }">
            <SandboxOverview v-if="slug === `overview`" />
            <SandboxUsage v-else-if="slug === `usage`" />
            <SandboxSecrets v-else-if="slug === `secrets`" />
            <SandboxEnvironment v-else-if="slug === `environment`" />
            <SandboxAccess v-else-if="slug === `access`" />
            <SandboxPersonas v-else-if="slug === `personas`" />
            <SandboxAreas v-else-if="slug === `areas`" />
            <SandboxAgent v-else-if="slug === `agent`" />
            <SandboxExtensions v-else-if="slug === `extensions`" />
            <SandboxDevices v-else-if="slug === `devices`" />
            <!-- Extension-contributed sections, with the same error boundary and lazy-view cache the rail's routed host uses. -->
            <ExtensionView v-else-if="extensionFor(slug) !== undefined" v-bind="extensionFor(slug)!" />
        </template>
    </HubLayout>
</template>
