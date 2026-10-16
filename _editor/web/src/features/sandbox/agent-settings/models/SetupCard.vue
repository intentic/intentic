<script setup lang="ts">
import { MODEL_ROLES, type ModelRole, type ModelRoleSpec } from "@intentic/sandbox-contract/models/model-roles";
import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import { type ActionItem, InlineRename, OverflowActions, StatusBadge } from "@intentic/ui";
import { computed, onMounted, useTemplateRef, watch } from "vue";
import AddModelButton from "./AddModelButton.vue";
import JobChip from "./JobChip.vue";
import { type PinnedList, pinKnobSummary, pinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";
import type { SetupView } from "./modelSetups";
import { setupName } from "./roleWords";
import { useT } from "@intentic/ui/i18n";

// One setup: its name, the models it runs on in try order, and the jobs put on it. The jobs area is where a dragged job
// is dropped; each chip in it is pressed for the job's own panel. A preset still worked out from what is connected says
// so, and editing its list is what makes it a written one.

const t = useT();

const {
    setup,
    disabled,
    loaded,
    dropping,
    over,
    activeJob,
    renameOnMount = false,
} = defineProps<{
    setup: SetupView;
    /** Inert while the settings have not been read. */
    disabled: boolean;
    // Whether settings have landed; the empty-list line claims what these jobs will do, so it can't draw before that.
    loaded: boolean;
    /** A job is being dragged: the jobs area reads as somewhere to drop it. */
    dropping: boolean;
    /** The dragged job is over this setup. */
    over: boolean;
    activeJob: ModelRole | undefined;
    /** A setup just made opens with its name ready to type. */
    renameOnMount?: boolean;
}>();

const emit = defineEmits<{
    write: [readonly ModelPin[]];
    open: [PinnedList, number | undefined, HTMLElement];
    rename: [string];
    suggested: [];
    remove: [];
    job: [ModelRole, HTMLElement];
    grab: [PointerEvent, ModelRole, HTMLElement];
}>();

const SPECS = new Map<ModelRole, ModelRoleSpec>(MODEL_ROLES.map((role) => [role.id, role]));
const kindOf = (role: ModelRole): string => SPECS.get(role)?.kind ?? `run`;

const name = computed(() => setupName(setup));

// Built here, over this setup's own list: the page's one picker hangs off whichever setup asked, with this editor in hand.
const list = pinnedList({
    read: () => setup.pins,
    write: (pins) => emit(`write`, pins),
    decode: (pin) => pin,
    encode: (pin) => pin,
    detail: pinKnobSummary,
    knobs: true,
    // A model that cannot run a turn may sit only on a setup that feeds nothing but one-shot jobs.
    helperJobs: setup.roles.length > 0 && setup.roles.every((role) => kindOf(role) === `helper`),
});

// An empty list says what it means for the jobs on it, which differs per kind of job: a one-shot does not run, a whole
// session opens on the chat's own model. A preset with nothing to suggest says how it fills instead.
const emptyNote = computed<string | undefined>(() => {
    if (!loaded || setup.pins.length > 0) {
        return undefined;
    }
    if (setup.derived) {
        return t(`sandbox.agentModels.nothingToSuggest`);
    }
    if (setup.roles.length === 0) {
        return t(`sandbox.agentModels.addModelsThenJobs`);
    }
    const kinds = new Set(setup.roles.map(kindOf));
    if (kinds.size > 1) {
        return t(`sandbox.agentModels.emptyMixed`);
    }
    return kinds.has(`helper`) ? t(`sandbox.agentModels.emptyHelpers`) : t(`sandbox.agentModels.emptyRuns`);
});

/* RENAMING, in place, with the app's one rename (<InlineRename>): the same pencil and field as the sandbox's own name. */

const nameField = useTemplateRef<InstanceType<typeof InlineRename>>(`nameField`);
const startRename = (): void => nameField.value?.begin();
// Renaming is the name's own pencil only, never also an action here, so a card never wears two.
// The page writes and redraws; the field closes on the name it was given.
const writeName = async (next: string): Promise<void> => {
    emit(`rename`, next);
};
// On mount rather than an immediate watch, which runs before the field exists; the watch catches a later ask.
onMounted(() => {
    if (renameOnMount) {
        startRename();
    }
});
watch(
    () => renameOnMount,
    (now) => {
        if (now) {
            startRename();
        }
    },
);

const actions = computed<readonly ActionItem[]>(() => [
    ...(setup.preset !== undefined && !setup.derived
        ? [{ id: `suggested`, icon: `sparkles`, label: t(`sandbox.agentModels.useSuggested`), note: t(`sandbox.agentModels.useSuggestedNote`), disabled, run: () => emit(`suggested`) } satisfies ActionItem]
        : []),
    ...(setup.preset === undefined
        ? [{ id: `remove`, icon: `trash`, label: t(`sandbox.agentModels.deleteSetup`), note: t(`sandbox.agentModels.deleteNote`), danger: true, disabled, run: () => emit(`remove`) } satisfies ActionItem]
        : []),
]);

const zoneLabel = computed(() => t(`sandbox.agentModels.jobsOn`, { name: name.value }));
</script>

<template>
    <section class="flex flex-col gap-3 rounded-xl bg-card p-3 shadow-sm" :aria-label="name">
        <header class="flex min-h-7 items-center gap-2">
            <h3 class="flex min-w-0 text-sm font-medium text-content">
                <InlineRename
                    ref="nameField"
                    :value="name"
                    :write="writeName"
                    :label="t(`sandbox.agentModels.setupName`)"
                    :action="t(`sandbox.agentModels.rename`)"
                    :editable="!disabled"
                    :maxlength="40"
                />
            </h3>
            <span v-if="setup.preset !== undefined && setup.name !== undefined" class="truncate text-2xs text-subtle">{{
                t(`sandbox.agentModels.presetWas`, { preset: setupName({ preset: setup.preset, name: undefined }) })
            }}</span>
            <StatusBadge
                v-if="setup.derived && setup.pins.length > 0"
                size="xs"
                variant="info"
                :label="t(`sandbox.agentModels.suggested`)"
                v-tooltip.top="{ title: t(`sandbox.agentModels.suggested`), note: t(`sandbox.agentModels.suggestedNote`) }"
            />
            <div class="ml-auto flex shrink-0 items-center gap-1">
                <AddModelButton
                    :label="t(`sandbox.agentModels.addModelTo`, { name })"
                    :disabled="disabled"
                    @open="(anchor: HTMLElement) => emit(`open`, list, undefined, anchor)"
                />
                <OverflowActions :actions="actions" :header="name" />
            </div>
        </header>

        <ModelPinList
            v-if="setup.pins.length > 0"
            :entries="list.entries.value"
            :note-thinking="list.helperJobs"
            @promote="list.promote"
            @remove="list.remove"
            @edit="(index: number, anchor: HTMLElement) => emit(`open`, list, index, anchor)"
        />
        <p v-else-if="emptyNote !== undefined" class="text-2xs text-subtle">{{ emptyNote }}</p>

        <!-- The drop zone: the jobs on this setup, and where a dragged one lands. Outlined only while a job is in flight,
             so at rest it reads as the card's own content rather than a box waiting for something. -->
        <div
            :data-setup-drop="setup.id"
            class="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-dashed p-2 transition-colors"
            :class="over ? `border-link bg-link/10` : dropping ? `border-line` : `border-transparent bg-canvas/60`"
        >
            <ul v-if="setup.roles.length > 0" class="contents" :aria-label="zoneLabel">
                <li v-for="role in setup.roles" :id="`model-job-${role}`" :key="role">
                    <JobChip
                        :role="role"
                        :disabled="disabled"
                        :active="activeJob === role"
                        @grab="(event: PointerEvent, chip: HTMLElement) => emit(`grab`, event, role, chip)"
                        @open="(chip: HTMLElement) => emit(`job`, role, chip)"
                    />
                </li>
            </ul>
            <span v-else class="px-1 text-2xs text-subtle">{{ t(`sandbox.agentModels.dropJobsHere`) }}</span>
        </div>
    </section>
</template>
