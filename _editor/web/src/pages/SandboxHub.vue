<script setup lang="ts">
import type { NavGroup } from "@intentic/ui";
import { computed } from "vue";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { useExtensions } from "../composables/extensions/useExtensions";
import { usePanels } from "../composables/extensions/usePanels";
import { useRegistry } from "../composables/extensions/useRegistry";
import { useRole } from "../composables/sandbox/useRole";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useSyncHealth } from "../composables/sandbox/useDevices";
import { type ActiveExtension, activationBadge, detectActivations } from "../core-views/registry";
import ExtensionView from "../core-views/ExtensionView.vue";
import HubLayout from "../hub/HubLayout.vue";
import type { HubTab } from "../hub/hubNav";
import SandboxAccess from "./sandbox/SandboxAccess.vue";
import SandboxAgent from "./sandbox/SandboxAgent.vue";
import SandboxDevices from "./sandbox/SandboxDevices.vue";
import SandboxEnvironment from "./sandbox/SandboxEnvironment.vue";
import SandboxExtensions from "./sandbox/SandboxExtensions.vue";
import { toListing, updateCount } from "./sandbox/discoverListing";
import SandboxPersonas from "./sandbox/SandboxPersonas.vue";
import SandboxOverview from "./sandbox/SandboxOverview.vue";
import SandboxSecrets from "./sandbox/SandboxSecrets.vue";
import SandboxUsage from "./sandbox/SandboxUsage.vue";

/* The sandbox hub: one home for everything about the active sandbox, reached from the rail's sandbox chip. The
 * selected section lives in the URL (/sandbox/<tab>) so a reload or a shared link reopens it; <HubLayout> owns
 * that resolution, the index column and the redirect, and this file owns only what is true of THIS hub, which
 * sections exist, how they group, and what renders in the body. Only the active section mounts (v-if chain),
 * which correctly drives each one's side-effecting lifecycles (desktop-sync start/stop, the agent's account
 * surface); the underlying composables are module singletons / vue-query caches, so remounting is cheap.
 *
 * The index is the hub's own sections FOLLOWED BY the extension-contributed ones (views on the `sandbox`
 * surface): a view whose subject is the box rather than the work belongs here, not in the rail's fixed icon
 * budget. A contributed section is routed by its activation key (/sandbox/logs) and rendered through
 * ExtensionView, so it shares the hub's page chrome: the contract is that a sandbox-surface view renders a
 * section BODY, the way the built-ins below do, not its own Page/PageHeader.
 *
 * THE GROUPS ARE THE HUB'S OWN, and the contributed views get one of their own at the end rather than being
 * filed into the three above. A view knows what it is for, but nothing in the extension API lets it say which
 * of this hub's groups it belongs to: Ports and Public would both sit under "Reach" if it could. Filing them
 * by guesswork would be the host inventing an answer the extension never gave; naming the group after where
 * they came from is the honest one, and it is also the fact a reader wants when a row they do not recognise
 * appears. Give the API a group and they can move. */

/* ONE ROW FOR EXTENSIONS, and it used to be two. Finding one, installing it, managing it and switching it off
 * are one subject, and Discover sat directly under Extensions with the adjacency described as the point:
 * adjacency was the weaker form of the true thing, and the section owns both halves as pills now (see
 * SandboxExtensions.vue for what the split cost).
 *
 * Its badge is the number of installed extensions the registry has a newer commit for: the one fact in this
 * index that is looked FOR rather than looked at, and it now sits on the row that can act on it, which is the
 * clearest thing the merge bought. Info rather than warning: a newer commit is an offer, not a debt, and
 * nothing here updates itself. */
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
    /* Who may USE this box: members, invites, roles. `shield`, not `users`: Personas sits one row below and
     * used to wear the neighbouring single-person glyph, so two user silhouettes in the same band were the
     * same tile at rail size. */
    { slug: `access`, label: `Access`, icon: `shield` },
    /* Who this box IS when it acts outside: under Reach because that is the direction it points, and
     * deliberately not under Configuration beside `agent`. Those two rows are one letter apart in English and
     * opposite in consequence (which subscription pays for a turn, versus whose name is on what it posts), and
     * neighbouring them is how someone eventually pins a nightly job to the right billing and the wrong Reddit. */
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
/* WHAT THIS BOX IS, AND WHAT IT COSTS. There used to be a third row here, "Status", carrying a live count of
 * the dev servers and services that were up, and it is gone because every part of it was a second copy: the
 * dev servers are the Preview panel's subject (with start, stop and the actual page), Ports names the same
 * servers with what they expose, and a service-kind capability reporting `active` is a state badge its own row
 * on Capabilities already wears, next to the controls this list never had. What was left was a tab that read
 * "docker" on a healthy sandbox: the "Ready · Ready" pattern Overview deleted from itself for the same reason.
 *
 * Its badge went with it, and the badge is the sharper lesson. It was an INVENTORY drawn in the pill every
 * other badge in this app uses to mean "you owe this something": someone who saw "1 port couldn't be mirrored"
 * on the sandbox chip came in here, found the one badge in the index, followed it, and was told that docker is
 * active. Devices carries that errand now, and it is the only count left, because it is the only row in this
 * index a reader is ever looking FOR. Info rather than warning: a contended port breaks nothing (the sandbox
 * serves it fine, it just isn't on localhost). */
const BOX_ROWS: readonly HubTab[] = [
    { slug: `overview`, label: `Overview`, icon: `info-circle` },
    { slug: `usage`, label: `Usage`, icon: `credit-card` },
];
// Every built-in slug, derived from the rows themselves so adding a section cannot forget to guard its name.
const BUILT_IN = new Set([...BOX_ROWS, ...configurationRows(0), ...reachRows(0)].map((tab) => tab.slug));
const DEFAULT = `overview`;

const sandbox = useSandbox();
/* Operating surfaces belong to the highest revokable grant as well as the owner. The daemon independently
 * enforces the same maintainer floor; this only keeps the index honest for lower roles. */
const { canShip } = useRole();
// The one fact in this index that is looked FOR rather than looked at: the free /system/sync read the sandbox
// chip already polls, so badging the row it belongs to costs no request.
const { contendedPorts } = useSyncHealth();
const { panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();
/* The Extensions row's count, read from whatever the registry cache already holds, `read: false`, so opening
 * this hub never causes the clone that browsing a registry is. See useRegistry for why the badge is deliberately
 * free rather than eager. */
const { entries: listedExtensions } = useRegistry({ read: false });
const { extensions: installedExtensions } = useExtensions();
const updatable = computed(() => updateCount(listedExtensions.value.map((entry) => toListing(entry, installedExtensions.value))));

// A contributed activation's key IS its slug, so one colliding with a built-in section is dropped rather than
// silently shadowed by the v-if chain below: the hub's own sections own their names.
const contributed = computed<readonly ActiveExtension[]>(() =>
    detectActivations(panels.value, capabilities.value).filter(
        ({ extension, activation }) => extension.surface === `sandbox` && !BUILT_IN.has(activation.key),
    ),
);
const extensionFor = (slug: string): ActiveExtension | undefined => contributed.value.find(({ activation }) => activation.key === slug);

// The activation's own icon and badge, which the strip had no room to show. `icon` is an open string in the
// public API, so an unknown name renders the icon set's fallback, and a view that named none gets the generic
// glyph rather than leaving a hole in the column.
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
    { key: `reach`, label: `Reach`, items: reachRows(contendedPorts.value.length).filter((tab) => tab.slug !== `devices` || canShip.value) },
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
            <!-- The extension-contributed sections, rendered with the same error boundary and lazy-view cache
                 the rail's routed host uses. `ActiveExtension` is exactly ExtensionView's two props. -->
            <ExtensionView v-else-if="extensionFor(slug) !== undefined" v-bind="extensionFor(slug)!" />
        </template>
    </HubLayout>
</template>
