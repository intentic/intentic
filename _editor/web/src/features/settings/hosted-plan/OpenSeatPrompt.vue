<!-- A PAID PLAN NO SANDBOX IS ON: billed every month for nothing, so Billing asks where it goes. One of the owner's cloud
     sandboxes on a smaller plan (it moves up onto the plan already paid for, restarting once, with nothing more charged),
     a new sandbox made on it, or ending it on the renewal date. Most such plans are slots bought before plans belonged to
     sandboxes (2026-11-26), or the plan of a sandbox deleted before its month ran out. -->
<script setup lang="ts">
import type { HostedPlanMachine } from "@intentic/api-contract";
import { Button, Notice, toneFill } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useId } from "vue";
import { useRouter } from "vue-router";
import { formatDayShort, rungName } from "../../../models/hosted-plan/hostedHours";
import { isUpgrade } from "../../../models/hosted-plan/planMoves";
import { useHostedPlan } from "../../../models/hosted-plan/useHostedPlan";
import { newSandboxLink } from "../../../models/sandbox/addSandbox";
import { useOperation } from "../../../workbench/operations/operations";
import type { Rung } from "./planLadder";

const { rung, count, machines, renewsAt = undefined } = defineProps<{
    rung: Rung;
    /** How many plans at this rung wait for a sandbox. */
    count: number;
    /** The owner's cloud sandboxes, of which those on a smaller plan are offered. */
    machines: readonly HostedPlanMachine[];
    renewsAt?: string | undefined;
}>();

const t = useT();
const router = useRouter();
const { changePlan, release } = useHostedPlan();

// A sandbox already on this plan or a bigger one gains nothing from it.
const NEW = `new`;
const candidates = computed(() => machines.filter((machine) => isUpgrade(machine.tier, rung.id) && machine.change === undefined));
const pick = ref<string>(candidates.value[0]?.sandboxId ?? NEW);
const options = computed(() => [
    ...candidates.value.map((machine) => ({ id: machine.sandboxId, name: machine.name, note: t(`settings.plans.seat.onNow`, { name: rungName(machine.tier) }) })),
    { id: NEW, name: t(`settings.plans.seat.newSandbox`), note: undefined },
]);
const picked = computed(() => candidates.value.find((machine) => machine.sandboxId === pick.value));
const date = computed(() => (renewsAt === undefined ? undefined : formatDayShort(renewsAt)));

const work = useOperation<unknown>(() => `account/billing/seat/${rung.id}`);
const put = async (): Promise<void> => {
    const machine = picked.value;
    if (machine === undefined) {
        await router.push(newSandboxLink(`hosted`, rung.id));
        return;
    }
    work.dismiss();
    await work.run({ what: t(`settings.plans.seat.putting`, { name: machine.name }), failed: t(`settings.plans.couldntChange`), quiet: true, task: () => changePlan(machine.sandboxId, rung.id) });
};
const end = async (): Promise<void> => {
    work.dismiss();
    await work.run({ what: t(`settings.plans.seat.ending`, { name: rung.name }), failed: t(`settings.plans.couldntChange`), quiet: true, task: () => release(rung.id) });
};
const listId = useId();
</script>

<template>
    <div class="flex flex-col gap-3" data-open-seat>
        <p class="rounded-lg px-3 py-2 text-xs text-content" :class="toneFill(`warning`, `strong`)">
            <span class="font-medium">{{ t(`settings.plans.seat.title`, { name: rung.name, count }, count) }}</span>
            {{ t(`settings.plans.seat.detail`, { price: rung.priceUsd }) }}
        </p>
        <div :id="listId" role="radiogroup" :aria-label="t(`settings.plans.seat.where`)" class="-mx-2.5 grid grid-cols-1 gap-0.5">
            <button
                v-for="option in options"
                :key="option.id"
                type="button"
                role="radio"
                :aria-checked="pick === option.id"
                :tabindex="pick === option.id ? 0 : -1"
                class="ui-row-select flex w-full min-w-0 items-start gap-3 rounded-lg px-2.5 py-2 text-left"
                :class="{ 'ui-row-select-on': pick === option.id }"
                @click="pick = option.id"
            >
                <Icon :name="pick === option.id ? `check-circle` : `circle`" class="shrink-0 text-sm" :class="pick === option.id ? `text-accent` : `text-subtle`" />
                <span class="flex min-w-0 flex-col">
                    <span class="text-sm font-medium text-content">{{ option.name }}</span>
                    <span v-if="option.note" class="text-xs text-muted">{{ option.note }}</span>
                </span>
            </button>
        </div>
        <Notice v-if="work.failure.value" :of="work.failure.value" />
        <div class="flex flex-wrap items-center justify-end gap-2">
            <Button
                size="small"
                tier="quiet"
                :label="date ? t(`settings.plans.seat.endOn`, { date }) : t(`settings.plans.seat.endAtRenewal`)"
                :disabled="work.busy.value"
                @click="end"
            />
            <Button
                size="small"
                tier="accent"
                :label="picked ? t(`settings.plans.seat.putOn`, { name: picked.name }) : t(`settings.plans.seat.makeNew`)"
                :loading="work.busy.value"
                data-open-seat-put
                @click="put"
            />
        </div>
    </div>
</template>
