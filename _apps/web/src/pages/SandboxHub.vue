<script setup lang="ts">
import type { NavGroup } from "@intentic/ui";
import { computed } from "vue";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { usePanels } from "../composables/extensions/usePanels";
import { useRunning } from "../composables/sandbox/useRunning";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { type ActiveExtension, activationBadge, detectActivations } from "../core-views/registry";
import ExtensionView from "../core-views/ExtensionView.vue";
import HubLayout from "../hub/HubLayout.vue";
import type { HubTab } from "../hub/hubNav";
import SandboxAccess from "./sandbox/SandboxAccess.vue";
import SandboxAgent from "./sandbox/SandboxAgent.vue";
import SandboxEnvironment from "./sandbox/SandboxEnvironment.vue";
import SandboxExtensions from "./sandbox/SandboxExtensions.vue";
import SandboxOverview from "./sandbox/SandboxOverview.vue";
import SandboxSecrets from "./sandbox/SandboxSecrets.vue";
import SandboxStatus from "./sandbox/SandboxStatus.vue";
import SandboxSync from "./sandbox/SandboxSync.vue";
import SandboxUsage from "./sandbox/SandboxUsage.vue";

/* The sandbox hub: one home for everything about the active sandbox, reached from the rail's sandbox chip. The
 * selected section lives in the URL (/sandbox/<tab>) so a reload or a shared link reopens it; <HubLayout> owns
 * that resolution, the index column and the redirect, and this file owns only what is true of THIS hub — which
 * sections exist, how they group, and what renders in the body. Only the active section mounts (v-if chain),
 * which correctly drives each one's side-effecting lifecycles (desktop-sync start/stop, the agent's account
 * surface); the underlying composables are module singletons / vue-query caches, so remounting is cheap.
 *
 * The index is the hub's own sections FOLLOWED BY the extension-contributed ones (views on the `sandbox`
 * surface) — a view whose subject is the box rather than the work belongs here, not in the rail's fixed icon
 * budget. A contributed section is routed by its activation key (/sandbox/logs) and rendered through
 * ExtensionView, so it shares the hub's page chrome: the contract is that a sandbox-surface view renders a
 * section BODY, the way the built-ins below do, not its own Page/PageHeader.
 *
 * THE GROUPS ARE THE HUB'S OWN, and the contributed views get one of their own at the end rather than being
 * filed into the three above. A view knows what it is for, but nothing in the extension API lets it say which
 * of this hub's groups it belongs to — Ports and Public would both sit under "Reach" if it could. Filing them
 * by guesswork would be the host inventing an answer the extension never gave; naming the group after where
 * they came from is the honest one, and it is also the fact a reader wants when a row they do not recognise
 * appears. Give the API a group and they can move. */

const CONFIGURATION: readonly HubTab[] = [
    { slug: `environment`, label: `Environment`, icon: `box` },
    { slug: `secrets`, label: `Secrets`, icon: `key` },
    { slug: `agent`, label: `Agent`, icon: `sparkles` },
    { slug: `extensions`, label: `Extensions`, icon: `sliders-h` },
];
const REACH: readonly HubTab[] = [
    { slug: `access`, label: `Access`, icon: `users` },
    { slug: `sync`, label: `Sync`, icon: `sync` },
];
// Built per render rather than declared flat, because Status wears a live count and the other two do not.
const boxRows = (running: number): readonly HubTab[] => [
    { slug: `overview`, label: `Overview`, icon: `info-circle` },
    { slug: `status`, label: `Status`, icon: `wave-pulse`, badge: running > 0 ? { count: running } : undefined },
    { slug: `usage`, label: `Usage`, icon: `credit-card` },
];
// Every built-in slug, derived from the rows themselves so adding a section cannot forget to guard its name.
const BUILT_IN = new Set([...boxRows(0), ...CONFIGURATION, ...REACH].map((tab) => tab.slug));
const DEFAULT = `overview`;

const sandbox = useSandbox();
const { runningCount } = useRunning();
const { panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();

// A contributed activation's key IS its slug, so one colliding with a built-in section is dropped rather than
// silently shadowed by the v-if chain below — the hub's own sections own their names.
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
    { key: `box`, label: `This box`, items: boxRows(runningCount.value) },
    { key: `configuration`, label: `Configuration`, items: CONFIGURATION },
    { key: `reach`, label: `Reach`, items: REACH },
    ...(contributed.value.length === 0 ? [] : [{ key: `contributed`, label: `Added by extensions`, items: contributed.value.map(contributedRow) }]),
]);
</script>

<template>
    <HubLayout
        :title="sandbox.active.value?.name ?? `Sandbox`"
        description="The workspace AI operates from. The platform keeps only its address; accounts and credentials stay inside it."
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
            <SandboxAgent v-else-if="slug === `agent`" />
            <SandboxExtensions v-else-if="slug === `extensions`" />
            <SandboxSync v-else-if="slug === `sync`" />
            <!-- The extension-contributed sections, rendered with the same error boundary and lazy-view cache
                 the rail's routed host uses. `ActiveExtension` is exactly ExtensionView's two props. -->
            <ExtensionView v-else-if="extensionFor(slug) !== undefined" v-bind="extensionFor(slug)!" />
        </template>
    </HubLayout>
</template>
