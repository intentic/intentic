<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import SandboxPlanCard from "../../settings/hosted-plan/SandboxPlanCard.vue";
import { useHostedPlan } from "../../../models/hosted-plan/useHostedPlan";
import { useSandbox } from "../../../client/sandbox/useSandbox";

// WHETHER THIS SANDBOX'S AWAKE TIME COSTS HOURS, answered on the page about what the sandbox uses. A limit belongs
// beside the thing it limits: shown only at account level, it reads as a limit on every sandbox, and one on the
// owner's own computer spends none. So a sandbox on its owner's computer says it is never metered, a hosted one shows its
// owner its plan and the hours that plan gives it (the Plan card, as on Overview), and a guest on a hosted one is told
// whose hours those are. Nothing at all where the platform hosts nothing, since there is nothing metered to speak of.

const t = useT();
const { active } = useSandbox();
const { state: plan } = useHostedPlan();

// The platform runs machines at all: its plan state carries a hosted half only where it does.
const lane = computed(() => plan.value?.hosted !== undefined);
const onOurMachine = computed(() => (active.value?.hosted ?? null) !== null);
const owner = computed(() => active.value?.tier === `owner`);
const machine = computed(() => plan.value?.hosted?.machines.find((row) => row.sandboxId === active.value?.id));
</script>

<template>
    <template v-if="lane">
        <!-- On the owner's own computer: the question a limit anywhere else raises, answered where it is asked. Drawn
             like the charges banner above it, since it is the same kind of statement: what intentic never counts. -->
        <div v-if="!onOurMachine" class="flex items-center gap-3 rounded-xl bg-card shadow-sm px-4 py-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-content/5 text-muted" aria-hidden="true">
                <Icon name="desktop" class="text-xl" />
            </span>
            <div class="min-w-0">
                <p class="text-xs font-medium leading-relaxed text-content">{{ t(`sandbox.sandboxHours.ownComputer`) }}</p>
                <p class="mt-0.5 text-xs leading-relaxed text-muted">{{ t(`sandbox.sandboxHours.ownComputerNeverMetered`) }}</p>
            </div>
        </div>

        <!-- Hosted, read by its owner: its plan, whose hours these are (SandboxPlanCard.vue, the Overview's card too). -->
        <SandboxPlanCard v-else-if="owner && machine && active" :sandbox-id="active.id" />

        <!-- Hosted, read by a guest: the hours are the owner's to spend and to buy, never the reader's. -->
        <div v-else-if="!owner" class="flex items-center gap-3 rounded-xl bg-card shadow-sm px-4 py-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-content/5 text-muted" aria-hidden="true">
                <Icon name="server" class="text-xl" />
            </span>
            <div class="min-w-0">
                <p class="text-xs font-medium leading-relaxed text-content">{{ t(`sandbox.sandboxHours.hostedForOwner`) }}</p>
                <p class="mt-0.5 text-xs leading-relaxed text-muted">{{ t(`sandbox.sandboxHours.ownersHours`) }}</p>
            </div>
        </div>
    </template>
</template>
