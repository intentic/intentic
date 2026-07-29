<script setup lang="ts">
import { Page, PageHeader, Segmented } from "@intentic-app/ui";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { usePanels } from "../composables/extensions/usePanels";
import { useRunning } from "../composables/sandbox/useRunning";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { detectActivations } from "../core-views/registry";
import ExtensionView from "../core-views/ExtensionView.vue";
import SandboxAccess from "./sandbox/SandboxAccess.vue";
import SandboxAgent from "./sandbox/SandboxAgent.vue";
import SandboxEnvironment from "./sandbox/SandboxEnvironment.vue";
import SandboxExtensions from "./sandbox/SandboxExtensions.vue";
import SandboxOverview from "./sandbox/SandboxOverview.vue";
import SandboxSecrets from "./sandbox/SandboxSecrets.vue";
import SandboxStatus from "./sandbox/SandboxStatus.vue";
import SandboxSync from "./sandbox/SandboxSync.vue";
import SandboxUsage from "./sandbox/SandboxUsage.vue";

/* The sandbox hub: one tabbed home for everything about the active sandbox, reached from the rail's sandbox
 * chip. The selected tab lives in the URL (/sandbox/<tab>) so a reload or a shared link reopens it; the default
 * (overview) omits the param, keeping the canonical /sandbox. Only the active tab mounts (v-if chain), which
 * correctly drives each tab's side-effecting lifecycles (desktop-sync start/stop, the agent's account surface);
 * the underlying composables are module singletons / vue-query caches, so remounting a tab is cheap.
 *
 * The strip is the hub's own tabs FOLLOWED BY the extension-contributed ones (views on the `sandbox` surface) —
 * a view whose subject is the box rather than the work belongs here, not in the rail's fixed icon budget. A
 * contributed tab is routed by its activation key (/sandbox/logs) and rendered through ExtensionView, so it
 * shares the hub's page chrome: the contract is that a sandbox-surface view renders a tab BODY, the way the
 * built-in tabs below do, not its own Page/PageHeader. */

const TABS = [`overview`, `status`, `usage`, `secrets`, `environment`, `access`, `agent`, `extensions`, `sync`] as const;
type Tab = (typeof TABS)[number];
const DEFAULT: Tab = `overview`;

const sandbox = useSandbox();
const route = useRoute();
const router = useRouter();
const { runningCount } = useRunning();
const { panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();

// A contributed activation's key IS its slug, so one colliding with a built-in tab is dropped rather than
// silently shadowed by the v-if chain below — the hub's own tabs own their names.
const contributed = computed(() =>
    detectActivations(panels.value, capabilities.value).filter(
        ({ extension, activation }) => extension.surface === `sandbox` && !TABS.includes(activation.key as Tab),
    ),
);
// Every slug the strip can resolve — the built-ins plus each contributed activation's key.
const slugs = computed<readonly string[]>(() => [...TABS, ...contributed.value.map(({ activation }) => activation.key)]);

const activeTab = computed<string>(() => {
    const tab = route.params[`tab`];
    return typeof tab === `string` && slugs.value.includes(tab) ? tab : DEFAULT;
});
// The contributed activation the active slug names, if any — what the extension outlet renders.
const activeExtension = computed(() => contributed.value.find(({ activation }) => activation.key === activeTab.value));

const options = computed<{ label: string; value: string; badge?: number }[]>(() => [
    { label: `Overview`, value: `overview` },
    { label: `Status`, value: `status`, badge: runningCount.value },
    { label: `Usage`, value: `usage` },
    { label: `Secrets`, value: `secrets` },
    { label: `Environment`, value: `environment` },
    { label: `Access`, value: `access` },
    { label: `Agent`, value: `agent` },
    { label: `Extensions`, value: `extensions` },
    { label: `Sync`, value: `sync` },
    ...contributed.value.map(({ activation }) => ({ label: activation.title, value: activation.key })),
]);

const selectTab = (tab: string): void => {
    void router.push({ name: `sandbox`, params: { tab: tab === DEFAULT ? undefined : tab } });
};

// An unknown slug (/sandbox/nonsense) resolves to the default — clean the URL back to the canonical /sandbox.
// Held until the workspace facts have landed: a contributed tab's slug only exists once its extension's
// detect() has facts to run against, so redirecting earlier would bounce a perfectly good deep link.
watch(
    [() => route.params[`tab`], slugs, isLoading],
    ([tab, known, loading]) => {
        if (!loading && typeof tab === `string` && tab.length > 0 && !known.includes(tab)) {
            void router.replace({ name: `sandbox` });
        }
    },
    { immediate: true },
);
</script>

<template>
    <!-- One width for every tab: the hub's header, description and tab strip are shared chrome, so a per-tab
         width would visibly reflow all of it on each switch. Secrets was `wide` as a standalone page; its rows
         are one line each by design, so they read fine at the hub's content width. -->
    <Page>
        <PageHeader
            :title="sandbox.active.value?.name ?? `Sandbox`"
            description="The workspace AI operates from. The platform keeps only its address; accounts and credentials stay inside it."
        />

        <div class="scrollbar-thin mb-5 overflow-x-auto border-b border-line pb-2">
            <Segmented :model-value="activeTab" :options="options" @update:model-value="selectTab" />
        </div>

        <SandboxOverview v-if="activeTab === `overview`" />
        <SandboxStatus v-else-if="activeTab === `status`" />
        <SandboxUsage v-else-if="activeTab === `usage`" />
        <SandboxSecrets v-else-if="activeTab === `secrets`" />
        <SandboxEnvironment v-else-if="activeTab === `environment`" />
        <SandboxAccess v-else-if="activeTab === `access`" />
        <SandboxAgent v-else-if="activeTab === `agent`" />
        <SandboxExtensions v-else-if="activeTab === `extensions`" />
        <SandboxSync v-else-if="activeTab === `sync`" />
        <!-- The extension-contributed tabs (surface: "sandbox"), rendered with the same error boundary and
             lazy-view cache the rail's routed host uses. -->
        <ExtensionView v-else-if="activeExtension" :extension="activeExtension.extension" :activation="activeExtension.activation" />
    </Page>
</template>
