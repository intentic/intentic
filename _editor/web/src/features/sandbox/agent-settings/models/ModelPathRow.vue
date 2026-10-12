<script setup lang="ts">
import { MODEL_ROLES, type ModelPin, type ModelRole, type ModelRoleSpec } from "@intentic/sandbox-contract";
import { Button, type IconName, Row, ui } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import { computed } from "vue";
import AddModelButton from "./AddModelButton.vue";
import { type PinnedList, pinKnobSummary, pinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";
import type { ModelPath } from "./modelPaths";
import { roleLabel } from "./roleWords";
import { useT } from "@intentic/ui/i18n";

// One list of models and the jobs that run on it: the default's, or one a set of jobs was given of their own. The jobs
// are the row's title, each a press that opens where it can be moved; the list under them is edited once for all of
// them, which is the whole point of drawing them together.

const t = useT();

const { path, disabled, loaded, inert, guided, activeJob } = defineProps<{
    path: ModelPath;
    /** Inert while the settings have not been read. */
    disabled: boolean;
    // Whether settings have landed; the empty-list line claims what these jobs will do, so it can't draw before that.
    loaded: boolean;
    /** A job whose feature is switched off elsewhere: drawn, and still movable, but said to be out of use. */
    inert: (role: ModelRole) => boolean;
    /** A job carrying a setting its model list cannot show (the router's guidance). */
    guided: (role: ModelRole) => boolean;
    /** The job whose panel is open, drawn pressed. */
    activeJob?: ModelRole | undefined;
}>();

const emit = defineEmits<{
    write: [readonly ModelPin[]];
    open: [PinnedList, number | undefined, HTMLElement];
    job: [ModelRole, HTMLElement];
    makeDefault: [];
    followDefault: [];
}>();

const SPECS = new Map<ModelRole, ModelRoleSpec>(MODEL_ROLES.map((role) => [role.id, role]));
const glyph = (role: ModelRole): IconName => {
    const icon = SPECS.get(role)?.icon ?? ``;
    return isIconName(icon) ? icon : `sparkles`;
};
const kindOf = (role: ModelRole): string => SPECS.get(role)?.kind ?? `run`;

// Built here, over this row's own list: the page's one picker hangs off whichever row asked, with this editor in hand.
const list = pinnedList({
    read: () => path.pins,
    write: (pins) => emit(`write`, pins),
    decode: (pin) => pin,
    encode: (pin) => pin,
    detail: pinKnobSummary,
    knobs: true,
    // A model that cannot run a turn may sit only on a list that feeds nothing but one-shot jobs.
    helperJobs: path.roles.length > 0 && path.roles.every((role) => kindOf(role) === `helper`),
});

const jobsNamed = computed(() => path.roles.map((role) => roleLabel({ id: role })).join(`, `));

// An empty list is a normal state that means something different per kind of job: a one-shot does not run at all, a
// whole session opens on the chat's own model. Said once for the row, in the words that fit what it holds.
const emptyNote = computed<string | undefined>(() => {
    if (!loaded || path.pins.length > 0 || path.roles.length === 0) {
        return undefined;
    }
    const kinds = new Set(path.roles.map(kindOf));
    if (kinds.size > 1) {
        return t(`sandbox.agentModels.emptyMixed`);
    }
    return kinds.has(`helper`) ? t(`sandbox.agentModels.emptyHelpers`) : t(`sandbox.agentModels.emptyRuns`);
});

</script>

<template>
    <!-- No #control: the jobs take the whole headline, wrapping, since a row can hold every job there is. What edits the
         list sits under it, beside what it edits. -->
    <Row :description="path.isDefault ? t(`sandbox.agentModels.laterJobs`) : undefined">
        <template #title>
            <!-- Each job is its own press: what it does, and where else it can run. -->
            <ul v-if="path.roles.length > 0" class="flex flex-wrap gap-1.5" :aria-label="t(`sandbox.agentModels.jobsOnList`)">
                <li v-for="role in path.roles" :id="`model-job-${role}`" :key="role">
                    <button
                        type="button"
                        :class="ui.chip({ on: activeJob === role }, `gap-1 px-2 py-1`, inert(role) && `opacity-60`)"
                        :disabled="disabled"
                        aria-haspopup="dialog"
                        :aria-expanded="activeJob === role"
                        @click="emit(`job`, role, $event.currentTarget as HTMLElement)"
                    >
                        <Icon :name="glyph(role)" class="text-2xs" aria-hidden="true" />
                        <span>{{ roleLabel({ id: role }) }}</span>
                        <span v-if="inert(role)" class="text-subtle">· {{ t(`sandbox.agentModels.notInUse`) }}</span>
                        <span v-else-if="guided(role)" class="text-subtle">· {{ t(`sandbox.agentModels.guided`) }}</span>
                    </button>
                </li>
            </ul>
            <span v-else class="text-muted">{{ t(`sandbox.agentModels.noJobsOnDefault`) }}</span>
        </template>

        <template #below>
            <div class="flex flex-col gap-2">
                <ModelPinList
                    v-if="path.pins.length > 0"
                    :entries="list.entries.value"
                    :note-thinking="list.helperJobs"
                    @promote="list.promote"
                    @remove="list.remove"
                    @edit="(index: number, anchor: HTMLElement) => emit(`open`, list, index, anchor)"
                />
                <p v-else-if="emptyNote !== undefined" class="text-2xs text-subtle">{{ emptyNote }}</p>
                <div class="flex flex-wrap items-center gap-2">
                    <!-- Named for what it writes: the accessible name is what tells this button from the next row's. -->
                    <AddModelButton
                        :label="path.isDefault ? t(`sandbox.agentModels.addDefaultModel`) : t(`sandbox.agentModels.addModelFor`, { jobs: jobsNamed })"
                        :disabled="disabled"
                        @open="(anchor: HTMLElement) => emit(`open`, list, undefined, anchor)"
                    />
                    <!-- An empty list is not offered as the default: it would read as "every new job is off". -->
                    <div v-if="!path.isDefault" class="ml-auto flex items-center gap-1">
                        <Button
                            v-if="path.pins.length > 0"
                            size="small"
                            tier="quiet"
                            :label="t(`sandbox.agentModels.makeDefault`)"
                            :disabled="disabled"
                            @click="emit(`makeDefault`)"
                        />
                        <Button size="small" tier="quiet" :label="t(`sandbox.agentModels.useDefault`)" :disabled="disabled" @click="emit(`followDefault`)" />
                    </div>
                </div>
            </div>
        </template>
    </Row>
</template>
