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

/* Personal preferences for the signed-in account (cross-sandbox). Reached from the account avatar. Built on the
 * same <HubLayout> as the sandbox hub: the symmetry was the point when both were tab strips, and it is more of
 * one now that the layout is shared code rather than two copies of the same forty lines.
 *
 * ONE UNLABELLED GROUP. Five rows is not a set that needs sorting into piles, and <NavRail> omits the heading
 * for a single run precisely so a short index does not wear a line of chrome that says nothing. It still earns
 * the column over the strip it replaced: these five fit a row today, but the reason the sandbox hub's did not
 * is that a hub's sections accumulate, and having the two answer differently is what put a scrollbar on one of
 * them without anyone deciding to.
 *
 * Sandbox-scoped settings (search past chats, import memory) live on the Sandbox ▸ Agent tab, not here. */

/* BILLING is the one page about money, and it is named for the errand rather than for the product: a person
 * who wants to stop paying looks for "Billing", and "Hosted" between Profile and Appearance read as a
 * preference. It exists only on a platform that sells the hosted plan (off by default, and self-hosted
 * platforms keep it off). Until the answer lands the tab is simply absent, which is also the right rendering
 * for a platform where it will never land: a failed read costs nothing but the row. */
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
