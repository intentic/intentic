<script setup lang="ts">
import type { NavGroup } from "@intentic/ui";
import { computed } from "vue";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { useExtensions } from "../composables/extensions/useExtensions";
import { usePanels } from "../composables/extensions/usePanels";
import { useRegistry } from "../composables/extensions/useRegistry";
import { useRole } from "../composables/sandbox/useRole";
import { useRunning } from "../composables/sandbox/useRunning";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useSyncHealth } from "../composables/sandbox/useComputers";
import { type ActiveExtension, activationBadge, detectActivations } from "../core-views/registry";
import ExtensionView from "../core-views/ExtensionView.vue";
import HubLayout from "../hub/HubLayout.vue";
import type { HubTab } from "../hub/hubNav";
import SandboxAccess from "./sandbox/SandboxAccess.vue";
import SandboxAgent from "./sandbox/SandboxAgent.vue";
import SandboxComputers from "./sandbox/SandboxComputers.vue";
import SandboxDiscover from "./sandbox/SandboxDiscover.vue";
import SandboxEnvironment from "./sandbox/SandboxEnvironment.vue";
import SandboxExtensions from "./sandbox/SandboxExtensions.vue";
import { toListing, updateCount } from "./sandbox/discoverListing";
import SandboxPersonas from "./sandbox/SandboxPersonas.vue";
import SandboxOverview from "./sandbox/SandboxOverview.vue";
import SandboxSecrets from "./sandbox/SandboxSecrets.vue";
import SandboxStatus from "./sandbox/SandboxStatus.vue";
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

/* Discover sits directly under Extensions, and the adjacency is the point. Finding one, installing it, managing
 * it and switching it off are one subject, and they used to be two pages: the tab below listed what you had and
 * its empty state pointed at the Capabilities page to get more. A surface for extensions that has to send you
 * elsewhere for extensions is the whole of what was wrong.
 *
 * Its badge is the number of installed extensions the registry has a newer commit for: the one fact in this
 * index that is looked FOR rather than looked at, on the row that can act on it. Info rather than warning: a
 * newer commit is an offer, not a debt, and nothing here updates itself. */
const configurationRows = (updates: number): readonly HubTab[] => [
    { slug: `environment`, label: `Environment`, icon: `box` },
    { slug: `secrets`, label: `Secrets`, icon: `key` },
    { slug: `agent`, label: `Agent`, icon: `sparkles` },
    { slug: `extensions`, label: `Extensions`, icon: `sliders-h` },
    { slug: `discover`, label: `Discover`, icon: `search`, badge: updates > 0 ? { count: updates, tone: `info` as const } : undefined },
];
const reachRows = (contendedPorts: number): readonly HubTab[] => [
    { slug: `access`, label: `Access`, icon: `users` },
    /* Who this box IS when it acts outside: under Reach because that is the direction it points, and
     * deliberately not under Configuration beside `agent`. Those two rows are one letter apart in English and
     * opposite in consequence (which subscription pays for a turn, versus whose name is on what it posts), and
     * neighbouring them is how someone eventually pins a nightly job to the right billing and the wrong Reddit. */
    { slug: `personas`, label: `Personas`, icon: `user` },
    // "Computers", not "Sync": a machine is the thing that has folders, ports and sandboxes on it, and the
    // enrollment this tab used to be named after is one property of one of them.
    {
        slug: `computers`,
        label: `Computers`,
        icon: `desktop`,
        badge: contendedPorts > 0 ? { count: contendedPorts, tone: `info` as const } : undefined,
    },
];
/* Built per render rather than declared flat, because two of these rows wear a live count and the third does not.
 *
 * BOTH COUNTS ARE TONED, and Status's is the reason the tone exists. It is an INVENTORY: how many services and
 * dev servers are up, and it was drawn in the same pill as every badge in the app that means "you owe this
 * something". Someone who saw "1 port couldn't be mirrored" on the sandbox chip came in here, found the one badge
 * in the index sitting on Status, followed it, and was told that docker is active: a badge that answered a
 * question nobody had asked, on the page they were sent to by a different one. Neutral ink settles it: the row
 * still says how many things are alive, in ink that does not claim to be an errand.
 *
 * Computers carries the errand instead, because it is where the port is explained and where the sandbox holding
 * it can be stopped. Info rather than warning: a contended port breaks nothing (the sandbox serves it fine, it
 * just isn't on localhost), but it is the one row in this index that a reader is looking FOR. */
const boxRows = (running: number): readonly HubTab[] => [
    { slug: `overview`, label: `Overview`, icon: `info-circle` },
    { slug: `status`, label: `Status`, icon: `wave-pulse`, badge: running > 0 ? { count: running, tone: `neutral` } : undefined },
    { slug: `usage`, label: `Usage`, icon: `credit-card` },
];
// Every built-in slug, derived from the rows themselves so adding a section cannot forget to guard its name.
const BUILT_IN = new Set([...boxRows(0), ...configurationRows(0), ...reachRows(0)].map((tab) => tab.slug));
const DEFAULT = `overview`;

const sandbox = useSandbox();
/* The credentials tier is the owner's alone, and it is ABSENT for everyone else rather than locked: a lock on
 * a secrets tab is an invitation to ask for the values; absence is a boundary. Environment and Extensions stay
 *: members see state there and the owner-only writes are gated in place. Usage joins the ship tier (spend is
 * the operator's reading). The daemon floors all of it regardless; this only keeps the index honest. */
const { canShip, isOwner } = useRole();
const { runningCount } = useRunning();
// The one fact in this index that is looked FOR rather than looked at: the free /system/sync read the sandbox
// chip already polls, so badging the row it belongs to costs no request.
const { contendedPorts } = useSyncHealth();
const { panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();
/* The Discover row's count, read from whatever the registry cache already holds, `read: false`, so opening
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
    { key: `box`, label: `This box`, items: boxRows(runningCount.value).filter((tab) => tab.slug !== `usage` || canShip.value) },
    {
        key: `configuration`,
        label: `Configuration`,
        items: configurationRows(updatable.value).filter((tab) => (tab.slug !== `secrets` && tab.slug !== `agent`) || isOwner.value),
    },
    { key: `reach`, label: `Reach`, items: reachRows(contendedPorts.value.length).filter((tab) => tab.slug !== `computers` || isOwner.value) },
    ...(contributed.value.length === 0 ? [] : [{ key: `contributed`, label: `Added by extensions`, items: contributed.value.map(contributedRow) }]),
]);
</script>

<template>
    <HubLayout
        :title="sandbox.active.value?.name ?? `Sandbox`"
        route-name="sandbox"
        :default-slug="DEFAULT"
        :groups="groups"
        :ready="!isLoading"
    >
        <template #default="{ slug }">
            <SandboxOverview v-if="slug === `overview`" />
            <SandboxStatus v-else-if="slug === `status`" />
            <SandboxUsage v-else-if="slug === `usage`" />
            <SandboxSecrets v-else-if="slug === `secrets`" />
            <SandboxEnvironment v-else-if="slug === `environment`" />
            <SandboxAccess v-else-if="slug === `access`" />
            <SandboxPersonas v-else-if="slug === `personas`" />
            <SandboxAgent v-else-if="slug === `agent`" />
            <SandboxExtensions v-else-if="slug === `extensions`" />
            <SandboxDiscover v-else-if="slug === `discover`" />
            <SandboxComputers v-else-if="slug === `computers`" />
            <!-- The extension-contributed sections, rendered with the same error boundary and lazy-view cache
                 the rail's routed host uses. `ActiveExtension` is exactly ExtensionView's two props. -->
            <ExtensionView v-else-if="extensionFor(slug) !== undefined" v-bind="extensionFor(slug)!" />
        </template>
    </HubLayout>
</template>
