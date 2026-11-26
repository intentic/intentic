<!-- CHANGING ONE CLOUD SANDBOX'S PLAN (2026-11-26): the one dialog for it, opened from the sandbox's Plan card, a Billing
     row, Billing's plan-on-no-sandbox prompt and the out-of-hours screen. The plans as a radio list (the one it is on,
     the one a change waiting moves it to, Free held by another sandbox and why), then what the pick changes (memory, disk,
     hours, whether it is kept), that an upgrade restarts it once, the one sentence about money, and one button whose words
     say the act ("Upgrade test-chmura · $20/month", "Continue to payment", "Switch to Free on Dec 26", "Keep Standard").
     An account with nothing paid yet goes to Stripe's page for this sandbox; everyone else's press is the platform's
     `changePlan`, whose refusal is said here, at the press. The restart itself is drawn where the plan is read. -->
<script setup lang="ts">
import { Button, Modal, Notice, toneFill } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useId, watch } from "vue";
import { formatDayShort } from "../../../models/hosted-plan/hostedHours";
import { planMove } from "../../../models/hosted-plan/planMoves";
import { useHostedPlan } from "../../../models/hosted-plan/useHostedPlan";
import { apiClient } from "../../../lib/useApi";
import { useOperation } from "../../../workbench/operations/operations";
import { freeRefusal, openingTier, planDiff, planOffer } from "./planChange";
import PlanChoice from "./PlanChoice.vue";
import { planLadder, rungOf } from "./planLadder";
import { useStripeErrand } from "./useStripeErrand";

const { sandboxId, initial = undefined } = defineProps<{
    sandboxId: string;
    /** The plan to open on, where the press that opened it was about one ("Upgrade to Standard", "Keep Max"). */
    initial?: string | undefined;
}>();
const open = defineModel<boolean>("open", { required: true });

const t = useT();
const { state, changePlan } = useHostedPlan();
const ladder = computed(() => planLadder(state.value));
const machine = computed(() => state.value?.hosted?.machines.find((row) => row.sandboxId === sandboxId));
const now = computed(() => (open.value ? Date.now() : 0));

// The pick, set each time the dialog opens: the plan the press was about, else the next one up.
const pick = ref(``);
watch(
    open,
    (shown) => {
        const box = machine.value;
        if (shown && box !== undefined) {
            pick.value = initial ?? openingTier({ ladder: ladder.value, machine: box, now: Date.now() });
        }
    },
    { immediate: true },
);

const current = computed(() => (machine.value === undefined ? undefined : rungOf(ladder.value, machine.value.tier)));
const target = computed(() => rungOf(ladder.value, pick.value));
const offer = computed(() =>
    machine.value === undefined ? undefined : planOffer({ state: state.value, ladder: ladder.value, machine: machine.value, now: now.value }, target.value),
);
const move = computed(() => (machine.value === undefined ? undefined : planMove(machine.value, now.value)));
const scheduled = computed(() =>
    move.value?.kind === `scheduled` ? { tier: move.value.tier, when: t(`settings.plans.tagFrom`, { date: formatDayShort(move.value.at) }) } : undefined,
);
const refused = computed(() => {
    const why = freeRefusal(state.value, ladder.value, sandboxId);
    const free = ladder.value.find((rung) => rung.free);
    return why === undefined || free === undefined || current.value?.free === true ? {} : { [free.id]: why };
});
// What the pick changes, fact by fact; nothing for the plan it is on.
const diff = computed(() =>
    machine.value === undefined || current.value === undefined || target.value.id === current.value.id ? [] : planDiff(machine.value, current.value, target.value),
);
const pressable = computed(() => offer.value !== undefined && offer.value.act !== `current` && offer.value.act !== `blocked`);

// One change at a time per sandbox, kept past the dialog in the ledger: its failure is said here when the dialog is.
const change = useOperation<unknown>(() => `account/billing/plan/${sandboxId}`);
const errand = useStripeErrand();
const busy = computed(() => change.busy.value || errand.working.value);
const failure = computed(() => change.failure.value ?? errand.failure.value);

const confirm = async (): Promise<void> => {
    const shown = offer.value;
    const box = machine.value;
    if (shown === undefined || box === undefined || !pressable.value || busy.value) {
        return;
    }
    if (shown.act === `checkout`) {
        if (await errand.open(`checkout`, () => apiClient.hostedPlan.checkout({ tier: shown.tier, sandboxId }))) {
            open.value = false;
        }
        return;
    }
    change.dismiss();
    const run = await change.run({
        what: t(`settings.plans.changing`, { name: box.name }),
        failed: t(`settings.plans.couldntChange`),
        quiet: true,
        task: () => changePlan(sandboxId, shown.tier),
    });
    if (run?.state === `done`) {
        open.value = false;
    }
};

const choiceId = useId();
</script>

<template>
    <Modal v-model:open="open" size="md" :header="machine ? t(`settings.plans.dialogTitle`, { name: machine.name }) : ``" :dismissable="!busy" data-plan-dialog>
        <div v-if="machine && current && offer" class="flex flex-col gap-4">
            <span :id="choiceId" class="sr-only">{{ t(`settings.plans.choiceLabel`) }}</span>
            <PlanChoice v-model="pick" :rungs="ladder" :current="current.id" :scheduled="scheduled" :refused="refused" :labelled-by="choiceId" />

            <dl v-if="diff.length > 0" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-line-subtle pt-4 text-xs" data-plan-diff>
                <template v-for="row in diff" :key="row.label">
                    <dt class="text-muted">{{ row.label }}</dt>
                    <dd class="text-content">
                        {{ row.from }} → <span :class="row.more ? `font-medium text-success` : ``">{{ row.to }}</span>
                    </dd>
                </template>
            </dl>

            <p v-if="offer.restarts" class="rounded-lg px-3 py-2 text-xs text-content" :class="toneFill(`info`, `strong`)">
                {{ t(`settings.plans.restartNote`, { name: machine.name }) }}
            </p>
            <p v-if="offer.price" class="text-xs text-muted" data-plan-price>{{ offer.price }}</p>

            <Notice v-if="failure" :of="failure" />
        </div>

        <template #footer>
            <div class="flex w-full flex-wrap items-center justify-end gap-2">
                <Button :label="t(`ui.action.cancel`)" tier="quiet" :disabled="busy" @click="open = false" />
                <Button
                    :label="offer?.label ?? ``"
                    :tier="offer?.paid ? `loud` : `accent`"
                    :loading="busy"
                    :disabled="!pressable"
                    data-plan-confirm
                    @click="confirm"
                />
            </div>
        </template>
    </Modal>
</template>
