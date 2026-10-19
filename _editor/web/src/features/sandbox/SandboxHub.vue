<script lang="ts">
import type { Component } from "vue";
import { lazySection } from "../../workbench/hub/lazySection";

// Each section's code is a chunk of its own, fetched when the section is first drawn, so a reload of one page does not
// pay for all of them (workbench/hub/lazySection.ts); the rest are warmed at idle once the open one has drawn. Module
// scope, not setup: a stand-in made once keeps its landed chunk across the hub's remounts, so a section drawn once
// draws at once from then on.
const SandboxOverview = lazySection(() => import("./overview/SandboxOverview.vue"));
const SandboxUsage = lazySection(() => import("./usage/SandboxUsage.vue"));
const SandboxSecrets = lazySection(() => import("./secrets/SandboxSecrets.vue"));
const SandboxDataProtection = lazySection(() => import("./data-protection/SandboxDataProtection.vue"));
const SandboxPrivacyShield = lazySection(() => import("./privacy-shield/SandboxPrivacyShield.vue"));
const SandboxGuardrails = lazySection(() => import("./guardrails/SandboxGuardrails.vue"));
const SandboxRetention = lazySection(() => import("./retention/SandboxRetention.vue"));
const SandboxActivity = lazySection(() => import("./activity/SandboxActivity.vue"));
const SandboxEnvironment = lazySection(() => import("./environment/SandboxEnvironment.vue"));
const SandboxMap = lazySection(() => import("./map/SandboxMap.vue"));
const SandboxAccess = lazySection(() => import("./access/SandboxAccess.vue"));
const SandboxPersonas = lazySection(() => import("./personas/SandboxPersonas.vue"));
const SandboxAreas = lazySection(() => import("./areas/SandboxAreas.vue"));
const SandboxModels = lazySection(() => import("./models/SandboxModels.vue"));
const SandboxAgent = lazySection(() => import("./overview/SandboxAgent.vue"));
const SandboxExtensions = lazySection(() => import("./extensions/SandboxExtensions.vue"));

// The same sections by slug, for the warm-up alone: the template's chain is what draws them.
const SECTIONS = new Map<string, Component>([
    [`overview`, SandboxOverview],
    [`usage`, SandboxUsage],
    [`secrets`, SandboxSecrets],
    [`data-protection`, SandboxDataProtection],
    [`privacy-shield`, SandboxPrivacyShield],
    [`guardrails`, SandboxGuardrails],
    [`retention`, SandboxRetention],
    [`activity`, SandboxActivity],
    [`environment`, SandboxEnvironment],
    [`map`, SandboxMap],
    [`access`, SandboxAccess],
    [`personas`, SandboxPersonas],
    [`areas`, SandboxAreas],
    [`models`, SandboxModels],
    [`agent`, SandboxAgent],
    [`extensions`, SandboxExtensions],
]);
</script>

<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import type { NavGroup } from "@intentic/ui";
import { computed } from "vue";
import { useRoute } from "vue-router";
import {
    GUEST_SECTION,
    isTabbedRow,
    SANDBOX_DEFAULT_SECTION,
    type SandboxNavRow,
    type SandboxSection,
    sandboxBuiltInSlugs,
    sandboxEmbedOf,
    sandboxKeyAllowed,
    sandboxSectionGroups,
} from "../../models/sandbox/sandboxNav";
import { useCapabilities } from "../../models/capabilities/useCapabilities";
import { useExtensions } from "../../models/extensions/useExtensions";
import { usePanels } from "../../models/extensions/usePanels";
import { useRegistry } from "../extensions/useRegistry";
import { useHostedBuild } from "./secrets/useHostedBuild";
import { useRole } from "../../client/sandbox/useRole";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { type ActiveExtension, activationBadge, detectActivations } from "../../workbench/views/registry";
import ExtensionView from "../../core-views/ExtensionView.vue";
import HubLayout from "../../workbench/hub/HubLayout.vue";
import { type HubTab, hubRowSections } from "../../workbench/hub/hubNav";
import { hubWorkKey, hubWorkRunning } from "../../workbench/hub/hubWork";
import { useSectionWarmup } from "../../workbench/hub/lazySection";
import { useHubSearchPanel } from "../../workbench/hub/useHubSearchPanel";
import { sourcesNeedingSomeone } from "./models/modelSources";
import { useModelSources } from "./models/useModelSources";
import { providerDisplayLabel } from "../../models/providers/providerCatalog";
import { useChat } from "../../models/conversations/run/useChat";
import { toListing, updateCount } from "../../models/sandbox/discoverListing";
import OrgHeldSection from "../organisations/OrgHeldSection.vue";
import { useOrgPolicy } from "../organisations/useOrgPolicy";
import { useT } from "@intentic/ui/i18n";

// One home for the active sandbox, reached from the rail's chip; the selected section lives in the URL, and only it
// mounts (composables are module singletons, so remounting is cheap). Index is the hub's own sections (sandboxNav.ts,
// shared with the palette's "Sandbox: …" destinations), then every extension-contributed `sandbox`-surface view, which
// renders a body through ExtensionView rather than its own Page. A section may draw one first-party extension's view as
// a part of its own (Activity draws the Activity extension's turns), and that view is then no row of its own. A row may
// stand for several sections (Privacy & safety), which the layout draws as tabs above the one open; each is still a
// section of its own here, mounted by its slug.

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
const { hidden: orgHidden } = useOrgPolicy();
// The hub's own sections, which an organisation's lock wraps; an extension's view is never one an organisation holds.
const builtIn = computed(() => sandboxBuiltInSlugs());
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

const activations = computed<readonly ActiveExtension[]>(() =>
    detectActivations(panels.value, capabilities.value).filter(({ extension }) => extension.surface === `sandbox`),
);
// A colliding activation key is dropped, not shadowed by the v-if chain: built-ins own their names.
const contributed = computed<readonly ActiveExtension[]>(() => activations.value.filter(({ activation }) => sandboxKeyAllowed(activation.key)));
const extensionFor = (slug: string): ActiveExtension | undefined => contributed.value.find(({ activation }) => activation.key === slug);

// The view a section draws as a part of its own, if the one extension it names contributes it now: switched off or not
// yet loaded, the section goes without that part.
const embedded = (slug: string): ActiveExtension | undefined => {
    const owner = sandboxEmbedOf(slug);
    return owner === undefined ? undefined : activations.value.find((active) => active.owner === owner && active.activation.key === slug);
};

// Activation's own icon and badge, no room for them in the rail strip. Unknown or missing icon falls back to the icon
// set's generic glyph.
const contributedRow = (active: ActiveExtension): HubTab => ({
    slug: active.activation.key,
    label: active.activation.title,
    icon: (active.activation.icon ?? `th-large`) as HubTab[`icon`],
    badge: activationBadge(active),
});

// One section as this reader's index draws it: a built-in with this reader's gating, the two live counts and whatever
// is running laid over it.
const sectionOf = (row: SandboxSection): readonly HubTab[] => {
    if (isGuest.value ? row.slug !== GUEST_SECTION : !canShip.value && row.maintainer === true) {
        return [];
    }
    // Below maintainer, a section that embeds a view is that view alone (Activity is a member's turns), so without it the
    // reader would open an empty page.
    if (row.embeds !== undefined && !canShip.value && embedded(row.slug) === undefined) {
        return [];
    }
    // A section the sandbox's organisation hides leaves the index (organisations/useOrgPolicy.ts).
    if (orgHidden.value.has(row.slug)) {
        return [];
    }
    return [{ ...row, badge: sectionBadge(row.slug, { updates: updatable.value, models: modelsNeedingSomeone.value }, runningIn(row.slug)) }];
};

// One table row: a section, or a tabbed row of the parts this reader may open, which leaves the index with none of
// them. The index shows nothing of a part but its row, so whatever runs behind a part turns the row's mark; no part
// carries a count, so a run is all it has to pass up.
const rowOf = (row: SandboxNavRow): readonly HubTab[] => {
    if (!isTabbedRow(row)) {
        return sectionOf(row);
    }
    const parts = row.parts.flatMap(sectionOf);
    if (parts.length === 0) {
        return [];
    }
    const running = parts.find((part) => part.badge?.running !== undefined)?.badge?.running;
    return [{ slug: row.key, label: row.label, icon: row.icon, parts, badge: running === undefined ? undefined : { running } }];
};

// The table's own grouping, kept intact, then whatever extensions add.
const groups = computed<readonly NavGroup<HubTab>[]>(() => [
    ...sandboxSectionGroups()
        .map((group) => ({ key: group.key, label: group.label, items: group.items.flatMap(rowOf) }))
        .filter((group) => group.items.length > 0),
    ...(contributed.value.length === 0
        ? []
        : [{ key: `contributed`, label: t(`sandbox.sandboxHub.addedByExtensions`), items: contributed.value.map(contributedRow) }]),
]);

// Finds a page or a single setting here or in Settings, by name: a setting is often a page and a category deep, and
// sometimes in the other hub (useHubSearchPanel.ts).
const search = useHubSearchPanel(HUB);

// Warms the sections this reader's index offers, in its order, after the open one: a guest's one section, or a member's
// handful, never the ones they cannot open.
useSectionWarmup(() => groups.value.flatMap((group) => group.items.flatMap(hubRowSections)).map((tab) => SECTIONS.get(tab.slug)));
</script>

<template>
    <HubLayout
        :title="sandbox.active.value?.name ?? t(`shared.sandboxHub`)"
        :route-name="HUB"
        :default-slug="defaultSlug"
        :addressable="isGuest"
        :groups="groups"
        :ready="!isLoading"
        :search="search"
    >
        <template #default="{ slug }">
            <!-- An organisation's lock draws the section read-only; every personal sandbox passes straight through. -->
            <OrgHeldSection v-if="builtIn.has(slug)" :slug="slug">
                <SandboxOverview v-if="slug === `overview`" />
                <SandboxUsage v-else-if="slug === `usage`" />
                <SandboxSecrets v-else-if="slug === `secrets`" />
                <SandboxDataProtection v-else-if="slug === `data-protection`" />
                <SandboxPrivacyShield v-else-if="slug === `privacy-shield`" />
                <SandboxGuardrails v-else-if="slug === `guardrails`" />
                <SandboxRetention v-else-if="slug === `retention`" />
                <SandboxActivity v-else-if="slug === `activity`" :turns="embedded(`activity`) !== undefined">
                    <template #turns><ExtensionView v-bind="embedded(`activity`)!" /></template>
                </SandboxActivity>
                <SandboxEnvironment v-else-if="slug === `environment`" />
                <SandboxMap v-else-if="slug === `map`" :models="sources" />
                <SandboxAccess v-else-if="slug === `access`" :open="openPersona" />
                <SandboxPersonas v-else-if="slug === `personas`" :open="openPersona" />
                <SandboxAreas v-else-if="slug === `areas`" />
                <SandboxModels v-else-if="slug === `models`" />
                <SandboxAgent v-else-if="slug === `agent`" />
                <SandboxExtensions v-else-if="slug === `extensions`" />
            </OrgHeldSection>
            <!-- Extension-contributed sections, with the same error boundary and lazy-view cache the rail's routed host uses. -->
            <ExtensionView v-else-if="extensionFor(slug) !== undefined" v-bind="extensionFor(slug)!" />
        </template>
    </HubLayout>
</template>
