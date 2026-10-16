<script setup lang="ts">
import { MODEL_ROLES, type ModelPin, type ModelRole, suggestedSetup } from "@intentic/sandbox-contract";
import { Button, ui } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { modelLabelFor } from "../../../chat/accounts/providerCatalog";
import { pinKnobSummary } from "./modelPinList";
import type { SetupsView } from "./modelSetups";
import { roleBlurb, roleLabel, setupName } from "./roleWords";
import type { DropTarget } from "./useJobDrag";
import { useT } from "@intentic/ui/i18n";

// One job, opened from its chip: what it does, and which setup it runs on, as a choice between every setup on the page,
// a new one, or none (back to the list of jobs that run on nothing). The same move a drag makes, for a phone, a keyboard, or anyone who would rather pick from a list.
// Picking one is the whole gesture, so the panel shuts on it.

const t = useT();

const { role, view, judgeOff, guidanceSet } = defineProps<{
    role: ModelRole;
    view: SetupsView;
    /** The safety judge is switched off under Safety, so its setup is not in use. */
    judgeOff: boolean;
    /** The router has written guidance, which it reads beside its models. */
    guidanceSet: boolean;
}>();

const emit = defineEmits<{ move: [DropTarget]; guidance: [] }>();

const kind = computed(() => MODEL_ROLES.find((spec) => spec.id === role)?.kind ?? `run`);

// A setup is told apart by its first model and how it is run; the rest is a count, since the page beside this panel
// shows them all.
const modelsOf = (pins: readonly ModelPin[]): string => {
    const [first] = pins;
    if (first === undefined) {
        return t(`sandbox.agentModels.noModelsYet`);
    }
    const knobs = pinKnobSummary(first);
    const named = knobs === undefined ? modelLabelFor(first.provider, first.model) : `${modelLabelFor(first.provider, first.model)} · ${knobs}`;
    return pins.length > 1 ? t(`sandbox.agentModels.thenMore`, { first: named, count: pins.length - 1 }, pins.length - 1) : named;
};

interface Choice {
    readonly key: string;
    readonly label: string;
    readonly detail: string;
    readonly target: DropTarget;
    readonly on: boolean;
}

const choices = computed<readonly Choice[]>(() => [
    ...view.setups.map<Choice>((setup) => ({
        key: setup.id,
        // The preset suggested for this job says so, which is what a reader placing it for the first time looks for.
        label: setup.id === suggestedSetup(role) ? t(`sandbox.agentModels.suggestedFor`, { name: setupName(setup) }) : setupName(setup),
        detail: modelsOf(setup.pins),
        target: { kind: `setup`, id: setup.id },
        on: setup.roles.includes(role),
    })),
    {
        key: `unassigned`,
        label: t(`sandbox.agentModels.notAssigned`),
        detail: kind.value === `helper` ? t(`sandbox.agentModels.doesntRun`) : t(`sandbox.agentModels.chatModel`),
        target: { kind: `unassigned` },
        on: view.unassigned.includes(role),
    },
    {
        key: `new`,
        label: t(`sandbox.agentModels.newSetup`),
        // A job on none has nothing to copy, so its new setup starts as empty as the one it leaves.
        detail: view.unassigned.includes(role) ? t(`sandbox.agentModels.startsEmpty`) : t(`sandbox.agentModels.copyOfNow`),
        target: { kind: `new` },
        on: false,
    },
]);
</script>

<template>
    <div class="flex flex-col gap-3 p-3">
        <div class="flex flex-col gap-0.5">
            <p class="text-sm font-medium text-content">{{ roleLabel({ id: role }) }}</p>
            <p class="text-2xs text-muted">{{ roleBlurb({ id: role }) }}</p>
        </div>

        <!-- The judge reads untrusted text, and can be switched off elsewhere: both are said where its setup is picked. -->
        <p v-if="role === `safety-judge` && judgeOff" class="text-2xs text-subtle">
            {{ t(`sandbox.agentModels.nothingJudgingCommandsAt`) }}
            <RouterLink :to="{ name: `sandbox`, params: { tab: `guardrails` } }" class="text-link hover:underline">{{
                t(`sandbox.agentModels.turnJudgeOn`)
            }}</RouterLink>
            {{ t(`sandbox.agentModels.inGuardrails`) }}
        </p>
        <p v-else-if="role === `safety-judge`" class="text-2xs text-subtle">{{ t(`sandbox.words.worthBetterModelThan`) }}</p>

        <!-- The router is the one job with a second setting: what it should weigh, in the owner's words. -->
        <div v-if="role === `model-router`" class="flex items-center gap-2">
            <Button size="small" :tier="guidanceSet ? `boring` : `quiet`" :label="t(`sandbox.agentModels.guidance`)" @click="emit(`guidance`)" />
            <span v-if="guidanceSet" class="text-2xs text-subtle">{{ t(`sandbox.agentModels.autoReadsIt`) }}</span>
        </div>

        <div role="radiogroup" :aria-label="t(`sandbox.agentModels.runsOn`)" class="flex flex-col gap-1">
            <p :class="ui.sectionLabel({ size: `xs` })" aria-hidden="true">{{ t(`sandbox.agentModels.runsOn`) }}</p>
            <button
                v-for="choice in choices"
                :key="choice.key"
                type="button"
                role="radio"
                :aria-checked="choice.on"
                class="flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-overlay"
                :class="choice.on && `bg-overlay`"
                @click="choice.on ? undefined : emit(`move`, choice.target)"
            >
                <Icon
                    :name="choice.key === `new` ? `plus` : choice.on ? `check-circle` : `circle`"
                    class="mt-0.5 shrink-0 text-xs"
                    :class="choice.on ? `text-link` : `text-subtle`"
                />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-xs text-content">{{ choice.label }}</span>
                    <span class="truncate text-2xs text-subtle">{{ choice.detail }}</span>
                </span>
            </button>
        </div>
    </div>
</template>
