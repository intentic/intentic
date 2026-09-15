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
import { SETTINGS_DEFAULT_SECTION, settingsSections } from "./settingsNav";

// Personal preferences for the signed-in account, cross-sandbox; reached from the account avatar. Built on the same
// <HubLayout> as the sandbox hub, one unlabelled group since NavRail omits the heading for a single group. The rows
// themselves live in settingsNav.ts, shared with the palette's "Settings: …" destinations.

const { offered: planOffered } = useHostedPlan();

const GROUPS = computed<readonly NavGroup<HubTab>[]>(() => [{ key: `settings`, items: settingsSections(planOffered.value) }]);
const DEFAULT = SETTINGS_DEFAULT_SECTION;
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
