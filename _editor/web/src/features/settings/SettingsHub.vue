<script setup lang="ts">
import { type NavGroup, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import HubLayout from "../../workbench/hub/HubLayout.vue";
import type { HubTab } from "../../workbench/hub/hubNav";
import { hubWorkKey, hubWorkRunning } from "../../workbench/hub/hubWork";
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useAudience } from "../../app/useAudience";
import { useHostedPlan } from "../../models/hosted-plan/useHostedPlan";
import SettingsAppearance from "./SettingsAppearance.vue";
import SettingsBilling from "./SettingsBilling.vue";
import SettingsData from "./SettingsData.vue";
import SettingsKeybindings from "./SettingsKeybindings.vue";
import SettingsNotifications from "./SettingsNotifications.vue";
import SettingsProfile from "./SettingsProfile.vue";
import SettingsTokens from "./SettingsTokens.vue";
import OrgConsole from "../organisations/OrgConsole.vue";
import SettingsVoice from "./SettingsVoice.vue";
import { SETTINGS_DEFAULT_SECTION, settingsSections } from "./settingsNav";

// Personal preferences for the signed-in account, cross-sandbox; reached from the account avatar. Built on the same
// <HubLayout> as the sandbox hub, one unlabelled group since NavRail omits the heading for a single group. The rows
// themselves live in settingsNav.ts, shared with the palette's "Settings: …" destinations.

const t = useT();
// Billing joins the index only once the plan read answers, so until then the hub must not read `/settings/billing`
// as an unknown slug: that is the address Stripe returns a payer to, and the redirect would drop `?plan=welcome`.
const { offered: planOffered, isLoading: planLoading } = useHostedPlan();
// A phone's index leaves out what is about a keyboard (settingsNav.ts).
const { mobile } = useDevice();

// A reader who does not write code is not shown the developer's tools in the index (settingsNav.ts), unless the address
// already names one: the palette and a link still reach it, and the hub must not bounce them back to Profile.
const { maker } = useAudience();
const route = useRoute();
const sections = computed(() => {
    const all = settingsSections(planOffered.value, mobile.value);
    if (!maker.value) {
        return all;
    }
    const plain = new Set(settingsSections(planOffered.value, mobile.value, undefined, true).map((section) => section.slug));
    return all.filter((section) => plain.has(section.slug) || section.slug === route.params[`tab`]);
});

const HUB = `settings`;
const DEFAULT = SETTINGS_DEFAULT_SECTION;

// No counts here — nothing in this hub is an errand — so a row badges only while something it started is still
// running (hubWork.ts).
const GROUPS = computed<readonly NavGroup<HubTab>[]>(() => [
    {
        key: `settings`,
        items: sections.value.map((section) => {
            const running = hubWorkRunning(hubWorkKey(HUB, section.slug));
            return running === undefined ? section : { ...section, badge: { running } };
        }),
    },
]);
</script>

<template>
    <HubLayout :title="t(`shared.settings`)" :route-name="HUB" :default-slug="DEFAULT" :groups="GROUPS" :ready="!planLoading">
        <template #default="{ slug }">
            <SettingsProfile v-if="slug === `profile`" />
            <SettingsBilling v-else-if="slug === `billing`" />
            <SettingsAppearance v-else-if="slug === `appearance`" />
            <SettingsNotifications v-else-if="slug === `notifications`" />
            <SettingsVoice v-else-if="slug === `voice`" />
            <SettingsKeybindings v-else-if="slug === `keybindings`" />
            <SettingsTokens v-else-if="slug === `tokens`" />
            <OrgConsole v-else-if="slug === `organisation`" />
            <SettingsData v-else-if="slug === `data`" />
        </template>
    </HubLayout>
</template>
