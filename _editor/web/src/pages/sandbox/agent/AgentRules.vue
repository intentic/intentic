<script setup lang="ts">
import type { Rule } from "@intentic-app/api-contract";
import { ui, ContextMenu, Icon, Row, RowGroup, SkeletonRows, timeAgo } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useRules } from "../../../composables/sandbox/useRules";
import { useSandboxOutline } from "../../../composables/sandbox/useSandboxOutline";
import RuleForm from "./RuleForm.vue";
import RulesInfo from "./RulesInfo.vue";
import { momentOf, type RuleDraft } from "./ruleWords";

/* EVERY OTHER STANDING INSTRUCTION: the rules that don't have a row of their own further up this tab.
 *
 * The bet this whole group makes is that a rule is a SENTENCE: at this moment, if this is true, do this. The
 * form (RuleForm.vue) asks for those three things in that order and nothing else, and a row here is that same
 * sentence read back: out of the same vocabulary (ruleWords.ts), not out of a second table that agrees with
 * the first until the day it doesn't. The moment a form here needs a fourth concept, the answer is an agent:
 * which is already one of the things a rule can do: rather than another field.
 *
 * A ROW IS SCANNED, NOT READ. What used to be one grey run-on sentence per rule is now typeset: the moment as
 * a chip, the command in the type a command is written in, the paths as the globs they are. A list of ten is
 * something you look down for the one you meant; a list of ten identical grey paragraphs is something you
 * read, and nobody does.
 *
 * ONE FORM, TWO JOBS. Editing a rule opens the same form in the row's place, keeping its id, which is what
 * the activity feed names and what the firing stamps are keyed by, so renaming a rule does not orphan its
 * history. Before this, changing a command meant deleting the rule and typing all of it again. */

const { settings, listed, firings, upsert, remove, setEnabled, move, freeId } = useRules();
const outline = useSandboxOutline(computed(() => settings.value === undefined));

// Which row is a form right now: a rule's id while editing it, `undefined` otherwise. `adding` is its own flag
// rather than a sentinel id, because a rule may legitimately be called anything.
const editingId = ref<string | undefined>();
const adding = ref(false);
const editing = computed(() => listed.value.find((rule) => rule.id === editingId.value));

const close = (): void => {
    editingId.value = undefined;
    adding.value = false;
};

const startAdd = (): void => {
    editingId.value = undefined;
    adding.value = true;
};

const startEdit = (id: string): void => {
    adding.value = false;
    editingId.value = id;
};

/* The form writes the words; identity and the switch stay here. A rule being edited keeps BOTH: a relabel
 * that minted a new id would hand the feed a new name for the same rule and leave its firing history behind,
 * and one that reset `enabled` would quietly turn a rule back on that the owner had turned off. */
const saveDraft = (draft: RuleDraft): void => {
    const existing = editing.value;
    upsert({ id: existing?.id ?? freeId(draft.label), enabled: existing?.enabled ?? true, ...draft });
    close();
};

// The row's own menu. One instance for the list rather than one per row: they differ only in which rule they
// are pointed at, and forty teleported overlays to show one is forty too many.
const menu = ref<InstanceType<typeof ContextMenu>>();
const menuFor = ref<Rule | undefined>();

const openMenu = (event: Event, rule: Rule): void => {
    menuFor.value = rule;
    menu.value?.show(event);
};

/* Order is the priority at a deciding moment, so it has to be movable from the list that shows it. The two
 * moves are DISABLED at the ends rather than dropped from the menu: an item that vanishes reads as a bug, and
 * the ends are exactly where someone checks whether they can go further. */
const menuModel = computed<MenuItem[]>(() => {
    const rule = menuFor.value;
    if (rule === undefined) {
        return [];
    }
    const at = listed.value.findIndex((entry) => entry.id === rule.id);
    return [
        { label: `Edit`, icon: `pencil`, command: () => startEdit(rule.id) },
        { label: `Move up`, icon: `chevron-up`, disabled: at <= 0, command: () => move(rule.id, -1) },
        { label: `Move down`, icon: `chevron-down`, disabled: at === listed.value.length - 1, command: () => move(rule.id, 1) },
        { separator: true },
        { label: `Delete`, icon: `trash`, danger: true, command: () => remove(rule.id) },
    ];
});

// The three halves of the sentence's tail, each asked for separately so the row can typeset them differently:
// a command is read as a command, an instruction is read as words.
const commandOf = (rule: Rule): string | undefined => (rule.action.kind === `command` ? rule.action.command : undefined);
const textOf = (rule: Rule): string | undefined => (rule.action.kind === `instruct` ? rule.action.text : undefined);
const verdictOf = (rule: Rule): string | undefined =>
    rule.action.kind === `verdict` ? (rule.action.verdict === `allow` ? `land the work` : `hold the work on its branch`) : undefined;

// "Never" is a real answer and the one worth reading: a rule that has never done anything since it was written
// is either wrong or aimed at something that has not happened yet, and both are worth a second look.
const firedOf = (rule: Rule): string => {
    const at = firings.value[rule.id];
    return at === undefined ? `Never fired` : `Fired ${timeAgo(at, { days: true })}`;
};
</script>

<template>
    <RowGroup label="Rules">
        <template #info><RulesInfo /></template>

        <template v-for="rule in listed" :key="rule.id">
            <!-- Editing happens where the rule sits, so the list never loses the place you were looking at. -->
            <Row v-if="editingId === rule.id" icon="pencil" density="compact" :title="rule.label">
                <template #below>
                    <RuleForm :rule="rule" :disabled="settings === undefined" @save="saveDraft" @cancel="close" />
                </template>
            </Row>

            <Row v-else :icon="momentOf(rule.moment).icon" :title="rule.label" density="compact" :class="{ 'opacity-60': !rule.enabled }">
                <template #description>
                    <span class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span class="shrink-0 rounded bg-overlay px-1.5 py-0.5 text-2xs text-muted">{{ momentOf(rule.moment).label }}</span>
                        <span v-if="commandOf(rule) !== undefined" class="min-w-0 max-w-full truncate">
                            run <span class="font-mono text-content">{{ commandOf(rule) }}</span>
                        </span>
                        <span v-else-if="textOf(rule) !== undefined" class="min-w-0 max-w-full truncate">say: {{ textOf(rule) }}</span>
                        <span v-else-if="verdictOf(rule) !== undefined" class="min-w-0 max-w-full truncate">{{ verdictOf(rule) }}</span>
                        <!-- The narrowing, as the globs it is. Written out rather than summarised as "2 paths":
                             which paths is the whole question a reader has about a rule that has one. -->
                        <span v-if="(rule.when?.paths?.length ?? 0) > 0" class="flex min-w-0 flex-wrap items-center gap-1">
                            <span class="shrink-0">only when touching</span>
                            <span v-for="glob in rule.when?.paths" :key="glob" class="rounded bg-overlay px-1 py-px font-mono text-content">{{
                                glob
                            }}</span>
                        </span>
                    </span>
                </template>
                <template #meta>{{ firedOf(rule) }}</template>
                <template #control>
                    <div class="flex items-center gap-1">
                        <button
                            type="button"
                            :class="ui.iconButton()"
                            v-tooltip.bottom="`Rule actions`"
                            aria-label="Rule actions"
                            @click="openMenu($event, rule)"
                        >
                            <Icon name="bars" class="text-xs" />
                        </button>
                        <ToggleSwitch
                            :model-value="rule.enabled"
                            :disabled="settings === undefined"
                            :aria-label="`Enable ${rule.label}`"
                            @update:model-value="(value: boolean) => setEnabled(rule.id, value)"
                        />
                    </div>
                </template>
            </Row>
        </template>

        <!-- Same read, same rule as the skills list above it: an unanswered /settings has no rules to show and
             nothing true to say about their absence. -->
        <div v-if="settings === undefined" role="status" aria-busy="true">
            <template v-if="outline">
                <span class="sr-only">Reading this sandbox's rules…</span>
                <SkeletonRows :rows="2" density="compact" description control />
            </template>
        </div>
        <Row
            v-else-if="listed.length === 0 && !adding"
            icon="shield"
            density="compact"
            description="No custom rules added yet."
        />

        <Row v-if="adding" icon="plus" density="compact" title="New rule">
            <template #below>
                <RuleForm :disabled="settings === undefined" @save="saveDraft" @cancel="close" />
            </template>
        </Row>

        <!-- Hidden while a form is open, so there is only ever one rule being written at a time. -->
        <Row v-else-if="editingId === undefined" as="button" icon="plus" density="compact" interactive title="Add a rule" @click="startAdd" />
    </RowGroup>

    <ContextMenu ref="menu" :model="menuModel" :min-width="11" />
</template>
