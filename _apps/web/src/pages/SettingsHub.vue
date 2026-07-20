<script setup lang="ts">
import { Page, PageHeader, Segmented } from "@intentic-app/ui";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import SettingsAppearance from "./settings/SettingsAppearance.vue";
import SettingsData from "./settings/SettingsData.vue";
import SettingsKeybindings from "./settings/SettingsKeybindings.vue";
import SettingsProfile from "./settings/SettingsProfile.vue";

/* Personal preferences for the signed-in account (cross-sandbox). Reached from the account avatar. Tabbed like
 * the sandbox hub for symmetry; the selected tab lives in the URL (/settings/<tab>), default profile omits the
 * param. Sandbox-scoped settings (search past chats, import memory) live on the Sandbox ▸ Agent tab, not here. */

const TABS = [`profile`, `appearance`, `keybindings`, `data`] as const;
type Tab = (typeof TABS)[number];
const DEFAULT: Tab = `profile`;

const route = useRoute();
const router = useRouter();

const activeTab = computed<Tab>(() => {
    const tab = route.params[`tab`];
    return typeof tab === `string` && TABS.includes(tab as Tab) ? (tab as Tab) : DEFAULT;
});

const options = [
    { label: `Profile`, value: `profile` as Tab },
    { label: `Appearance`, value: `appearance` as Tab },
    { label: `Keybindings`, value: `keybindings` as Tab },
    { label: `Data`, value: `data` as Tab },
];

const selectTab = (tab: Tab): void => {
    void router.push({ name: `settings`, params: { tab: tab === DEFAULT ? undefined : tab } });
};

// An unknown slug (/settings/nonsense) resolves to the default — clean the URL back to the canonical /settings.
watch(
    () => route.params[`tab`],
    (tab) => {
        if (typeof tab === `string` && tab.length > 0 && !TABS.includes(tab as Tab)) {
            void router.replace({ name: `settings` });
        }
    },
    { immediate: true },
);
</script>

<template>
    <Page>
        <PageHeader title="Settings" description="Your personal preferences on this platform." />

        <div class="scrollbar-thin mb-5 overflow-x-auto border-b border-line pb-2">
            <Segmented :model-value="activeTab" :options="options" @update:model-value="selectTab" />
        </div>

        <SettingsProfile v-if="activeTab === `profile`" />
        <SettingsAppearance v-else-if="activeTab === `appearance`" />
        <SettingsKeybindings v-else-if="activeTab === `keybindings`" />
        <SettingsData v-else-if="activeTab === `data`" />
    </Page>
</template>
