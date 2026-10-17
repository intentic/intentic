<script setup lang="ts">
import { type NavGroup, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import HubLayout from "../../workbench/hub/HubLayout.vue";
import type { HubTab } from "../../workbench/hub/hubNav";
import { hubWorkKey, hubWorkRunning } from "../../workbench/hub/hubWork";
import { useHubSearchPanel } from "../../workbench/hub/useHubSearchPanel";
import { computed, nextTick, watch } from "vue";
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
import { SETTINGS_DEFAULT_SECTION, type SettingsPart, settingsGroups, settingsSections } from "./settingsNav";

// Personal preferences for the signed-in account, cross-sandbox; reached from the account avatar. Built on the same
// <HubLayout> as the sandbox hub, its rows under the headings settingsNav.ts gives them (Account, Preferences,
// Developer), the table the palette's "Settings: …" destinations are read from too. A page too small for a row of its
// own (settingsNav.ts `within`) is drawn at the foot of the section it belongs with, under an anchor of its own.

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
const GROUPS = computed<readonly NavGroup<HubTab>[]>(() =>
    settingsGroups(sections.value).map((group) => ({
        key: group.key,
        label: group.label,
        items: group.sections.map((section) => {
            const running = hubWorkRunning(hubWorkKey(HUB, section.slug));
            return running === undefined ? section : { ...section, badge: { running } };
        }),
    })),
);

const partsOf = (slug: string): readonly SettingsPart[] => sections.value.find((section) => section.slug === slug)?.within ?? [];

// A part's address is its section's page with the part's anchor (`/settings/notifications#voice`). The router scrolls
// only to an anchor already drawn, and the page is drawn after the navigation settles, so the hub scrolls once it is.
watch(
    () => [route.hash, route.params[`tab`]] as const,
    ([hash]) => {
        if (hash.length > 1) {
            void nextTick(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: `start`, behavior: `smooth` }));
        }
    },
    { immediate: true, flush: `post` },
);

// Finds a page or a single setting here or on the sandbox hub, by name (useHubSearchPanel.ts).
const search = useHubSearchPanel(HUB);
</script>

<template>
    <HubLayout :title="t(`shared.settings`)" :route-name="HUB" :default-slug="DEFAULT" :groups="GROUPS" :ready="!planLoading" :search="search">
        <template #default="{ slug }">
            <div class="flex flex-col gap-6">
                <SettingsProfile v-if="slug === `profile`" />
                <SettingsBilling v-else-if="slug === `billing`" />
                <SettingsAppearance v-else-if="slug === `appearance`" />
                <SettingsNotifications v-else-if="slug === `notifications`" />
                <SettingsKeybindings v-else-if="slug === `keybindings`" />
                <SettingsTokens v-else-if="slug === `tokens`" />
                <OrgConsole v-else-if="slug === `organisation`" />
                <section v-for="part in partsOf(slug)" :id="part.slug" :key="part.slug" class="scroll-mt-4">
                    <SettingsVoice v-if="part.slug === `voice`" />
                    <SettingsData v-else-if="part.slug === `data`" />
                </section>
            </div>
        </template>
    </HubLayout>
</template>
