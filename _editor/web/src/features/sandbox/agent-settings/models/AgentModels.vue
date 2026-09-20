<script setup lang="ts">
import {
    MODEL_ROLE_BLOCKS,
    type ModelPin,
    type ModelRole,
    type ModelRoleBlockId,
    type ModelRoleSpec,
    modelPinKey,
} from "@intentic/sandbox-contract";
import { Button, MarkdownDocument, Modal, RowGroup, SegmentedControl } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed, ref, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";
import { honoredPinKnobs } from "../../../chat/models/run-settings/pickerRunSettings";
import { useDraft } from "../../../../lib/useDraft";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import ModelGroupRow from "./ModelGroupRow.vue";
import { type PinnedList, pinKnobSummary, pinnedList } from "./modelPinList";
import ModelPinPicker from "./ModelPinPicker.vue";
import ModelRoleRow from "./ModelRoleRow.vue";
import { useT } from "@intentic/ui/i18n";

// Every model choice the sandbox makes: one row per job from the catalog (MODEL_ROLE_BLOCKS), grouped by
// the catalog rather than by hand here. A block's Simple view stores nothing of its own, it reads and writes the same
// per-job settings as Advanced, so switching views never changes what's saved.

const t = useT();

const { settings, patch, save } = useSandboxSettings();
const loaded = computed(() => settings.value !== undefined);

// The one job on this page that is not answered by a model list alone: Auto also reads what it is told to weigh. It
// lives on that job's own row rather than in a section of its own, since the catalog's blocks are kind partitions
// (model-roles.test.ts) and a job's settings belong where its models are.
// Explicit save, and a cap matching the schema's (SandboxSettingsSchema.autoModelGuidance) — what the daemon refuses past.
const ROUTER = `model-router`;
const GUIDANCE_MAX = 2000;
const guidance = useDraft(() => settings.value?.autoModelGuidance);
const storedGuidance = computed(() => settings.value?.autoModelGuidance);
const guidanceSet = computed(() => (storedGuidance.value ?? ``).trim() !== ``);
const saveGuidance = (text: string): void => patch({ autoModelGuidance: text.trim() });
// Written guidance is silent state: it steers every chat that opens on Auto and no model list on this page shows it.
// The chip says the job's state, not the button's name — the two sit an inch apart and must not read as one word twice.
const guidanceBadge = computed(() =>
    guidanceSet.value ? { label: t(`sandbox.agentModels.guided`), hint: t(`sandbox.agentModels.autoReadsThisAlongside`) } : undefined,
);
const guidanceOpen = ref(false);

// Sends the whole `modelRoles` record every time: the settings patch merges only at the top level, so writing one
// role's key alone would drop the others. The bulk editor batches several keys through here in one patch.
const writeRoles = (next: Partial<Record<ModelRole, ModelPin[]>>): void => patch({ modelRoles: { ...settings.value?.modelRoles, ...next } });

const listOf = (role: ModelRole): readonly ModelPin[] => settings.value?.modelRoles[role] ?? [];

// Built from the catalog: every role stores the same shape (an ordered pin list), so a new role gets a working row for
// free.
const editorFor = (role: ModelRole): PinnedList =>
    pinnedList({
        read: () => listOf(role),
        write: (pins) => writeRoles({ [role]: [...pins] }),
        decode: (pin) => pin,
        encode: (pin) => pin,
        detail: pinKnobSummary,
        knobs: true,
    });

// Writes a whole set of roles in one patch, avoiding the top-level-merge race of separate writes; used by both the
// collapsed list and the selection verbs.
const acrossRoles = (roles: readonly ModelRole[], listFor: (role: ModelRole) => ModelPin[]): void =>
    writeRoles(Object.fromEntries(roles.map((role) => [role, listFor(role)])) as Partial<Record<ModelRole, ModelPin[]>>);

// The judge is the one job switchable off elsewhere; while off it must drop out of every group gesture, not just refuse
// its own row, or a collapsed write could overwrite it and `jobsDiffer` could misfire.
const JUDGE = `safety-judge`;
const judgeOff = computed(() => settings.value?.commandJudge === `off`);
const inert = (role: ModelRole): boolean => role === JUDGE && judgeOff.value;

// Jobs actually reachable right now; what every multi-job gesture (collapsed list, differ check, selection) acts on.
const live = (ids: readonly ModelRole[]): readonly ModelRole[] => ids.filter((role) => !inert(role));
const liveRoles = (roles: readonly ModelRoleSpec[]): readonly ModelRoleSpec[] => roles.filter((role) => !inert(role.id));

// Nothing is stored per block: its list is derived from jobs and fanned back out, so Advanced later shows exactly what
// was written. Identity needs every field to match, not just the model, or a re-point could silently hit a lookalike.
// Compared as the run would read it (honoredPinKnobs), never as stored: a knob this provider has no control for —
// `thinking` outside Claude, `fast` outside the Claude Code loop — changes nothing about the turn, so it may not be the
// reason two jobs read as split or a shared model drops out of the collapsed list.
const pinIdentity = (pin: ModelPin): string => {
    const honored = honoredPinKnobs(pin);
    return [modelPinKey(honored), honored.effort ?? ``, honored.thinking ?? ``, honored.fast ?? ``, honored.harness ?? ``].join(`|`);
};

// Intersection, not union: a union would show a model on jobs that don't actually have it, the one lie a collapsed view
// could tell.
const sharedPins = (ids: readonly ModelRole[]): readonly ModelPin[] => {
    const [first, ...rest] = ids.map((role) => listOf(role));
    if (first === undefined) {
        return [];
    }
    const others = rest.map((held) => new Set(held.map(pinIdentity)));
    // Handed back honored, since this list is also what a collapsed edit writes to every job: a knob the run ignores
    // must not be copied onto jobs that never had it.
    return first.filter((pin) => others.every((held) => held.has(pinIdentity(pin)))).map(honoredPinKnobs);
};

// Same entries, same order, across the live jobs only; an inert job may not be the reason a block reads as split.
const jobsDiffer = (ids: readonly ModelRole[]): boolean => new Set(live(ids).map((role) => listOf(role).map(pinIdentity).join(`\n`))).size > 1;

// One editor over a whole block: whatever it becomes is written to every live job of it, in one patch.
const groupList = (ids: readonly ModelRole[]): PinnedList =>
    pinnedList({
        read: () => sharedPins(live(ids)),
        write: (pins) => acrossRoles(live(ids), () => [...pins]),
        decode: (pin) => pin,
        encode: (pin) => pin,
        detail: pinKnobSummary,
        knobs: true,
    });

// Built once: editors close over the settings ref and stay live; block membership is the catalog's answer.
const blocks = MODEL_ROLE_BLOCKS.map((block) => {
    const ids = block.roles.map((role) => role.id) as readonly ModelRole[];
    return { ...block, ids, rows: block.roles.map((role) => ({ role, list: editorFor(role.id) })), group: groupList(ids) };
});

// Ordered list, not a Set (also read as a count); per-visit only, never persisted.
const selected = ref<readonly ModelRole[]>([]);
const isSelected = (role: ModelRole): boolean => selected.value.includes(role);
const selectRole = (role: ModelRole, on: boolean): void => {
    selected.value = on ? [...selected.value.filter((held) => held !== role), role] : selected.value.filter((held) => held !== role);
};

// The page's one choke point for "which jobs is this gesture about", in the block's own order; drops inert jobs, since
// a bulk write can't reach a row whose own Add button already refuses presses.
const selectedIn = (ids: readonly ModelRole[]): readonly ModelRole[] => live(ids).filter((role) => selected.value.includes(role));
const allSelectedIn = (ids: readonly ModelRole[]): boolean => selectedIn(ids).length === live(ids).length;
const someSelectedIn = (ids: readonly ModelRole[]): boolean => {
    const picked = selectedIn(ids).length;
    return picked > 0 && picked < live(ids).length;
};
// Untick drops every id of the block; tick takes only the live ones, so the box can still read `all` when one job is
// switched off.
const selectAllIn = (ids: readonly ModelRole[], on: boolean): void => {
    selected.value = on
        ? [...selected.value.filter((held) => !ids.includes(held)), ...live(ids)]
        : selected.value.filter((held) => !ids.includes(held));
};

// Per-group, not a page toggle: opens Advanced if jobs already disagree (collapsing would hide that), Simple if they
// agree. Derived once when settings land, not continuously, or a group could refold itself under the cursor.
type ModelView = `simple` | `advanced`;
const VIEWS = computed((): readonly { readonly label: string; readonly value: ModelView }[] => [
    { label: t(`sandbox.agentModels.simple`), value: `simple` },
    { label: t(`sandbox.agentModels.advanced`), value: `advanced` },
]);

// Two refs: what settings opened with, and what's chosen since, so a late seed can't undo an early press.
const openedIn = shallowRef<Partial<Record<ModelRoleBlockId, ModelView>>>({});
const chosenView = ref<Partial<Record<ModelRoleBlockId, ModelView>>>({});
watch(
    loaded,
    (isLoaded) => {
        if (isLoaded) {
            openedIn.value = Object.fromEntries(blocks.map((block) => [block.id, jobsDiffer(block.ids) ? `advanced` : `simple`]));
        }
    },
    { immediate: true },
);
const viewOf = (id: ModelRoleBlockId): ModelView => chosenView.value[id] ?? openedIn.value[id] ?? `simple`;

// Collapsing a group drops its ticks too, or the next Advanced visit would open with rows ticked that nobody chose.
const setView = (block: { readonly id: ModelRoleBlockId; readonly ids: readonly ModelRole[] }, view: ModelView): void => {
    chosenView.value = { ...chosenView.value, [block.id]: view };
    if (view === `simple`) {
        selectAllIn(block.ids, false);
    }
};

// The bulk panel's written pin so far, if any; lets the picker draw knobs once one exists.
const bulkPin = shallowRef<ModelPin | undefined>(undefined);

// Taken only if every job in the set already has it; a model held by some but not others still has somewhere to land.
const sharedTaken = (roles: readonly ModelRole[]): readonly string[] => {
    const lists = roles.map((role) => listOf(role).map((pin) => modelPinKey(pin)));
    return lists.length === 0 ? [] : lists.reduce((shared, keys) => shared.filter((key) => keys.includes(key)));
};

// Upsert, not append, in order:
// - drops the pin this same panel just wrote, if the entry is being re-pointed
// - writes through an entry that already names this model, keeping its place
// - otherwise appends to the end
const withPin = (list: readonly ModelPin[], pin: ModelPin, replacing: ModelPin | undefined): ModelPin[] => {
    const key = modelPinKey(pin);
    const kept =
        replacing === undefined || modelPinKey(replacing) === key ? list : list.filter((held) => modelPinKey(held) !== modelPinKey(replacing));
    const at = kept.findIndex((held) => modelPinKey(held) === key);
    return at === -1 ? [...kept, pin] : kept.map((held, index) => (index === at ? pin : held));
};

// The model plus every knob set after it, onto every job in the set; `acrossRoles` is the one writer for both this and
// the collapsed list.
const applyToRoles = (roles: readonly ModelRole[], pin: ModelPin): void => {
    const replacing = bulkPin.value;
    bulkPin.value = pin;
    acrossRoles(roles, (role) => withPin(listOf(role), pin, replacing));
};

// A real gesture, not just a destructive one: an empty list means switched off (or handed back to the composer); no
// confirmation, same as removing a row's last entry.
const clearRoles = (ids: readonly ModelRole[]): void => acrossRoles(selectedIn(ids), () => []);

// One panel for the page, since a second ask supersedes the first. Its target is abstracted, not a (list, index) pair,
// so one panel serves both a row's write and the selection's; `pin`/`taken` stay live so a knob change never shows
// stale.
interface PickerTarget {
    readonly anchor: HTMLElement;
    readonly header: string;
    readonly knobs: boolean;
    readonly pin: () => ModelPin | undefined;
    readonly taken: () => readonly string[];
    // Answers the panel's question: a model row picked from the list.
    readonly apply: (pin: ModelPin) => void;
    // Writes a knob through; differs from `apply` only while adding, where there's no entry yet to configure.
    readonly configure: (pin: ModelPin) => void;
    // Whether the panel survives its answer: a row's does not; the selection's does, since more jobs may follow.
    readonly stayOpen: boolean;
}

const editing = shallowRef<PickerTarget | undefined>(undefined);
const editingPin = computed<ModelPin | undefined>(() => editing.value?.pin());
const editingTaken = computed<readonly string[]>(() => editing.value?.taken() ?? []);

const openRowPicker = (list: PinnedList, index: number | undefined, anchor: HTMLElement): void => {
    editing.value = {
        anchor,
        header: index === undefined ? `Add a model` : `Model`,
        knobs: list.knobs,
        pin: () => (index === undefined ? undefined : list.entries.value[index]?.pin),
        taken: () => list.taken.value,
        apply: (pin) => list.apply(index, pin),
        configure: (pin) => {
            if (index !== undefined) {
                list.apply(index, pin);
            }
        },
        stayOpen: false,
    };
};

// The set is captured at open, not read live, so the header's count stays honest even if more gets ticked while it's
// open; ticking more is answered by reopening the panel.
const openBulkPicker = (anchor: HTMLElement, ids: readonly ModelRole[]): void => {
    bulkPin.value = undefined;
    const roles = selectedIn(ids);
    editing.value = {
        anchor,
        // The safeguard against this panel's one mistake: it looks like a single row's, but spends across every job.
        header: `Model for ${roles.length} ${roles.length === 1 ? `job` : `jobs`}`,
        knobs: true,
        pin: () => bulkPin.value,
        taken: () => sharedTaken(roles),
        apply: (pin) => applyToRoles(roles, pin),
        configure: (pin) => applyToRoles(roles, pin),
        stayOpen: true,
    };
};

// The picker emits `pick` then `close`, right for a row but wrong for a `stayOpen` target whose gesture isn't finished
// at the model pick; the close arriving on the same tick is swallowed once, every other close still lands.
let swallowClose = false;
const pick = (pin: ModelPin): void => {
    const target = editing.value;
    if (target === undefined) {
        return;
    }
    target.apply(pin);
    swallowClose = target.stayOpen;
};
const configure = (pin: ModelPin): void => editing.value?.configure(pin);
const setPickerOpen = (open: boolean): void => {
    if (open) {
        return;
    }
    if (swallowClose) {
        swallowClose = false;
        return;
    }
    editing.value = undefined;
    bulkPin.value = undefined;
};
</script>

<template>
    <!-- `id` so a chat's "Turn it off everywhere" link can land here directly, not at the top of a long settings page. -->
    <div id="models" class="flex flex-col gap-6">
        <!-- Each catalog block owns its heading and visible model rows. -->
        <RowGroup v-for="block in blocks" :key="block.id" :label="block.label" sticky>
            <!-- The filter controls the visible model rows. -->
            <template #info>
                <SegmentedControl
                    :model-value="viewOf(block.id)"
                    :options="VIEWS"
                    size="xs"
                    :aria-label="t(`sandbox.agentModels.howToShow`, { toLowerCase: block.label.toLowerCase() })"
                    @update:model-value="(view: ModelView) => setView(block, view)"
                />
            </template>

            <!-- Per-group, acting on that group alone (a page-wide select-all would span blocks with nothing in common). -->
            <template #actions>
                <div v-if="viewOf(block.id) === `advanced`" class="flex flex-wrap items-center gap-2 @max-xl:hidden">
                    <label class="flex cursor-pointer items-center gap-2 text-2xs text-muted">
                        <Checkbox
                            :model-value="allSelectedIn(block.ids)"
                            :indeterminate="someSelectedIn(block.ids)"
                            binary
                            size="small"
                            :aria-label="t(`sandbox.agentModels.selectEveryJobUnder`, { toLowerCase: block.label.toLowerCase() })"
                            @update:model-value="(value: unknown) => selectAllIn(block.ids, value === true)"
                        />
                        <span>{{
                            selectedIn(block.ids).length > 0
                                ? t(`sandbox.agentModels.selected`, { count: selectedIn(block.ids).length })
                                : t(`sandbox.agentModels.selectJobs`)
                        }}</span>
                    </label>
                    <!-- Appears only once something's ticked; disabled buttons on every visit would just be furniture. -->
                    <template v-if="selectedIn(block.ids).length > 0">
                        <Button
                            size="small"
                            :label="t(`sandbox.agentModels.setModelAll`)"
                            :disabled="!loaded"
                            @click="(event: MouseEvent) => openBulkPicker(event.currentTarget as HTMLElement, block.ids)"
                        />
                        <!-- The other half of the vocabulary: an empty list means off, so this switches several jobs off in one press. -->
                        <Button
                            size="small"
                            severity="danger"
                            text
                            :label="t(`sandbox.agentModels.clearModels`)"
                            :disabled="!loaded"
                            @click="clearRoles(block.ids)"
                        />
                    </template>
                </div>
            </template>

            <!-- The same per-job setting, read and written a block at a time, not a summary (there are no rows under it). -->
            <ModelGroupRow
                v-if="viewOf(block.id) === `simple`"
                :block="block"
                :roles="liveRoles(block.roles)"
                :list="block.group"
                :differs="jobsDiffer(block.ids)"
                :disabled="!loaded"
                :loaded="loaded"
                @open="(index: number | undefined, anchor: HTMLElement) => openRowPicker(block.group, index, anchor)"
            >
                <!-- Names the job the count leaves out, and links to the same switch the Advanced row does. -->
                <template v-if="block.ids.includes(JUDGE) && judgeOff" #note>
                    <p class="text-2xs text-subtle">
                        {{ t(`sandbox.agentModels.safetyJudgeOffNot`) }}
                        <RouterLink
                            :to="{ name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } }"
                            class="text-link hover:underline"
                            >{{ t(`sandbox.agentModels.turnJudgeOn`) }}</RouterLink
                        >
                        {{ t(`sandbox.agentModels.underSafety`) }}
                    </p>
                </template>
            </ModelGroupRow>

            <!-- One row per job, the setting's true shape; `v-for` sits inside `v-else` to avoid combining both directives. -->
            <template v-else>
                <ModelRoleRow
                    v-for="row in block.rows"
                    :key="row.role.id"
                    :role="row.role"
                    :icon="row.role.icon"
                    :list="row.list"
                    :badge="row.role.id === ROUTER ? guidanceBadge : undefined"
                    :selected="isSelected(row.role.id)"
                    :disabled="!loaded || (row.role.id === JUDGE && judgeOff)"
                    :loaded="loaded"
                    @select="(on: boolean) => selectRole(row.role.id, on)"
                    @open="(index: number | undefined, anchor: HTMLElement) => openRowPicker(row.list, index, anchor)"
                >
                    <!-- The router is the one job with a second setting: what it should weigh, in the owner's words. -->
                    <template v-if="row.role.id === ROUTER" #control>
                        <Button
                            size="small"
                            severity="secondary"
                            :text="!guidanceSet"
                            :label="t(`sandbox.agentModels.guidance`)"
                            :disabled="!loaded"
                            @click="guidanceOpen = true"
                        />
                    </template>

                    <!-- Only the judge row receives this explanatory slot. -->
                    <template v-if="row.role.id === JUDGE" #note>
                        <!-- The judge row explains why its feature may be unavailable. -->
                        <p v-if="judgeOff" class="text-2xs text-subtle">
                            {{ t(`sandbox.agentModels.nothingJudgingCommandsAt`) }}
                            <RouterLink
                                :to="{ name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } }"
                                class="text-link hover:underline"
                                >{{ t(`sandbox.agentModels.turnJudgeOn`) }}</RouterLink
                            >
                            {{ t(`sandbox.agentModels.underSafety`) }}
                        </p>
                        <!-- The judge model evaluates untrusted generated input. -->
                        <p v-else class="text-2xs text-subtle">
                            {{ t(`sandbox.agentModels.worthBetterModelThan`) }}
                        </p>
                    </template>
                </ModelRoleRow>
            </template>
        </RowGroup>

    </div>

    <!-- The router's second setting, opened from its own row: a document, so it takes the dialog rather than a field
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
            :max-chars="GUIDANCE_MAX"
            :placeholder="t(`sandbox.agentModels.whatYoudTellSomebody`)"
            @save="saveGuidance"
        />
    </Modal>

    <!-- Mount once so the picker can place itself on open. -->
    <ModelPinPicker
        :open="editing !== undefined"
        :anchor="editing?.anchor"
        :header="editing?.header"
        :pin="editingPin"
        :knobs="editing?.knobs === true"
        :taken="editingTaken"
        @update:open="setPickerOpen"
        @pick="pick"
        @configure="configure"
    />
</template>
