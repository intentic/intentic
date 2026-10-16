<script setup lang="ts">
import {
    PERSONAL_DATA_CLASSES,
    PRIVACY_PATTERN_MAX,
    PRIVACY_TITLE_MAX,
    type PersonalDataClass,
    type PrivacyRule,
    type PrivacyRuleMatch,
} from "@intentic/sandbox-contract/schemas/privacy";
import { Button, Picker, SegmentedControl, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Checkbox from "primevue/checkbox";
import { computed, onMounted, ref, useTemplateRef, watch } from "vue";
import { type RuleProblem, ruleProblem, TERM_LIMITS } from "./privacyOwn";
import PrivacyValueList from "./PrivacyValueList.vue";

// One of the owner's own rules, opened in place: its name, whether it matches words and phrases or a pattern, what it
// masks them as, and the words or the pattern. A rule already saved is saved again on every change that leaves it able
// to run (a pattern when its field is left, a name the same); one that cannot run yet is held here with the reason said
// beside it. A new rule is a draft until Add is pressed.

const t = useT();

const {
    rule,
    draft = false,
    ready,
    kinds,
} = defineProps<{
    rule: PrivacyRule;
    /** A rule not saved yet: changes stay here until Add. */
    draft?: boolean;
    ready: boolean;
    /** Each kind's full name, as the page's checkboxes say it. */
    kinds: Readonly<Record<PersonalDataClass, string>>;
}>();

const emit = defineEmits<{
    save: [rule: PrivacyRule];
    remove: [];
    cancel: [];
}>();

// What is on screen, which may run ahead of what is saved.
const local = ref<PrivacyRule>({ ...rule });
// Taken again only when what is saved changed, so another write to the policy does not wipe what is being typed.
watch(
    () => JSON.stringify(rule),
    () => {
        local.value = { ...rule };
    },
);

const problem = computed<RuleProblem | undefined>(() => ruleProblem(local.value, draft ? undefined : rule));

// A saved rule takes each change that leaves it able to run; anything else waits on screen with its reason.
const commit = (change: (current: PrivacyRule) => PrivacyRule): void => {
    local.value = change(local.value);
    if (!draft && problem.value === undefined && JSON.stringify(local.value) !== JSON.stringify(rule)) {
        emit(`save`, local.value);
    }
};

const MATCHES = computed(() => [
    { label: t(`sandbox.agentPrivacyShield.rule.matchTerms`), value: `terms` as const },
    { label: t(`sandbox.agentPrivacyShield.rule.matchPattern`), value: `pattern` as const },
]);

const KIND_OPTIONS = computed(() => PERSONAL_DATA_CLASSES.map((kind) => ({ value: kind, label: kinds[kind] })));

const PROBLEMS = computed(
    () =>
        ({
            noTitle: t(`sandbox.agentPrivacyShield.rule.problems.noTitle`),
            noTerms: t(`sandbox.agentPrivacyShield.rule.problems.noTerms`),
            invalid: t(`sandbox.agentPrivacyShield.rule.problems.invalid`),
            tooLong: t(`sandbox.agentPrivacyShield.rule.problems.tooLong`, { max: PRIVACY_PATTERN_MAX }),
            empty: t(`sandbox.agentPrivacyShield.rule.problems.empty`),
            nested: t(`sandbox.agentPrivacyShield.rule.problems.nested`),
        }) satisfies Record<RuleProblem, string>,
);
// Said once there is something to say it about: a draft's empty name or list is where it starts, not a mistake.
const shownProblem = computed(() => {
    const current = problem.value;
    if (current === undefined || (draft && (current === `noTitle` || current === `noTerms`))) {
        return undefined;
    }
    return current === `empty` && local.value.pattern === `` ? undefined : PROBLEMS.value[current];
});

const termLabels = computed(() => ({
    field: t(`sandbox.agentPrivacyShield.rule.termsField`),
    placeholder: t(`sandbox.agentPrivacyShield.rule.termsPlaceholder`),
    empty: t(`sandbox.agentPrivacyShield.rule.termsEmpty`),
    hint: t(`sandbox.agentPrivacyShield.rule.termsHint`),
}));

// A new rule starts at its name, selected, so typing replaces the placeholder name at once.
const name = useTemplateRef<HTMLInputElement>(`name`);
onMounted(() => {
    if (draft) {
        name.value?.select();
    }
});

// An example in the field, shown as written rather than translated.
const PATTERN_EXAMPLE = String.raw`EMP-\d{6}`;
const VALUE_GROUP = `(?<value>…)`;
</script>

<template>
    <!-- No frame of its own: it hangs under the row's title, inside the card the section already is. The words or the
         pattern are the one boxed field; the name reads as the row's title, typed in place. -->
    <div class="flex flex-col gap-2.5 pb-1 pl-4" :class="{ 'pointer-events-none opacity-60': !ready }">
        <input
            ref="name"
            :value="local.title"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :maxlength="PRIVACY_TITLE_MAX"
            :aria-label="t(`sandbox.agentPrivacyShield.rule.titleField`)"
            :placeholder="t(`sandbox.agentPrivacyShield.rule.titleField`)"
            class="field-bare -mx-1 w-full rounded px-1 py-0.5 text-xs font-medium text-content hover:bg-content/5"
            @input="local = { ...local, title: ($event.target as HTMLInputElement).value }"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            @blur="commit((current) => ({ ...current, title: current.title.trim() }))"
        />

        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <SegmentedControl
                :model-value="local.match"
                :options="MATCHES"
                size="xs"
                @update:model-value="(match: PrivacyRuleMatch) => commit((current) => ({ ...current, match }))"
            />
            <label class="flex items-center gap-2 text-2xs text-muted">
                <span>{{ t(`sandbox.agentPrivacyShield.rule.maskAs`) }}</span>
                <Picker
                    :model-value="local.class"
                    :options="KIND_OPTIONS"
                    variant="ghost"
                    :aria-label="t(`sandbox.agentPrivacyShield.rule.maskAs`)"
                    :header="t(`sandbox.agentPrivacyShield.rule.maskAs`)"
                    @update:model-value="
                        (kind: PersonalDataClass | undefined) => kind !== undefined && commit((current) => ({ ...current, class: kind }))
                    "
                />
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-2xs text-muted">
                <Checkbox
                    :model-value="local.matchCase"
                    binary
                    size="small"
                    @update:model-value="(on: unknown) => commit((current) => ({ ...current, matchCase: on === true }))"
                />
                <span>{{ t(`sandbox.agentPrivacyShield.rule.matchCase`) }}</span>
            </label>
        </div>

        <PrivacyValueList
            v-if="local.match === `terms`"
            :values="local.terms"
            :ready="ready"
            :limits="TERM_LIMITS"
            :labels="termLabels"
            @write="(change) => commit((current) => ({ ...current, terms: change(current.terms) }))"
        />

        <div v-else class="flex flex-col gap-1.5">
            <input
                :value="local.pattern"
                type="text"
                autocomplete="off"
                spellcheck="false"
                :maxlength="PRIVACY_PATTERN_MAX"
                :aria-label="t(`sandbox.agentPrivacyShield.rule.patternField`)"
                :placeholder="PATTERN_EXAMPLE"
                :class="ui.input({ size: `sm` }, `w-full font-mono`)"
                @input="local = { ...local, pattern: ($event.target as HTMLInputElement).value }"
                @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
                @blur="commit((current) => current)"
            />
            <p class="text-2xs text-subtle">
                <i18n-t keypath="sandbox.agentPrivacyShield.rule.patternHint" tag="span" scope="global">
                    <template #group
                        ><code class="ui-code whitespace-nowrap">{{ VALUE_GROUP }}</code></template
                    >
                </i18n-t>
            </p>
        </div>

        <p v-if="shownProblem !== undefined" aria-live="polite" class="text-2xs text-danger">{{ shownProblem }}</p>

        <div class="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
            <template v-if="draft">
                <button type="button" :class="ui.textButton({ size: `xs`, tone: `quiet`, flush: true })" @click="emit(`cancel`)">
                    {{ t(`ui.action.cancel`) }}
                </button>
                <Button size="small" tier="accent" :disabled="problem !== undefined" @click="emit(`save`, { ...local, title: local.title.trim() })">{{
                    t(`sandbox.agentPrivacyShield.rule.add`)
                }}</Button>
            </template>
            <button v-else type="button" :class="ui.textButton({ size: `xs`, tone: `danger`, flush: true })" @click="emit(`remove`)">
                {{ t(`sandbox.agentPrivacyShield.rule.remove`) }}
            </button>
        </div>
    </div>
</template>
