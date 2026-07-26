<script setup lang="ts">
import { Page, PageHeader, Segmented } from "@intentic-app/ui";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useRunning } from "../composables/sandbox/useRunning";
import { useSandbox } from "../composables/sandbox/useSandbox";
import SandboxAccess from "./sandbox/SandboxAccess.vue";
import SandboxAgent from "./sandbox/SandboxAgent.vue";
import SandboxEnvironment from "./sandbox/SandboxEnvironment.vue";
import SandboxExtensions from "./sandbox/SandboxExtensions.vue";
import SandboxOverview from "./sandbox/SandboxOverview.vue";
import SandboxStatus from "./sandbox/SandboxStatus.vue";
import SandboxSync from "./sandbox/SandboxSync.vue";
import SandboxUsage from "./sandbox/SandboxUsage.vue";

/* The sandbox hub: one tabbed home for everything about the active sandbox, reached from the rail's sandbox
 * chip. The selected tab lives in the URL (/sandbox/<tab>) so a reload or a shared link reopens it; the default
 * (overview) omits the param, keeping the canonical /sandbox. Only the active tab mounts (v-if chain), which
 * correctly drives each tab's side-effecting lifecycles (desktop-sync start/stop, the agent's account surface);
 * the underlying composables are module singletons / vue-query caches, so remounting a tab is cheap. */

const TABS = [`overview`, `status`, `usage`, `environment`, `access`, `agent`, `extensions`, `sync`] as const;
type Tab = (typeof TABS)[number];
const DEFAULT: Tab = `overview`;

const sandbox = useSandbox();
const route = useRoute();
const router = useRouter();
const { runningCount } = useRunning();

const activeTab = computed<Tab>(() => {
    const tab = route.params[`tab`];
    return typeof tab === `string` && TABS.includes(tab as Tab) ? (tab as Tab) : DEFAULT;
});

const options = computed(() => [
    { label: `Overview`, value: `overview` as Tab },
    { label: `Status`, value: `status` as Tab, badge: runningCount.value },
    { label: `Usage`, value: `usage` as Tab },
    { label: `Environment`, value: `environment` as Tab },
    { label: `Access`, value: `access` as Tab },
    { label: `Agent`, value: `agent` as Tab },
    { label: `Extensions`, value: `extensions` as Tab },
    { label: `Sync`, value: `sync` as Tab },
]);

const selectTab = (tab: Tab): void => {
    void router.push({ name: `sandbox`, params: { tab: tab === DEFAULT ? undefined : tab } });
};

// An unknown slug (/sandbox/nonsense) resolves to the default — clean the URL back to the canonical /sandbox.
watch(
    () => route.params[`tab`],
    (tab) => {
        if (typeof tab === `string` && tab.length > 0 && !TABS.includes(tab as Tab)) {
            void router.replace({ name: `sandbox` });
        }
    },
    { immediate: true },
);
</script>

<template>
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
        <SandboxEnvironment v-else-if="activeTab === `environment`" />
        <SandboxAccess v-else-if="activeTab === `access`" />
        <SandboxAgent v-else-if="activeTab === `agent`" />
        <SandboxExtensions v-else-if="activeTab === `extensions`" />
        <SandboxSync v-else-if="activeTab === `sync`" />
    </Page>
</template>
