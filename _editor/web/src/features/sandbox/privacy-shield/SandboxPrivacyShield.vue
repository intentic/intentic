<script setup lang="ts">
import { RowGroup } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import SandboxAnalytics from "../analytics/SandboxAnalytics.vue";
import { activityPart } from "../activity/activityParts";
import SectionLink from "../SectionLink.vue";
import AgentPrivacyShield from "./AgentPrivacyShield.vue";

// Privacy shield: what may leave this sandbox, and in what form. The shield first, since it is what keeps personal data
// from a model provider nobody trusted, then the one other thing that sends anything about this box out, Intentic's own
// product analytics. Where data can go at all is Data protection's second step, and what the shield did is Activity's:
// one line each says so, so the page holds its settings and nothing else. The shield sat in Agent ▸ Safety, beside the
// command judge, and the analytics switch on Access until 2026-10-16.

const t = useT();

const PLACES = { name: `sandbox`, params: { tab: `data-protection` }, query: { step: `places` } } as const;
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <SectionLink :text="t(`sandbox.privacyShieldPage.intro`)" :to="PLACES" :label="t(`sandbox.privacyShieldPage.wherePlaces`)" />

        <AgentPrivacyShield />

        <!-- Not the agent's traffic but the editor's: usage events and recordings of visits, which this box can refuse whatever each person agreed to. -->
        <RowGroup :label="t(`sandbox.privacyShieldPage.sentToIntentic`)">
            <SandboxAnalytics />
        </RowGroup>

        <SectionLink :text="t(`sandbox.privacyShieldPage.record`)" :to="activityPart(`personal`)" :label="t(`sandbox.privacyShieldPage.recordLink`)" />
    </div>
</template>
