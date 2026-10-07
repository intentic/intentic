<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import type { NavGroup } from "@intentic/ui";
import { computed } from "vue";
import { useRoute } from "vue-router";
import { GUEST_SECTION, sandboxBuiltInSlugs, SANDBOX_DEFAULT_SECTION, sandboxSectionGroups } from "./sandboxNav";
import { useCapabilities } from "../capabilities/connect/useCapabilities";
import { useExtensions } from "../extensions/useExtensions";
import { usePanels } from "../extensions/usePanels";
import { useRegistry } from "../extensions/useRegistry";
import { useHostedBuild } from "./secrets/useHostedBuild";
import { useRole } from "../../client/sandbox/useRole";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { type ActiveExtension, activationBadge, detectActivations } from "../../workbench/views/registry";
import ExtensionView from "../../core-views/ExtensionView.vue";
import HubLayout from "../../workbench/hub/HubLayout.vue";
import type { HubTab } from "../../workbench/hub/hubNav";
import { hubWorkKey, hubWorkRunning } from "../../workbench/hub/hubWork";
import SandboxAccess from "./access/SandboxAccess.vue";
import SandboxAgent from "./overview/SandboxAgent.vue";
import SandboxModels from "./models/SandboxModels.vue";
import { sourcesNeedingSomeone } from "./models/modelSources";
import { useModelSources } from "./models/useModelSources";
import { providerDisplayLabel } from "../chat/accounts/providerCatalog";
import { useChat } from "../chat/run/useChat";
import SandboxDeleted from "./deleted/SandboxDeleted.vue";
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
// A persona a link names (`?open=<id>`, the chat rail's Edit persona), handed to its page to land on open.
const route = useRoute();
const openPersona = computed(() => (typeof route.query[`open`] === `string` ? route.query[`open`] : undefined));

// The route these sections live on, and half of the address their long-running work reports under.
const HUB = `sandbox`;

// The count the index carries, and whatever is running behind the row. Extensions counts installed extensions with a
// newer registry commit; info, not warning, since nothing here auto-updates. Models counts what needs a person (an
// account to sign in again or verify, a seat only an admin can restore, a sign-in that ended without connecting) as a
// warning, since a model that cannot serve is a turn that will not run. A run is not an errand, so it adds no count of
// its own: it rides `running`, which the row draws as a turning mark, and a sign-in waiting on the reader is one.
const sectionBadge = (slug: string, counts: { updates: number; models: number }, running: string | undefined): ViewBadge | undefined => {
    const count = slug === `extensions` ? counts.updates : slug === `models` ? counts.models : 0;
    if (count === 0 && running === undefined) {
        return undefined;
    }
    const badge: { -readonly [K in keyof ViewBadge]: ViewBadge[K] } = {};
    if (count > 0) {
        badge.count = count;
        badge.tone = slug === `models` ? `warning` : `info`;
        if (slug === `models`) {
            badge.tooltip = t(`connect.modelSources.badgeNeedsYou`, { count }, count);
        }
    }
    if (running !== undefined) {
        badge.running = running;
    }
    return badge;
};

const sandbox = useSandbox();
// Operating surfaces need the top revokable grant too; the daemon enforces it, this just keeps the index honest.
const { canShip, isGuest } = useRole();
// A guest's hub is one section, so it opens on it rather than on an overview the daemon would refuse.
const defaultSlug = computed(() => (isGuest.value ? GUEST_SECTION : DEFAULT));
const { allPanels: panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();
// Extensions row's count reads the cached registry only (`read: false`), never triggering a clone.
const { entries: listedExtensions } = useRegistry({ read: false });
const { extensions: installedExtensions } = useExtensions();
const updatable = computed(() => updateCount(listedExtensions.value.map((entry) => toListing(entry, installedExtensions.value))));

// What Models' row says without being opened: sources that need a person, plus a sign-in that ended badly, and the one in
// flight as the row's turning mark.
const sources = useModelSources();
const { liveSignIn, signInFailure } = useChat();
const modelsNeedingSomeone = computed(() => sourcesNeedingSomeone(sources.value) + (signInFailure.value === undefined ? 0 : 1));

// The environment build the platform runs for a hosted sandbox: minutes long, server-side, and followed here rather
// than by the section, since the row has to keep saying so while the section is closed. Everything else a section
// starts reports itself through the ledger as it runs (hubWork.ts).
const hosted = computed(() => (sandbox.active.value?.hosted ? sandbox.active.value.id : undefined));
const { build: hostedBuild } = useHostedBuild(() => hosted.value);
const runningIn = (slug: string): string | undefined =>
    hubWorkRunning(hubWorkKey(HUB, slug), sandbox.activeSandboxId.value) ??
    (slug === `environment` && hostedBuild.value?.state === `building` ? t(`sandbox.useHostedBuild.buildingEnvironment`) : undefined) ??
    (slug === `models` && liveSignIn.value !== undefined
        ? t(`connect.modelSources.signingInTo`, { provider: providerDisplayLabel(liveSignIn.value.provider) })
        : undefined);

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
                    badge: sectionBadge(section.slug, { updates: updatable.value, models: modelsNeedingSomeone.value }, runningIn(section.slug)),
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
        :title="sandbox.active.value?.name ?? t(`shared.sandboxHub`)"
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
            <SandboxPersonas v-else-if="slug === `personas`" :open="openPersona" />
            <SandboxAreas v-else-if="slug === `areas`" />
            <SandboxModels v-else-if="slug === `models`" />
            <SandboxAgent v-else-if="slug === `agent`" />
            <SandboxExtensions v-else-if="slug === `extensions`" />
            <SandboxDeleted v-else-if="slug === `deleted`" />
            <!-- Extension-contributed sections, with the same error boundary and lazy-view cache the rail's routed host uses. -->
            <ExtensionView v-else-if="extensionFor(slug) !== undefined" v-bind="extensionFor(slug)!" />
        </template>
    </HubLayout>
</template>
