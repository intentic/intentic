<script setup lang="ts">
import { Await } from "@intentic/ui";
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
    <Await :of="settingsRead">
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
