<script setup lang="ts">
import { Await, RowGroup, RowNote, SkeletonRows } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import { activityPart } from "../activity/activityParts";
import SectionLink from "../SectionLink.vue";
import AgentProjectInstalls from "./AgentProjectInstalls.vue";
import AgentSafetyJudge from "./AgentSafetyJudge.vue";
import AgentSafetyPolicy from "./AgentSafetyPolicy.vue";
import GuardrailActions from "./GuardrailActions.vue";
import GuardrailAdmission from "./GuardrailAdmission.vue";

// Guardrails: what the agent may do without asking a person. Inside the box first (a command the judge reads against
// the policy, a package install), then outside it (a message, an office act, another agent), then whether work someone
// outside started may run at all. Every decision the judge made is Activity's, with every other record of what agents
// did; one line says so at the foot. The judge, installs and policy were Agent ▸ Safety, beside the privacy shield,
// until 2026-10-16: two questions with different stakes under one word.

const t = useT();
const { loaded: settingsRead } = useSandboxSettings();
</script>

<template>
    <!-- Four of these groups draw the sandbox's settings: never their defaults standing in for a read that has not
         answered or failed ("On" and "Automatic" were shown as this sandbox's choices under a failing read). -->
    <Await :of="settingsRead" imprint="sandbox.guardrails">
        <!-- The first screen as it lands: the judge's two rows and the installs row, each titled, described and with a
             control at its end, then the policy document's heading and paragraphs. The groups' titles never change, so
             they are drawn for real. -->
        <template #fallback>
            <div role="status" aria-busy="true" :aria-label="t(`ui.status.loading`)" class="@container flex flex-col gap-6">
                <RowGroup :label="t(`sandbox.agentSafetyJudge.safetyJudge`)"><SkeletonRows :rows="2" description control /></RowGroup>
                <RowGroup :label="t(`sandbox.agentProjectInstalls.title`)"><SkeletonRows :rows="1" description control /></RowGroup>
                <RowGroup :label="t(`sandbox.agentSafetyPolicy.safetyPolicy`)">
                    <RowNote variant="block"><span class="flex flex-col gap-3" aria-hidden="true">
                        <span class="skeleton block h-5 w-36" />
                        <span v-for="(width, index) in [`w-full`, `w-11/12`, `w-full`, `w-3/4`]" :key="index" class="skeleton block h-3" :class="width" />
                        <span class="mt-6 skeleton block h-5 w-32" />
                        <span v-for="(width, index) in [`w-full`, `w-5/6`, `w-1/2`]" :key="`second-${index}`" class="skeleton block h-3" :class="width" />
                    </span></RowNote>
                </RowGroup>
            </div>
        </template>
        <div class="@container flex flex-col gap-6">
            <AgentSafetyJudge />
            <!-- Beside the judge: the other answer to whether a person is asked before an agent's command runs. -->
            <AgentProjectInstalls />
            <AgentSafetyPolicy />
            <GuardrailActions />
            <GuardrailAdmission />
            <SectionLink :text="t(`sandbox.guardrails.record`)" :to="activityPart(`commands`)" :label="t(`sandbox.guardrails.recordLink`)" />
        </div>
    </Await>
</template>
