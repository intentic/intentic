<script setup lang="ts">
import type { Rule } from "@intentic/api-contract";
import { ui, ContextMenu, Icon, Row, RowGroup, SkeletonRows, timeAgo } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useRules } from "../../environment/useRules";
import { useSandboxOutline } from "../../overview/useSandboxOutline";
import RuleCommand from "./RuleCommand.vue";
import RuleForm from "./RuleForm.vue";
import RulesInfo from "./RulesInfo.vue";
import { momentOf, type RuleDraft } from "./ruleWords";

// Every standing instruction without a row of its own above. A rule is a sentence (moment, condition, action) from one
// shared vocabulary (ruleWords.ts), same as RuleForm; a row typesets that sentence instead of one grey paragraph.
// Editing keeps the rule's id, so history and firing stamps don't orphan.

const { settings, listed, firings, upsert, remove, setEnabled, move, freeId } = useRules();
const outline = useSandboxOutline(computed(() => settings.value === undefined));

// Which row is a form: a rule's id while editing, undefined otherwise; `adding` is its own flag.
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

// Keeps the existing id and `enabled` on edit, so a relabel doesn't orphan its history or silently re-enable a disabled
// rule.
const saveDraft = (draft: RuleDraft): void => {
    const existing = editing.value;
    upsert({ id: existing?.id ?? freeId(draft.label), enabled: existing?.enabled ?? true, ...draft });
    close();
};

// One menu instance for the whole list, not one per row; forty overlays would be forty too many.
const menu = ref<InstanceType<typeof ContextMenu>>();
const menuFor = ref<Rule | undefined>();

const openMenu = (event: Event, rule: Rule): void => {
    menuFor.value = rule;
    menu.value?.show(event);
};

// Move up/down disable at the ends rather than disappearing: a vanished menu item reads as a bug.
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

// The tail of the sentence, split by kind so each renders in its own style: a command as code, an instruction as words.
const commandOf = (rule: Rule): string | undefined => (rule.action.kind === `command` ? rule.action.command : undefined);
const textOf = (rule: Rule): string | undefined => (rule.action.kind === `instruct` ? rule.action.text : undefined);
const verdictOf = (rule: Rule): string | undefined =>
    rule.action.kind === `verdict` ? (rule.action.verdict === `allow` ? `land the work` : `hold the work on its branch`) : undefined;

// "Never fired" is worth reading: a rule that never fired is either wrong or aimed at something that hasn't happened
// yet.
const firedOf = (rule: Rule): string => {
    const at = firings.value[rule.id];
    return at === undefined ? `Never fired` : `Fired ${timeAgo(at, { days: true })}`;
};
</script>

<template>
    <RowGroup label="Rules">
        <template #info><RulesInfo /></template>

        <template v-for="rule in listed" :key="rule.id">
            <!-- Editing happens in place, so the list doesn't lose your position. -->
            <Row v-if="editingId === rule.id" icon="pencil" :title="rule.label">
                <template #below>
                    <RuleForm :rule="rule" :disabled="settings === undefined" @save="saveDraft" @cancel="close" />
                </template>
            </Row>

            <Row v-else :icon="momentOf(rule.moment).icon" :title="rule.label" :class="{ 'opacity-60': !rule.enabled }">
                <template #description>
                    <span class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-2xs">
                        <span class="inline-flex shrink-0 items-center rounded border border-line-subtle bg-overlay px-2 py-0.5 font-medium text-muted">
                            {{ momentOf(rule.moment).label }}
                        </span>
                        <span v-if="commandOf(rule) !== undefined" class="inline-flex min-w-0 max-w-full items-center gap-1.5">
                            <span class="shrink-0 text-subtle">run</span>
                            <span class="min-w-0 max-w-full truncate rounded border border-line-subtle bg-canvas/80 px-2 py-0.5">
                                <RuleCommand :command="commandOf(rule)!" />
                            </span>
                        </span>
                        <span v-else-if="textOf(rule) !== undefined" class="min-w-0 max-w-full truncate text-muted">
                            <span class="text-subtle">say:</span> {{ textOf(rule) }}
                        </span>
                        <span v-else-if="verdictOf(rule) !== undefined" class="min-w-0 max-w-full truncate font-medium text-content">
                            {{ verdictOf(rule) }}
                        </span>
                        <!-- Paths shown as their globs, not a count: which paths is the whole question a reader has. -->
                        <span v-if="(rule.when?.paths?.length ?? 0) > 0" class="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5 text-muted">
                            <span class="shrink-0 text-subtle">only when touching</span>
                            <span
                                v-for="glob in rule.when?.paths"
                                :key="glob"
                                class="max-w-48 truncate rounded border border-line-subtle bg-overlay px-2 py-0.5 font-mono text-content"
                                :title="glob"
                            >
                                {{ glob }}
                            </span>
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

        <!-- Same skeleton rule as the skills list above: nothing true to say while settings are unread. -->
        <div v-if="settings === undefined" role="status" aria-busy="true">
            <template v-if="outline">
                <span class="sr-only">Reading this sandbox's rules…</span>
                <SkeletonRows :rows="2" description control />
            </template>
        </div>
        <Row v-else-if="listed.length === 0 && !adding" icon="shield" description="No custom rules added yet." />

        <Row v-if="adding" icon="plus" title="New rule">
            <template #below>
                <RuleForm :disabled="settings === undefined" @save="saveDraft" @cancel="close" />
            </template>
        </Row>

        <!-- Hidden while a form is open, so only one rule is being written at a time. -->
        <Row v-else-if="editingId === undefined" as="button" icon="plus" interactive title="Add a rule" @click="startAdd" />
    </RowGroup>

    <ContextMenu ref="menu" :model="menuModel" :min-width="11" />
</template>
