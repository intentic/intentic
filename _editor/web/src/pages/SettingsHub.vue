<script setup lang="ts">
import type { NavGroup } from "@intentic/ui";
import HubLayout from "../hub/HubLayout.vue";
import type { HubTab } from "../hub/hubNav";
import { computed } from "vue";
import { useMembership } from "../composables/membership/useMembership";
import SettingsAppearance from "./settings/SettingsAppearance.vue";
import SettingsData from "./settings/SettingsData.vue";
import SettingsKeybindings from "./settings/SettingsKeybindings.vue";
import SettingsMembership from "./settings/SettingsMembership.vue";
import SettingsNotifications from "./settings/SettingsNotifications.vue";
import SettingsPayouts from "./settings/SettingsPayouts.vue";
import SettingsProfile from "./settings/SettingsProfile.vue";
import SettingsServices from "./settings/SettingsServices.vue";

/* Personal preferences for the signed-in account (cross-sandbox). Reached from the account avatar. Built on the
 * same <HubLayout> as the sandbox hub — the symmetry was the point when both were tab strips, and it is more of
 * one now that the layout is shared code rather than two copies of the same forty lines.
 *
 * ONE UNLABELLED GROUP. Five rows is not a set that needs sorting into piles, and <NavRail> omits the heading
 * for a single run precisely so a short index does not wear a line of chrome that says nothing. It still earns
 * the column over the strip it replaced: these five fit a row today, but the reason the sandbox hub's did not
 * is that a hub's sections accumulate, and having the two answer differently is what put a scrollbar on one of
 * them without anyone deciding to.
 *
 * Sandbox-scoped settings (search past chats, import memory) live on the Sandbox ▸ Agent tab, not here. */

/* Membership only exists on a platform that sells one (the pool is off by default, and self-hosted platforms
 * keep it off), and the tab appears when the answer is yes. Until the answer lands the tab is simply absent,
 * which is also the right rendering for a platform where it will never land — a failed read costs nothing but
 * the row.
 *
 * Payouts ride the SAME answer rather than a second probe: both sides of the pool are switched on by the same
 * platform configuration, so a second round-trip could only ever agree with this one.
 *
 * Read through the app's shared membership entry, so opening Settings from the account menu — which is already
 * showing this account's credit balance from that same entry — costs no further round-trip. */
const { offered: membershipOffered } = useMembership();

const GROUPS = computed<readonly NavGroup<HubTab>[]>(() => [
    {
        key: `settings`,
        items: [
            { slug: `profile`, label: `Profile`, icon: `user` },
            ...(membershipOffered.value
                ? ([
                      { slug: `membership`, label: `Membership`, icon: `star` },
                      { slug: `payouts`, label: `Getting paid`, icon: `credit-card` },
                      { slug: `services`, label: `Offer a service`, icon: `bolt` },
                  ] as const)
                : []),
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
        description="Your personal preferences on this platform."
        route-name="settings"
        :default-slug="DEFAULT"
        :groups="GROUPS"
    >
        <template #default="{ slug }">
            <SettingsProfile v-if="slug === `profile`" />
            <SettingsMembership v-else-if="slug === `membership`" />
            <SettingsPayouts v-else-if="slug === `payouts`" />
            <SettingsServices v-else-if="slug === `services`" />
            <SettingsAppearance v-else-if="slug === `appearance`" />
            <SettingsNotifications v-else-if="slug === `notifications`" />
            <SettingsKeybindings v-else-if="slug === `keybindings`" />
            <SettingsData v-else-if="slug === `data`" />
        </template>
    </HubLayout>
</template>
