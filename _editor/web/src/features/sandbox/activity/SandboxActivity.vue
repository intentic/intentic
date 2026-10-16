<script setup lang="ts">
import { Notice, SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useRole } from "../../../client/sandbox/useRole";
import { useOrgPolicy } from "../../organisations/useOrgPolicy";
import AgentSafetyLog from "../guardrails/AgentSafetyLog.vue";
import PrivacyShieldRecord from "../privacy-shield/PrivacyShieldRecord.vue";
import SectionLink from "../SectionLink.vue";
import { ACTIVITY_PARTS, type ActivityPart } from "./activityParts";

// Activity: what agents did, in three parts. Turns (what woke the agent, what it called, how each went) are the Activity
// extension's view, drawn here; every command the judge checked and every request the privacy shield handled are the
// sandbox's own records, which sat at the foot of their settings until 2026-10-16. What people did is the audit log,
// beside this. Each record part ends on the way to the settings that made it, as those settings end on the way here.
//
// Core, though the turns are an extension's: switched off, the turns go and the two records stay, which is why they
// were not handed to the extension. A member sees the turns alone, narrowed to their conversations; the records are a
// maintainer's, as the daemon refuses their logs below, and an organisation hiding the pages that set them hides them.

// Whether the Activity extension draws its view now; the hub, which hosts every extension view, hands it in as the
// `turns` slot, so this page names no view host of its own.
const { turns } = defineProps<{ turns: boolean }>();

const t = useT();
const route = useRoute();
const router = useRouter();
const { canShip } = useRole();
const { modeOf } = useOrgPolicy();

const LABELS = computed<Record<ActivityPart, string>>(() => ({
    turns: t(`sandbox.activityPage.turns`),
    commands: t(`sandbox.activityPage.commands`),
    personal: t(`sandbox.activityPage.personal`),
}));

// Turns while the reader can open the page at all (a member's hub drops the row when there are none to show), the two
// records for a maintainer whose organisation shows their pages.
const parts = computed<readonly ActivityPart[]>(() =>
    ACTIVITY_PARTS.filter((part) => {
        if (part === `turns`) {
            return turns || canShip.value;
        }
        return canShip.value && modeOf(part === `commands` ? `guardrails` : `privacy-shield`) !== `hidden`;
    }),
);
const options = computed(() => parts.value.map((part) => ({ label: LABELS.value[part], value: part })));
const first = computed<ActivityPart>(() => parts.value[0] ?? `turns`);

// In the query so a settings page links straight to its record; the first part writes no param. Pushed, not replaced,
// so Back returns to the part before.
const part = computed<ActivityPart>({
    get: () => parts.value.find((entry) => entry !== first.value && entry === route.query[`section`]) ?? first.value,
    set: (value) => void router.push({ query: { ...route.query, section: value === first.value ? undefined : value } }),
});

const GUARDRAILS = { name: `sandbox`, params: { tab: `guardrails` } } as const;
const SHIELD = { name: `sandbox`, params: { tab: `privacy-shield` } } as const;
const EXTENSIONS = { name: `sandbox`, params: { tab: `extensions` } } as const;
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <SegmentedControl v-if="options.length > 1" v-model="part" :options="options" :aria-label="t(`sandbox.activityPage.parts`)" wrap />

        <template v-if="part === `turns`">
            <slot v-if="turns" name="turns" />
            <template v-else>
                <Notice tone="info">{{ t(`sandbox.activityPage.turnsOff`) }}</Notice>
                <SectionLink :text="t(`sandbox.activityPage.turnsOffHow`)" :to="EXTENSIONS" :label="t(`sandbox.sandboxNav.extensions`)" />
            </template>
        </template>

        <template v-else-if="part === `commands`">
            <AgentSafetyLog />
            <SectionLink :text="t(`sandbox.activityPage.commandsSettings`)" :to="GUARDRAILS" :label="t(`sandbox.sandboxNav.guardrails`)" />
        </template>

        <template v-else>
            <PrivacyShieldRecord />
            <SectionLink :text="t(`sandbox.activityPage.personalSettings`)" :to="SHIELD" :label="t(`sandbox.sandboxNav.privacyShield`)" />
        </template>
    </div>
</template>
