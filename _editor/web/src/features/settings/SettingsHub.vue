<script lang="ts">
import type { Component } from "vue";
import { lazySection } from "../../workbench/hub/lazySection";
import type { SettingsPartSlug, SettingsSlug } from "./settingsNav";

// Each section's code, and each part's, is a chunk of its own, fetched when it is first drawn, so a reload of one page
// does not pay for all of them (workbench/hub/lazySection.ts); the rest are warmed at idle once the open one has drawn.
// Module scope, not setup: a stand-in made once keeps its landed chunk across the hub's remounts, so a section drawn
// once draws at once from then on.
const SettingsProfile = lazySection(() => import("./SettingsProfile.vue"));
const SettingsBilling = lazySection(() => import("./SettingsBilling.vue"));
const SettingsAppearance = lazySection(() => import("./SettingsAppearance.vue"));
const SettingsNotifications = lazySection(() => import("./SettingsNotifications.vue"));
const SettingsKeybindings = lazySection(() => import("./SettingsKeybindings.vue"));
const SettingsTokens = lazySection(() => import("./SettingsTokens.vue"));
const OrgConsole = lazySection(() => import("../organisations/OrgConsole.vue"));
const SettingsVoice = lazySection(() => import("./SettingsVoice.vue"));
const SettingsData = lazySection(() => import("./SettingsData.vue"));

// The same, by the slug the index names each under: what the hub fetches ahead and warms. The template's chain is what
// draws them.
const SECTIONS = {
    profile: SettingsProfile,
    billing: SettingsBilling,
    organisation: OrgConsole,
    appearance: SettingsAppearance,
    notifications: SettingsNotifications,
    keybindings: SettingsKeybindings,
    tokens: SettingsTokens,
    voice: SettingsVoice,
    data: SettingsData,
} satisfies Record<SettingsSlug | SettingsPartSlug, Component>;
</script>

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
import { fetchSections, sectionLanded, useSectionWarmup } from "../../workbench/hub/lazySection";
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

const sectionOf = (slug: string) => sections.value.find((section) => section.slug === slug);

// A page's code: its section's and its parts'.
const pageOf = (slug: string): readonly Component[] => {
    const section = sectionOf(slug);
    return section === undefined ? [] : [SECTIONS[section.slug], ...(section.within ?? []).map((part) => SECTIONS[part.slug])];
};

// A part waits for its section's code: drawn first, it would be pushed down the page when the section landed above it.
const partsOf = (slug: string): readonly SettingsPart[] => {
    const section = sectionOf(slug);
    return section !== undefined && sectionLanded(SECTIONS[section.slug]) ? (section.within ?? []) : [];
};

// The page the address names, or the default page for an address that names none of this reader's (a param-less one,
// or Billing on a cold load, which the index lists only once the plan read answers and which then fetches its own).
const openSlug = computed(() => sectionOf(String(route.params[`tab`] ?? ``))?.slug ?? DEFAULT);

// The open page's parts are fetched with its section, not once the section has landed and drawn them.
watch(
    () => pageOf(openSlug.value),
    (page) => void fetchSections(page),
    { immediate: true },
);

// A part's address is its section's page with the part's anchor (`/settings/notifications#voice`). The router scrolls
// only to an anchor already drawn, and the page is drawn after the navigation settles and its code has landed, so the
// hub scrolls once both have: before the section above it is drawn, the part sits where the section will be.
watch(
    () => [route.hash, route.params[`tab`]] as const,
    ([hash]) => {
        if (hash.length > 1) {
            void fetchSections(pageOf(openSlug.value))
                .then(() => nextTick())
                .then(() => {
                    if (route.hash === hash) {
                        document.getElementById(hash.slice(1))?.scrollIntoView({ block: `start`, behavior: `smooth` });
                    }
                });
        }
    },
    { immediate: true, flush: `post` },
);

// Finds a page or a single setting here or on the sandbox hub, by name (useHubSearchPanel.ts).
const search = useHubSearchPanel(HUB);

// Warms the pages this reader's index offers, in its order, after the open one.
useSectionWarmup(() => sections.value.flatMap((section) => pageOf(section.slug)));
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
