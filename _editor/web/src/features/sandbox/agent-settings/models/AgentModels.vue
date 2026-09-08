<script setup lang="ts">
import {
    MODEL_ROLE_BLOCKS,
    MODEL_ROLES,
    type ModelPin,
    type ModelRole,
    type ModelRoleBlockId,
    type ModelRoleSpec,
    modelPinKey,
    parsePinned,
} from "@intentic/sandbox-contract";
import { Button, Row, RowGroup, SegmentedControl, Verdict } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed, ref, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useSavings } from "../../usage/useSavings";
import AddModelButton from "./AddModelButton.vue";
import ModelGroupRow from "./ModelGroupRow.vue";
import { type PinnedList, pinKnobSummary, pinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";
import ModelPinPicker from "./ModelPinPicker.vue";
import ModelRoleRow from "./ModelRoleRow.vue";

// Every model choice the sandbox makes: one row per job from the catalog (MODEL_ROLES/MODEL_ROLE_BLOCKS), grouped by
// the catalog rather than by hand here. A block's Simple view stores nothing of its own, it reads and writes the same
// per-job settings as Advanced, so switching views never changes what's saved.

const { settings, patch } = useSandboxSettings();
const loaded = computed(() => settings.value !== undefined);

// Fixed window: long enough to mean something, short enough not to grade a since-changed judge forever.
const TIER_WINDOW_DAYS = 30;
const tierWindow = computed(() => ({ from: new Date(Date.now() - TIER_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) }));
const { savings } = useSavings(tierWindow);
const tierReport = computed(() => savings.value?.tier);
const pct = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;

// Built here, not in the template, to avoid inline `v-if`s mid-sentence for the optional share.
const tierUnit = computed<string>(() => {
    const report = tierReport.value;
    if (report === undefined) {
        return ``;
    }
    const share = report.judged > 0 ? ` (${pct(report.fast, report.judged)})` : ``;
    return `of ${report.judged} turns judged simple${share} · last ${TIER_WINDOW_DAYS} days`;
});
// Empty until something has happened; `<Verdict>` reads empty as absent, not as a measured zero.
const tierEvidence = computed<string>(() => {
    const report = tierReport.value;
    if (report === undefined) {
        return ``;
    }
    return [
        report.routed > 0 ? `${report.routed} down-routed` : undefined,
        report.escalated > 0 ? `${report.escalated}/${report.fast} bumped up` : undefined,
        report.denied > 0 ? `${report.denied} vetoed` : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
});

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
const pinIdentity = (pin: ModelPin): string => [modelPinKey(pin), pin.effort ?? ``, pin.thinking ?? ``, pin.fast ?? ``, pin.harness ?? ``].join(`|`);

// Intersection, not union: a union would show a model on jobs that don't actually have it, the one lie a collapsed view
// could tell.
const sharedPins = (ids: readonly ModelRole[]): readonly ModelPin[] => {
    const [first, ...rest] = ids.map((role) => listOf(role));
    if (first === undefined) {
        return [];
    }
    const others = rest.map((held) => new Set(held.map(pinIdentity)));
    return first.filter((pin) => others.every((held) => held.has(pinIdentity(pin))));
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

// Not a role: a property of automatic tier selection, storing plain `${provider}:${model}` keys with no knobs.
const fast = pinnedList({
    read: () => settings.value?.autoFastModels ?? [],
    write: (keys) => patch({ autoFastModels: [...keys] }),
    decode: (key) => parsePinned(key),
    encode: (pin) => modelPinKey(pin),
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
const VIEWS: readonly { readonly label: string; readonly value: ModelView }[] = [
    { label: `Simple`, value: `simple` },
    { label: `Advanced`, value: `advanced` },
];

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
    // Whether the panel survives its answer: a row's doesn't; the selection's does, still needing a tier drawn.
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

// Middle state is the point, not a halfway house: measuring first ends the guessing about a cutoff.
const autoTierOptions = [
    { label: `Off`, value: `off` },
    { label: `Measure`, value: `shadow` },
    { label: `On`, value: `on` },
];

// Named, not numbered: the cutoff is meaningless unread; offered live in both Measure and On.
const eagernessOptions = [
    { label: `Cautious`, value: `cautious` },
    { label: `Balanced`, value: `balanced` },
    { label: `Eager`, value: `eager` },
];
</script>

<template>
    <!-- `id` so a chat's "Turn it off everywhere" link can land here directly, not at the top of a long settings page. -->
    <div id="models" class="flex flex-col gap-6">
        <!--
            One group per catalog block; heading is the block's own, so it can't describe rows it no longer holds. Sticky, since the header now
            carries controls over rows that scroll away from the button acting on them.
        -->
        <RowGroup v-for="block in blocks" :key="block.id" :label="block.label" sticky>
            <!--
                Replaces the row count and caption that used to sit here, both restating what's on screen; this is the control that changes what the
                group is. Stays on phone, unlike the selection cluster, since collapsing rows helps most there.
            -->
            <template #info>
                <SegmentedControl
                    :model-value="viewOf(block.id)"
                    :options="VIEWS"
                    size="xs"
                    :aria-label="`How to show ${block.label.toLowerCase()}`"
                    @update:model-value="(view: ModelView) => setView(block, view)"
                />
            </template>

            <!--
                Per-group, acting on that group alone (a page-wide select-all would span blocks with nothing in common). Hidden on phone (no tick
                column there) and in the collapsed view (there are no rows to tick).
            -->
            <template #actions>
                <div v-if="viewOf(block.id) === `advanced`" class="flex flex-wrap items-center gap-2 max-md:hidden">
                    <label class="flex cursor-pointer items-center gap-2 text-2xs text-muted">
                        <Checkbox
                            :model-value="allSelectedIn(block.ids)"
                            :indeterminate="someSelectedIn(block.ids)"
                            binary
                            size="small"
                            :aria-label="`Select every job under ${block.label.toLowerCase()}`"
                            @update:model-value="(value: unknown) => selectAllIn(block.ids, value === true)"
                        />
                        <span>{{ selectedIn(block.ids).length > 0 ? `${selectedIn(block.ids).length} selected` : `Select jobs` }}</span>
                    </label>
                    <!-- Appears only once something's ticked; disabled buttons on every visit would just be furniture. -->
                    <template v-if="selectedIn(block.ids).length > 0">
                        <Button
                            size="small"
                            label="Set a model for all…"
                            :disabled="!loaded"
                            @click="(event: MouseEvent) => openBulkPicker(event.currentTarget as HTMLElement, block.ids)"
                        />
                        <!-- The other half of the vocabulary: an empty list means off, so this switches several jobs off in one press. -->
                        <Button size="small" severity="danger" text label="Clear models" :disabled="!loaded" @click="clearRoles(block.ids)" />
                    </template>
                </div>
            </template>

            <!--
                The same per-job setting, read and written a block at a time, not a summary (there are no rows under it). Handed only jobs that can
                actually run, so an inert one can't make an otherwise-agreeing block misreport as differing.
            -->
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
                        Safety judge is off, so it is not one of these and nothing here writes to it.
                        <RouterLink
                            :to="{ name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } }"
                            class="text-link hover:underline"
                            >Turn the judge on</RouterLink
                        >
                        under Safety.
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
                    :selected="isSelected(row.role.id)"
                    :disabled="!loaded || (row.role.id === JUDGE && judgeOff)"
                    :loaded="loaded"
                    @select="(on: boolean) => selectRole(row.role.id, on)"
                    @open="(index: number | undefined, anchor: HTMLElement) => openRowPicker(row.list, index, anchor)"
                >
                    <!--
                        `v-if` sits on the `<template>`, not inside the slot, so the other seventeen rows get no slot at all: an empty slot still
                        opens dead space below the row.
                    -->
                    <template v-if="row.role.id === JUDGE" #note>
                        <!-- Points at the switch: the only row here whose feature can be off elsewhere needs to explain why it's disabled. -->
                        <p v-if="judgeOff" class="text-2xs text-subtle">
                            Nothing is judging commands at the moment, so this is not in use.
                            <RouterLink
                                :to="{ name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } }"
                                class="text-link hover:underline"
                                >Turn the judge on</RouterLink
                            >
                            under Safety.
                        </p>
                        <!--
                            Not "pick something cheap": the judge is the only job here whose input may have been written by whatever the agent was
                            reading, arguing for its own approval.
                        -->
                        <p v-else class="text-2xs text-subtle">
                            Worth a better model than the rest of the automatic jobs: it reads the command as data, and on a turn that has taken in
                            something from outside, that text may be arguing for its own approval.
                        </p>
                    </template>
                </ModelRoleRow>
            </template>
        </RowGroup>

        <!--
            Not a job (not selectable), so its own group rather than a nineteenth row needing a placeholder tick column. Last, since it's the only
            setting that can override a choice made a second ago; the page reads in order of growing reach.
        -->
        <RowGroup label="Cheaper turns" caption="Not a job: a substitution made inside a turn you started.">
            <Row spine title="Automatic tier" description="Run simple turns on a cheaper model from the same provider.">
                <!--
                    Uses `#lead` like the job rows, not the `icon` prop, so its mark matches their size instead of the smaller type-sized glyph that
                    would misalign the title column. No tick: not selectable.
                -->
                <template #lead="{ mark, iconClass }">
                    <span class="flex shrink-0 items-center justify-center" :style="{ width: `${mark}px`, height: `${mark}px` }">
                        <Icon name="credit-card" aria-hidden="true" class="text-muted" :class="iconClass" />
                    </span>
                </template>
                <template #control>
                    <SegmentedControl
                        :model-value="settings?.autoTier ?? `shadow`"
                        :options="autoTierOptions"
                        @update:model-value="(autoTier: string) => patch({ autoTier: autoTier as `off` | `shadow` | `on` })"
                    />
                </template>
                <template #below>
                    <div class="flex flex-col gap-3">
                        <p v-if="settings?.autoTier === `off`" class="text-2xs text-muted">Nothing is judged or recorded.</p>
                        <p v-else-if="settings?.autoTier === `on`" class="text-2xs text-muted">
                            Simple turns run on the cheaper model. Each conversation can veto it.
                        </p>

                        <!-- The app's standard shape for a measured answer; no background, since `#below` is inside the row's hairline. -->
                        <Verdict
                            v-if="settings?.autoTier !== `off` && tierReport !== undefined"
                            tone="content"
                            :value="`${tierReport.fast}`"
                            :unit="tierUnit"
                            :evidence="tierEvidence"
                        />

                        <div class="flex flex-col gap-1.5">
                            <div class="flex flex-wrap items-center justify-between gap-3">
                                <span class="text-xs font-medium text-content">Cheaper model</span>
                                <div class="flex flex-wrap items-center justify-end gap-2">
                                    <div v-if="settings?.autoTier !== `off`" class="flex shrink-0 items-center" role="group" aria-label="How readily">
                                        <SegmentedControl
                                            :model-value="settings?.autoTierEagerness ?? `balanced`"
                                            :options="eagernessOptions"
                                            wrap
                                            @update:model-value="
                                                (autoTierEagerness: string) =>
                                                    patch({ autoTierEagerness: autoTierEagerness as `cautious` | `balanced` | `eager` })
                                            "
                                        />
                                    </div>
                                    <AddModelButton
                                        label="Add a model for automatic tier selection"
                                        :disabled="!loaded"
                                        @open="(anchor: HTMLElement) => openRowPicker(fast, undefined, anchor)"
                                    />
                                </div>
                            </div>
                            <ModelPinList
                                v-if="fast.entries.value.length > 0"
                                :entries="fast.entries.value"
                                @promote="fast.promote"
                                @remove="fast.remove"
                                @edit="(index: number, anchor: HTMLElement) => openRowPicker(fast, index, anchor)"
                            />
                            <p v-else-if="loaded" class="text-2xs text-muted">
                                <span class="text-content">Auto</span>: cheapest from the chat's provider.
                            </p>
                        </div>
                    </div>
                </template>
            </Row>
        </RowGroup>
    </div>

    <!--
        Mounted once; the overlay inside places itself on an `open` watcher, so an already-open host would never place and would park off-screen. Its
        content remounts per open, resetting the search box and catalogs.
    -->
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
