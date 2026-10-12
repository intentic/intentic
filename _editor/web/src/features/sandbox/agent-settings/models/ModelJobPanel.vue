<script setup lang="ts">
import { MODEL_ROLES, type ModelPin, type ModelRole } from "@intentic/sandbox-contract";
import { Button, ui } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { modelLabelFor } from "../../../chat/accounts/providerCatalog";
import { pinKnobSummary } from "./modelPinList";
import type { JobTarget, ModelPath } from "./modelPaths";
import { roleBlurb, roleLabel } from "./roleWords";
import { useT } from "@intentic/ui/i18n";

// One job, opened from its chip: what it does, and which list it runs on, as a choice between every list on the page,
// a list of its own, or none. Picking one is the whole gesture, so the panel shuts on it.

const t = useT();

const { role, paths, judgeOff, guidanceSet } = defineProps<{
    role: ModelRole;
    paths: readonly ModelPath[];
    /** The safety judge is switched off under Safety, so its list is not in use. */
    judgeOff: boolean;
    /** The router has written guidance, which it reads beside its list. */
    guidanceSet: boolean;
}>();

const emit = defineEmits<{ move: [JobTarget]; guidance: [] }>();

const kind = computed(() => MODEL_ROLES.find((spec) => spec.id === role)?.kind ?? `run`);
const current = computed(() => paths.find((path) => path.roles.includes(role)));
const alone = computed(() => current.value !== undefined && !current.value.isDefault && current.value.roles.length === 1);

// A list is named by its first model and how it is run, which is what tells two lists of the same models apart; the
// rest is a count, since the page beside this panel shows them all.
const modelsOf = (pins: readonly ModelPin[]): string => {
    const [first] = pins;
    if (first === undefined) {
        return t(`sandbox.agentModels.noModels`);
    }
    const knobs = pinKnobSummary(first);
    const named = knobs === undefined ? modelLabelFor(first.provider, first.model) : `${modelLabelFor(first.provider, first.model)} · ${knobs}`;
    return pins.length > 1 ? t(`sandbox.agentModels.thenMore`, { first: named, count: pins.length - 1 }, pins.length - 1) : named;
};

// The other jobs on a list, which is how the page shows it: two names and a count.
const withJobs = (roles: readonly ModelRole[]): string => {
    const others = roles.filter((held) => held !== role);
    const named = others.slice(0, 2).map((held) => roleLabel({ id: held }));
    const rest = others.length - named.length;
    return rest > 0 ? t(`sandbox.agentModels.withMore`, { jobs: named.join(`, `), count: rest }, rest) : t(`sandbox.agentModels.with`, { jobs: named.join(`, `) });
};

interface Choice {
    readonly key: string;
    readonly label: string;
    readonly detail: string;
    readonly target: JobTarget;
    readonly on: boolean;
}

const emptyDetail = computed(() => (kind.value === `helper` ? t(`sandbox.agentModels.doesntRun`) : t(`sandbox.agentModels.chatModel`)));

// An empty list other than the default is drawn as "No models" rather than by its jobs: that is what it is, and choosing
// no models joins it (modelPaths.moveJob), so listing both would name one place twice.
const isEmptyRow = (path: ModelPath): boolean => !path.isDefault && path.pins.length === 0;

const choices = computed<readonly Choice[]>(() => {
    const lists = paths
        .filter((path) => !isEmptyRow(path))
        // A list nobody else is on is "its own models" while it is this job's, and not somewhere to go otherwise.
        .filter((path) => path.isDefault || path === current.value || path.roles.length > 0)
        .map<Choice>((path) => {
            const on = path === current.value;
            const label = path.isDefault ? t(`sandbox.agentModels.defaultModels`) : on && alone.value ? t(`sandbox.agentModels.ownModels`) : withJobs(path.roles);
            return { key: path.id, label, detail: modelsOf(path.pins), target: path.isDefault ? { kind: `default` } : { kind: `path`, id: path.id }, on };
        });
    // Not while it already has a list of its own, nor while it has none: a copy of nothing is "No models" again.
    const own: Choice[] =
        current.value === undefined || isEmptyRow(current.value) || alone.value
            ? []
            : [{ key: `own`, label: t(`sandbox.agentModels.ownModels`), detail: t(`sandbox.agentModels.copyOfNow`), target: { kind: `own` }, on: false }];
    const none: Choice = {
        key: `none`,
        label: t(`sandbox.agentModels.noModels`),
        detail: emptyDetail.value,
        target: { kind: `none` },
        on: current.value !== undefined && isEmptyRow(current.value),
    };
    return [...lists, ...own, none];
});
</script>

<template>
    <div class="flex flex-col gap-3 p-3">
        <div class="flex flex-col gap-0.5">
            <p class="text-sm font-medium text-content">{{ roleLabel({ id: role }) }}</p>
            <p class="text-2xs text-muted">{{ roleBlurb({ id: role }) }}</p>
        </div>

        <!-- The judge reads untrusted text, and can be switched off elsewhere: both are said where its model is picked. -->
        <p v-if="role === `safety-judge` && judgeOff" class="text-2xs text-subtle">
            {{ t(`sandbox.agentModels.nothingJudgingCommandsAt`) }}
            <RouterLink :to="{ name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } }" class="text-link hover:underline">{{
                t(`sandbox.agentModels.turnJudgeOn`)
            }}</RouterLink>
            {{ t(`sandbox.agentModels.underSafety`) }}
        </p>
        <p v-else-if="role === `safety-judge`" class="text-2xs text-subtle">{{ t(`sandbox.words.worthBetterModelThan`) }}</p>

        <!-- The router is the one job with a second setting: what it should weigh, in the owner's words. -->
        <div v-if="role === `model-router`" class="flex items-center gap-2">
            <Button size="small" :tier="guidanceSet ? `boring` : `quiet`" :label="t(`sandbox.agentModels.guidance`)" @click="emit(`guidance`)" />
            <span v-if="guidanceSet" class="text-2xs text-subtle">{{ t(`sandbox.agentModels.autoReadsIt`) }}</span>
        </div>

        <div role="radiogroup" :aria-label="t(`sandbox.agentModels.runsOn`)" class="flex flex-col gap-1">
            <p :class="ui.sectionLabel()" aria-hidden="true">{{ t(`sandbox.agentModels.runsOn`) }}</p>
            <button
                v-for="choice in choices"
                :key="choice.key"
                type="button"
                role="radio"
                :aria-checked="choice.on"
                class="ui-row-select flex items-start gap-2 rounded-md px-2 py-1.5 text-left"
                :class="choice.on && `ui-row-select-on`"
                @click="choice.on ? undefined : emit(`move`, choice.target)"
            >
                <Icon :name="choice.on ? `check-circle` : `circle`" class="mt-0.5 shrink-0 text-xs" :class="choice.on ? `text-link` : `text-subtle`" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-xs text-content">{{ choice.label }}</span>
                    <span class="truncate text-2xs text-subtle">{{ choice.detail }}</span>
                </span>
            </button>
        </div>
    </div>
</template>
