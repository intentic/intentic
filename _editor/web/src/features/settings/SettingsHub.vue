<script setup lang="ts">
import type { NavGroup } from "@intentic/ui";
import HubLayout from "../../shell/hub/HubLayout.vue";
import type { HubTab } from "../../shell/hub/hubNav";
import { computed } from "vue";
import { useHostedPlan } from "./hosted-plan/useHostedPlan";
import SettingsAppearance from "./SettingsAppearance.vue";
import SettingsBilling from "./SettingsBilling.vue";
import SettingsData from "./SettingsData.vue";
import SettingsKeybindings from "./SettingsKeybindings.vue";
import SettingsNotifications from "./SettingsNotifications.vue";
import SettingsProfile from "./SettingsProfile.vue";

// Personal preferences for the signed-in account, cross-sandbox; reached from the account avatar. Built on the same
// <HubLayout> as the sandbox hub, one unlabelled group since NavRail omits the heading for a single group.
// Sandbox-scoped settings (search past chats, import memory) live on the Sandbox ▸ Agent tab, not here.

// Named "Billing" for the errand, not the product; the tab is absent until offered resolves true.
const { offered: planOffered } = useHostedPlan();

const GROUPS = computed<readonly NavGroup<HubTab>[]>(() => [
    {
        key: `settings`,
        items: [
            { slug: `profile`, label: `Profile`, icon: `user` },
            ...(planOffered.value ? ([{ slug: `billing`, label: `Billing`, icon: `credit-card` }] as const) : []),
            { slug: `appearance`, label: `Appearance`, icon: `palette` },
            { slug: `notifications`, label: `Notifications`, icon: `volume-up` },
            { slug: `keybindings`, label: `Keybindings`, icon: `bolt` },
            { slug: `data`, label: `Data`, icon: `database` },
        ],
    },
]);
const DEFAULT = `profile`;
</script>

<template>
    <HubLayout
        title="Settings"
        route-name="settings"
        :default-slug="DEFAULT"
        :groups="GROUPS"
    >
        <template #default="{ slug }">
            <SettingsProfile v-if="slug === `profile`" />
            <SettingsBilling v-else-if="slug === `billing`" />
            <SettingsAppearance v-else-if="slug === `appearance`" />
            <SettingsNotifications v-else-if="slug === `notifications`" />
            <SettingsKeybindings v-else-if="slug === `keybindings`" />
            <SettingsData v-else-if="slug === `data`" />
        </template>
    </HubLayout>
</template>
