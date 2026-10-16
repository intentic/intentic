<script setup lang="ts">
import { PRIVACY_RULES_MAX, type PersonalDataClass, type PrivacyRule, type PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import { Icon, Row, ui } from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { mintId, newRule, rulesOf, withoutRule, withRule, withRuleBack } from "./privacyOwn";
import PrivacyRuleEditor from "./PrivacyRuleEditor.vue";

// The owner's own rules: what only their data has (a customer number, a code name, an ID from another country), masked
// wherever it stands, as the kind they pick. Each is a row with its switch, opened in place to edit; a new one is a draft
// under the list until it is added. Every change is saved as it is made, handed up as a function of the policy as it
// stands then.

const t = useT();

const { policy, ready, kinds } = defineProps<{
    policy: PrivacyShieldPolicy | undefined;
    ready: boolean;
    /** Each kind's full name, as the page's checkboxes say it. */
    kinds: Readonly<Record<PersonalDataClass, string>>;
}>();

const emit = defineEmits<{ write: [change: (policy: PrivacyShieldPolicy) => PrivacyShieldPolicy] }>();

const rules = computed(() => rulesOf(policy));
const looked = computed(() => new Set(policy?.classes ?? []));

const rows = computed(() =>
    rules.value.map((rule) => ({
        rule,
        summary:
            rule.match === `pattern`
                ? rule.pattern
                : t(`sandbox.agentPrivacyShield.rule.termsCount`, { count: formatFixed(rule.terms.length, 0) }, rule.terms.length),
        masksAs: t(`sandbox.agentPrivacyShield.rule.masksAs`, { kind: kinds[rule.class] }),
        // A rule counts as the kind it masks as, so it is silent while that kind is not looked for.
        silenced: !looked.value.has(rule.class),
    })),
);

// One rule open at a time, under its own row; a new one is a draft until it is added.
const editing = ref<string | undefined>(undefined);
const draft = ref<PrivacyRule | undefined>(undefined);

const startDraft = (): void => {
    draft.value = newRule(mintId(`rule`, rules.value), t(`sandbox.agentPrivacyShield.rule.untitled`));
    editing.value = undefined;
    removed.value = undefined;
};

const add = (rule: PrivacyRule): void => {
    emit(`write`, (current) => withRule(current, rule));
    draft.value = undefined;
};

const writeRule = (id: string, next: PrivacyRule): void => {
    emit(`write`, (current) => (rulesOf(current).some((each) => each.id === id) ? withRule(current, next) : current));
};

const setOn = (id: string, on: boolean): void => {
    emit(`write`, (current) => {
        const rule = rulesOf(current).find((each) => each.id === id);
        return rule === undefined ? current : withRule(current, { ...rule, on });
    });
};

// The rule last removed, to put back where it stood.
const removed = ref<{ readonly rule: PrivacyRule; readonly index: number } | undefined>(undefined);
const remove = (rule: PrivacyRule): void => {
    removed.value = { rule, index: rules.value.findIndex((each) => each.id === rule.id) };
    editing.value = undefined;
    emit(`write`, (current) => withoutRule(current, rule.id));
};
const undo = (): void => {
    const back = removed.value;
    removed.value = undefined;
    if (back !== undefined) {
        emit(`write`, (current) => withRuleBack(current, back.rule, back.index));
    }
};
</script>

<template>
    <Row indent icon="filter" :title="t(`sandbox.agentPrivacyShield.rules`)" :description="t(`sandbox.agentPrivacyShield.rulesDescription`)">
        <template #below>
            <div class="flex flex-col gap-2" :class="{ 'pointer-events-none opacity-60': !ready }">
                <ul v-if="rows.length > 0" class="flex flex-col divide-y divide-line-subtle">
                    <li v-for="row in rows" :key="row.rule.id" class="flex flex-col gap-2 py-1.5">
                        <div class="flex items-center justify-between gap-x-4">
                            <button
                                type="button"
                                class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                :class="{ 'opacity-60': !row.rule.on }"
                                :aria-expanded="editing === row.rule.id"
                                :aria-label="t(`sandbox.agentPrivacyShield.rule.edit`, { rule: row.rule.title })"
                                @click="editing = editing === row.rule.id ? undefined : row.rule.id"
                            >
                                <Icon :name="editing === row.rule.id ? `chevron-down` : `chevron-right`" class="shrink-0 text-3xs text-subtle" />
                                <span class="min-w-0">
                                    <span class="flex items-baseline gap-1.5">
                                        <span class="truncate text-xs text-content">{{ row.rule.title }}</span>
                                        <span class="shrink-0 rounded bg-content/5 px-1.5 py-0.5 text-3xs text-subtle">{{
                                            row.rule.match === `pattern`
                                                ? t(`sandbox.agentPrivacyShield.rule.matchPattern`)
                                                : t(`sandbox.agentPrivacyShield.rule.matchTerms`)
                                        }}</span>
                                    </span>
                                    <span class="flex min-w-0 items-baseline gap-1.5 text-2xs text-muted">
                                        <span class="truncate" :class="{ 'font-mono': row.rule.match === `pattern` }">{{ row.summary }}</span>
                                        <span class="shrink-0">· {{ row.masksAs }}</span>
                                    </span>
                                    <span v-if="row.silenced" class="block text-2xs text-warning">{{
                                        t(`sandbox.agentPrivacyShield.rule.offByKind`, { kind: kinds[row.rule.class] })
                                    }}</span>
                                </span>
                            </button>
                            <ToggleSwitch
                                :model-value="row.rule.on"
                                :disabled="!ready"
                                :aria-label="t(`sandbox.agentPrivacyShield.rule.on`, { rule: row.rule.title })"
                                @update:model-value="(on: boolean) => setOn(row.rule.id, on)"
                            />
                        </div>
                        <PrivacyRuleEditor
                            v-if="editing === row.rule.id"
                            :rule="row.rule"
                            :ready="ready"
                            :kinds="kinds"
                            @save="(next) => writeRule(row.rule.id, next)"
                            @remove="remove(row.rule)"
                        />
                    </li>
                </ul>
                <p v-else-if="draft === undefined" class="text-2xs text-subtle">{{ t(`sandbox.agentPrivacyShield.rulesEmpty`) }}</p>

                <PrivacyRuleEditor
                    v-if="draft !== undefined"
                    :rule="draft"
                    draft
                    :ready="ready"
                    :kinds="kinds"
                    @save="add"
                    @cancel="draft = undefined"
                />

                <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <button
                        v-if="draft === undefined && rules.length < PRIVACY_RULES_MAX"
                        type="button"
                        :class="ui.textButton({ size: `xs`, flush: true })"
                        @click="startDraft"
                    >
                        <Icon name="plus" class="text-3xs" />{{ t(`sandbox.agentPrivacyShield.rulesAdd`) }}
                    </button>
                    <span v-if="removed !== undefined" aria-live="polite" class="flex items-baseline gap-1.5 text-2xs">
                        <span class="text-muted">{{ t(`sandbox.agentPrivacyShield.rulesRemoved`, { rule: removed.rule.title }) }}</span>
                        <button type="button" :class="ui.textButton({ size: `xs`, flush: true })" @click="undo">{{ t(`ui.action.undo`) }}</button>
                    </span>
                </div>
            </div>
        </template>
    </Row>
</template>
