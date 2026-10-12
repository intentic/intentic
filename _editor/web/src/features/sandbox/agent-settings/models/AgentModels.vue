<script setup lang="ts">
import { AUTO_MODEL_GUIDANCE_MAX, type ModelPin, type ModelRole, MODEL_ROLE_IDS } from "@intentic/sandbox-contract";
import { MarkdownDocument, Modal, Notice, ResponsiveOverlay, RowGroup } from "@intentic/ui";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useTrimmedDraft } from "../../../../lib/useDraft";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import type { PinnedList } from "./modelPinList";
import { editPath, followDefault, type JobTarget, type Layout, makeDefault, type ModelPath, modelPaths, moveJob, type PathWrite } from "./modelPaths";
import ModelJobPanel from "./ModelJobPanel.vue";
import ModelPathRow from "./ModelPathRow.vue";
import ModelPinPicker from "./ModelPinPicker.vue";
import { useT } from "@intentic/ui/i18n";

// Every model choice the sandbox makes, drawn as the lists it actually holds: the default list, which every job runs on
// until it is given one of its own, then one row per other list with the jobs that share it. A setup where most jobs
// want the same models is one row; a job that wants something else is pressed and moved, and its row appears. Nothing
// is stored per row: rows are read off the per-job settings (modelPaths.ts), so no view and no grouping can disagree
// with what is saved.

const t = useT();

// A refused write is put back on screen by useSandboxSettings; `refusal` says why here, or the press reads as nothing.
const { settings, patch, save, refusal } = useSandboxSettings();
const loaded = computed(() => settings.value !== undefined);

// Which row a job was put in during this visit, so a job just given its own models does not fold back into the row it
// left while its list is still a copy. Per visit only: the next one reads rows straight off the settings.
const layout = shallowRef<Layout>(new Map());
let made = 0;
const mint = (): string => `n:${++made}`;

const resolved = computed(() => ({ modelRoles: settings.value?.modelRoles ?? {}, modelDefault: settings.value?.modelDefault ?? [] }));
const paths = computed<readonly ModelPath[]>(() => modelPaths(resolved.value, layout.value));
const defaultPath = computed(() => paths.value.find((path) => path.isDefault)!);
const ownPaths = computed(() => paths.value.filter((path) => !path.isDefault));

// Every write goes through here: the layout moves with it, and the patch carries whole `modelRoles` and `modelDefault`
// values, since the settings route merges only at the top level.
const commit = (write: PathWrite): void => {
    layout.value = write.layout;
    patch(write.fields);
};
const pathById = (id: string): ModelPath | undefined => paths.value.find((path) => path.id === id);
const writePath = (id: string, pins: readonly ModelPin[]): void => {
    const path = pathById(id);
    if (path !== undefined) {
        commit(editPath(resolved.value, layout.value, path, pins));
    }
};

// The judge is the one job switchable off elsewhere; while off its chip says so, and it stays movable.
const judgeOff = computed(() => settings.value?.commandJudge === `off`);
const inert = (role: ModelRole): boolean => role === `safety-judge` && judgeOff.value;

// The one job on this page not answered by a model list alone: Auto also reads what it is told to weigh. Explicit save,
// and the schema's own cap (AUTO_MODEL_GUIDANCE_MAX), the one the daemon refuses past. Saved trimmed, so measured
// trimmed (useTrimmedDraft), or a save that landed would still read "Not saved yet".
const { draft: guidance, stored: storedGuidance } = useTrimmedDraft(() => settings.value?.autoModelGuidance);
const guidanceSet = computed(() => (storedGuidance.value ?? ``).trim() !== ``);
const guided = (role: ModelRole): boolean => role === `model-router` && guidanceSet.value;
const saveGuidance = (text: string): void => patch({ autoModelGuidance: text.trim() });
const guidanceOpen = ref(false);

/* ONE JOB'S PANEL, opened from its chip: where it runs, and what it alone carries. */

const jobOpen = shallowRef<{ readonly role: ModelRole; readonly anchor: HTMLElement } | undefined>(undefined);
const openJob = (role: ModelRole, anchor: HTMLElement): void => {
    // A second press on the chip that opened it closes it; the overlay ignores presses on its own anchor so this can.
    jobOpen.value = jobOpen.value?.anchor === anchor ? undefined : { role, anchor };
};
const move = (target: JobTarget): void => {
    const job = jobOpen.value;
    jobOpen.value = undefined;
    if (job !== undefined) {
        commit(moveJob(resolved.value, layout.value, paths.value, job.role, target, mint));
    }
};
const setJobOpen = (open: boolean): void => {
    if (!open) {
        jobOpen.value = undefined;
    }
};
const openGuidance = (): void => {
    jobOpen.value = undefined;
    guidanceOpen.value = true;
};

// A link naming a job (`?job=safety-judge`, Safety's "Change in Models") lands on that job: its chip is scrolled to and
// its panel opened, since the chip is where the job's model is chosen. Read once, then dropped, so Back and a later
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

/* THE MODEL PICKER, one for the page, hung off whichever row asked. */

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

const rowProps = computed(() => ({ disabled: !loaded.value, loaded: loaded.value, inert, guided, activeJob: jobOpen.value?.role }));
</script>

<template>
    <!-- `id` so a chat's "Turn it off everywhere" link can land here directly, not at the top of a long settings page. -->
    <div id="models" class="flex flex-col gap-6">
        <RowGroup :label="t(`sandbox.agentModels.defaultModels`)" :caption="t(`sandbox.agentModels.defaultCaption`)">
            <ModelPathRow
                :path="defaultPath"
                v-bind="rowProps"
                @write="(pins: readonly ModelPin[]) => writePath(defaultPath.id, pins)"
                @open="openPicker"
                @job="openJob"
            />
        </RowGroup>

        <!-- Only once a job runs on something else: a fresh sandbox is the one row above, and nothing more to read. -->
        <RowGroup v-if="ownPaths.length > 0" :label="t(`sandbox.agentModels.ownLists`)" :caption="t(`sandbox.agentModels.ownCaption`)">
            <ModelPathRow
                v-for="path in ownPaths"
                :key="path.id"
                :path="path"
                v-bind="rowProps"
                @write="(pins: readonly ModelPin[]) => writePath(path.id, pins)"
                @open="openPicker"
                @job="openJob"
                @make-default="commit(makeDefault(resolved, layout, paths, path, mint))"
                @follow-default="commit(followDefault(resolved, layout, path))"
            />
        </RowGroup>
    </div>

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
            :paths="paths"
            :judge-off="judgeOff"
            :guidance-set="guidanceSet"
            @move="move"
            @guidance="openGuidance"
        />
    </ResponsiveOverlay>

    <!-- The router's second setting, opened from its own panel: a document, so it takes the dialog rather than a field
         shell inside a drawer — the same surface the system prompt is written on. -->
    <Modal :open="guidanceOpen" size="lg" :header="t(`sandbox.agentModels.howAutoChooses`)" @update:open="guidanceOpen = $event">
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
        <Notice v-if="refusal !== undefined" :of="refusal" class="mt-3" />
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
