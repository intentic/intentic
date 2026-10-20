<script setup lang="ts">
import { AUTO_MODEL_GUIDANCE_MAX } from "@intentic/sandbox-contract/schemas/settings";
import { MODEL_ROLE_IDS, type ModelRole } from "@intentic/sandbox-contract/models/model-roles";
import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { SetupSettings } from "@intentic/sandbox-contract/models/model-setups";
import { Button, MarkdownDocument, Modal, Notice, ResponsiveOverlay, RowGroup, Section } from "@intentic/ui";
import { computed, nextTick, provide, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useTrimmedDraft } from "../../../../lib/useDraft";
import { readConnectedCatalogs, roleSources } from "../../../../models/providers/roleModel";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import JobChip from "./JobChip.vue";
import { JOB_STATE, type JobNote } from "./jobState";
import type { PinnedList } from "./modelPinList";
import {
    type SetupsView,
    type SetupsWrite,
    setupsView,
    withJobOn,
    withJobOnNewSetup,
    withNewSetup,
    withoutSetup,
    withSetupName,
    withSetupPins,
    withSuggestedModels,
    withSuggestedPlaces,
} from "./modelSetups";
import ModelJobPanel from "./ModelJobPanel.vue";
import ModelPinPicker from "./ModelPinPicker.vue";
import SetupCard from "./SetupCard.vue";
import { roleLabel, setupName } from "./roleWords";
import { type DropTarget, useJobDrag } from "./useJobDrag";
import { useT } from "@intentic/ui/i18n";

// Every model choice the sandbox makes: the jobs that pick a model, and the setups they run on (named, ordered lists of
// models). Low, Medium and High are always there, worked out from what is connected until edited; the owner makes any
// others. A job runs on nothing until it is put on a setup, by dragging its chip there or pressing it and picking one;
// the jobs on none wait in the list at the top, with one press to put each on the setup suggested for it. Nothing is
// stored per card: the page is read off two settings through the contract's resolver (modelSetups.ts), so it draws what
// will run.

const t = useT();

// A refused write is put back on screen by useSandboxSettings; `refusal` says why here, or the press reads as nothing.
const { settings, patch, save, refusal } = useSandboxSettings();
const loaded = computed(() => settings.value !== undefined);

// The presets are worked out from each connected provider's catalog, so the page reads them as it opens.
readConnectedCatalogs();

const stored = computed<SetupSettings>(() => ({ modelSetups: settings.value?.modelSetups ?? [], roleSetups: settings.value?.roleSetups ?? {} }));
const view = computed<SetupsView>(() => setupsView(stored.value, roleSources.value));
const write = (fields: SetupsWrite | undefined): void => {
    if (fields !== undefined) {
        patch(fields);
    }
};

// A setup is named by the page in the reader's words; its number is the id's, so two made in a row read in order.
const newName = (n: number): string => t(`sandbox.agentModels.setupN`, { n });

// The card whose name opens ready to type: the one just made from the header's button.
const justMade = ref<string | undefined>(undefined);
const makeSetup = (): void => {
    const made = withNewSetup(stored.value, newName, []);
    justMade.value = made.id;
    write(made.write);
};

/* WHAT A CHIP SAYS BESIDE ITS NAME, provided to every chip on the page. */

// The judge is the one job switchable off elsewhere; while off its chip says so, and it stays movable.
const judgeOff = computed(() => settings.value?.commandJudge === `off`);

// The one job on this page not answered by a model list alone: Auto also reads what it is told to weigh. Explicit save,
// and the schema's own cap (AUTO_MODEL_GUIDANCE_MAX), the one the daemon refuses past. Saved trimmed, so measured
// trimmed (useTrimmedDraft), or a save that landed would still read "Not saved yet".
const { draft: guidance, stored: storedGuidance } = useTrimmedDraft(() => settings.value?.autoModelGuidance);
const guidanceSet = computed(() => (storedGuidance.value ?? ``).trim() !== ``);
const saveGuidance = (text: string): void => patch({ autoModelGuidance: text.trim() });
const guidanceOpen = ref(false);

provide(JOB_STATE, {
    note: (role: ModelRole): JobNote | undefined => {
        if (role === `safety-judge` && judgeOff.value) {
            return { text: t(`sandbox.agentModels.notInUse`), dim: true };
        }
        if (role === `model-router` && guidanceSet.value) {
            return { text: t(`sandbox.agentModels.guided`), dim: false };
        }
        return undefined;
    },
});

/* MOVING A JOB: by drag, or from its panel. One write either way. */

const pinsOf = (role: ModelRole): readonly ModelPin[] => view.value.setups.find((setup) => setup.roles.includes(role))?.pins ?? [];
const move = (role: ModelRole, target: DropTarget): void => {
    if (target.kind === `new`) {
        write(withJobOnNewSetup(stored.value, role, newName, pinsOf(role)));
        return;
    }
    const id = target.kind === `unassigned` ? undefined : target.id;
    const already =
        id === undefined ? view.value.unassigned.includes(role) : view.value.setups.find((setup) => setup.id === id)?.roles.includes(role) === true;
    if (!already) {
        write(withJobOn(stored.value, role, id));
    }
};

const drag = useJobDrag(move);
const placeSuggested = (): void => write(withSuggestedPlaces(stored.value, view.value.unassigned));

const jobOpen = shallowRef<{ readonly role: ModelRole; readonly anchor: HTMLElement } | undefined>(undefined);
const openJob = (role: ModelRole, anchor: HTMLElement): void => {
    if (drag.consumeClick()) {
        return;
    }
    // A second press on the chip that opened it closes it; the overlay ignores presses on its own anchor so this can.
    jobOpen.value = jobOpen.value?.anchor === anchor ? undefined : { role, anchor };
};
const setJobOpen = (open: boolean): void => {
    if (!open) {
        jobOpen.value = undefined;
    }
};
const moveOpenJob = (target: DropTarget): void => {
    const job = jobOpen.value;
    jobOpen.value = undefined;
    if (job !== undefined) {
        move(job.role, target);
    }
};
const openGuidance = (): void => {
    jobOpen.value = undefined;
    guidanceOpen.value = true;
};

// A link naming a job (`?job=safety-judge`, Safety's "Change in Models") lands on that job: its chip is scrolled to and
// its panel opened, since the panel is where the job's setup is chosen. Read once, then dropped, so Back and a later
// visit start plainly.
const route = useRoute();
const router = useRouter();
watch(
    [loaded, () => MODEL_ROLE_IDS.find((role) => role === route.query[`job`])],
    async ([isLoaded, role]) => {
        if (!isLoaded || role === undefined) {
            return;
        }
        await nextTick();
        const chip = document.getElementById(`model-job-${role}`)?.querySelector(`button`);
        if (chip !== null && chip !== undefined) {
            chip.scrollIntoView({ block: `center` });
            jobOpen.value = { role, anchor: chip };
        }
        void router.replace({ query: { ...route.query, job: undefined } });
    },
    { immediate: true },
);

/* THE MODEL PICKER, one for the page, hung off whichever setup asked. */

interface PickerTarget {
    readonly anchor: HTMLElement;
    readonly header: string;
    readonly list: PinnedList;
    readonly index: number | undefined;
}
const editing = shallowRef<PickerTarget | undefined>(undefined);
const editingPin = computed<ModelPin | undefined>(() =>
    editing.value?.index === undefined ? undefined : editing.value.list.entries.value[editing.value.index]?.pin,
);
// While adding: the list's first model, which the picker ticks as what these jobs run on now.
const editingCurrent = computed<ModelPin | undefined>(() =>
    editing.value === undefined || editing.value.index !== undefined ? undefined : editing.value.list.entries.value[0]?.pin,
);

// Adding to a list that already has a model adds a fallback, tried only when the ones above it cannot answer; the
// header says so, since the list otherwise reads as a set rather than an order.
const openPicker = (list: PinnedList, index: number | undefined, anchor: HTMLElement): void => {
    if (editing.value?.anchor === anchor) {
        editing.value = undefined;
        return;
    }
    const header =
        index !== undefined
            ? t(`shared.model`)
            : list.entries.value.length > 0
              ? t(`sandbox.agentModels.addFallback`)
              : t(`sandbox.modelPinPicker.addModel`);
    editing.value = { anchor, header, list, index };
};
const setPickerOpen = (open: boolean): void => {
    if (!open) {
        editing.value = undefined;
    }
};
const pick = (pin: ModelPin): void => editing.value?.list.apply(editing.value.index, pin);
// A knob changes the entry being edited; while adding there is no entry yet to configure.
const configure = (pin: ModelPin): void => {
    if (editing.value?.index !== undefined) {
        editing.value.list.apply(editing.value.index, pin);
    }
};

const cardProps = computed(() => ({ disabled: !loaded.value, loaded: loaded.value, dropping: drag.dragging.value, activeJob: jobOpen.value?.role }));
const draggedName = computed(() => (drag.dragged.value === undefined ? `` : roleLabel({ id: drag.dragged.value })));
</script>

<template>
    <!-- `id` so a chat's "Turn it off everywhere" link can land here directly, not at the top of a long settings page. -->
    <div id="models" class="flex flex-col gap-4">
        <!-- The jobs on no setup: where a fresh sandbox's jobs all start, since nothing runs a job nobody placed. Shown while
             it holds any, and while a job is in flight as the place to take one off its setup. -->
        <!-- Not a <RowGroup>: what sits under these headings are cards and a drop zone, not rows on one surface. What a
             section is for is its first line, under the header, never words beside it. -->
        <Section v-if="view.unassigned.length > 0 || drag.dragging.value" :label="t(`sandbox.agentModels.notAssigned`)" :heading="2">
            <template v-if="view.unassigned.length > 0" #actions>
                <Button
                    size="small"
                    tier="boring"
                    icon="sparkles"
                    :label="t(`sandbox.agentModels.placeSuggested`)"
                    :disabled="!loaded"
                    @click="placeSuggested"
                />
            </template>
            <p class="mb-2.5 text-2xs text-subtle">{{ t(`sandbox.agentModels.notAssignedCaption`) }}</p>
            <div
                data-setup-drop="unassigned"
                class="flex min-h-12 flex-wrap items-center gap-1.5 rounded-xl border border-dashed p-3 transition-colors"
                :class="drag.isOver({ kind: `unassigned` }) ? `border-link bg-link/10` : `border-line`"
            >
                <ul v-if="view.unassigned.length > 0" class="contents" :aria-label="t(`sandbox.agentModels.notAssigned`)">
                    <li v-for="role in view.unassigned" :id="`model-job-${role}`" :key="role">
                        <JobChip
                            :role="role"
                            :disabled="!loaded"
                            :active="jobOpen?.role === role"
                            @grab="(event: PointerEvent, chip: HTMLElement) => drag.begin(event, role, chip)"
                            @open="(chip: HTMLElement) => openJob(role, chip)"
                        />
                    </li>
                </ul>
                <span v-else class="px-1 text-2xs text-subtle">{{ t(`sandbox.agentModels.dropToUnassign`) }}</span>
            </div>
        </Section>

        <Section data-setting="agent-model-setups" :label="t(`sandbox.agentModels.setups`)" :heading="2">
            <template #actions>
                <Button size="small" tier="quiet" icon="plus" :label="t(`sandbox.agentModels.newSetup`)" :disabled="!loaded" @click="makeSetup" />
            </template>
            <p class="mb-2.5 text-2xs text-subtle">{{ t(`sandbox.agentModels.setupsCaption`) }}</p>
            <div class="flex flex-col gap-3">
                <SetupCard
                    v-for="setup in view.setups"
                    :key="setup.id"
                    :setup="setup"
                    v-bind="cardProps"
                    :over="drag.isOver({ kind: `setup`, id: setup.id })"
                    :rename-on-mount="justMade === setup.id"
                    @write="(pins: readonly ModelPin[]) => write(withSetupPins(stored, setup.id, pins))"
                    @open="openPicker"
                    @rename="(name: string) => write(withSetupName(stored, setup.id, name))"
                    @suggested="setup.preset !== undefined && write(withSuggestedModels(stored, setup.preset))"
                    @remove="write(withoutSetup(stored, setup.id))"
                    @job="openJob"
                    @grab="drag.begin"
                />
                <!-- While a job is in flight: drop it here for a setup of its own, starting as a copy of what it runs on now. -->
                <div
                    v-if="drag.dragging.value"
                    data-setup-drop="new"
                    class="flex items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-xs transition-colors"
                    :class="drag.isOver({ kind: `new` }) ? `border-link bg-link/10 text-link` : `border-line text-subtle`"
                >
                    <Icon name="plus" class="text-2xs" aria-hidden="true" />
                    {{ t(`sandbox.agentModels.dropForNew`) }}
                </div>
            </div>
        </Section>
    </div>

    <!-- The chip in flight, riding the pointer; pointer-events off so the page underneath answers the hit test. -->
    <Teleport to="body">
        <div
            v-if="drag.dragging.value && drag.dragged.value !== undefined"
            class="pointer-events-none fixed left-0 top-0 z-50 rotate-2 rounded-full bg-card px-2 py-1 text-xs text-content shadow-lg ring-1 ring-line"
            :style="drag.ghostStyle.value"
            aria-hidden="true"
        >
            {{ draggedName }}
        </div>
    </Teleport>

    <ResponsiveOverlay
        :model-value="jobOpen !== undefined"
        :anchor="jobOpen?.anchor"
        panel-class="w-80"
        side="bottom"
        @update:model-value="setJobOpen"
    >
        <ModelJobPanel
            v-if="jobOpen !== undefined"
            :role="jobOpen.role"
            :view="view"
            :judge-off="judgeOff"
            :guidance-set="guidanceSet"
            @move="moveOpenJob"
            @guidance="openGuidance"
        />
    </ResponsiveOverlay>

    <!-- The router's second setting, opened from its own panel: a document, so it takes the dialog rather than a field
         shell inside a drawer — the same surface the system prompt is written on. -->
    <Modal :open="guidanceOpen" size="lg" :header="t(`sandbox.agentModels.howAutoChooses`)" @update:open="guidanceOpen = $event">
        <div class="flex flex-col gap-4">
            <!-- A writing surface, not a field: it opens at the height of something you would compose rather than snapping
                 shut around one line of placeholder. -->
            <MarkdownDocument
                v-model="guidance"
                class="min-h-40"
                :editable="loaded"
                :stored="storedGuidance"
                :saving="save.isPending.value"
                save="explicit"
                :label="t(`sandbox.agentModels.howAutoChooses`)"
                :max-chars="AUTO_MODEL_GUIDANCE_MAX"
                :placeholder="t(`sandbox.agentModels.whatYoudTellSomebody`)"
                @save="saveGuidance"
            />
            <Notice v-if="refusal !== undefined" :of="refusal" />
        </div>
    </Modal>

    <!-- Mount once so the picker can place itself on open. -->
    <ModelPinPicker
        :open="editing !== undefined"
        :anchor="editing?.anchor"
        :header="editing?.header"
        :pin="editingPin"
        :current="editingCurrent"
        :knobs="editing?.list.knobs === true"
        :helper-jobs="editing?.list.helperJobs === true"
        :taken="editing?.list.taken.value ?? []"
        @update:open="setPickerOpen"
        @pick="pick"
        @configure="configure"
    />
</template>
