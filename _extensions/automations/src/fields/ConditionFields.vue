<!-- What has to be true before a fire goes ahead, checked with no model: nothing, a command, a page, or a watch kind an extension declares (a package version, a release), drawn from its declaration; with what that check sees today, and whether it fires on every pass or only on a change. -->
<script setup lang="ts">
import type { FireOn, WatchCheckResult } from "@intentic/sandbox-contract/schemas/automations";
import { Button, CodeField, Icon, type IconName, InfoHint, SegmentedControl, ToggleSwitch, ui } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { glyph, useWatchKinds } from "../catalog";
import { useWatchCheck } from "../useAutomations";
import type { AutomationFormState, ConditionKind } from "../useAutomationForm";
import { t } from "../i18n.js";

const props = defineProps<{ state: AutomationFormState }>();
const { form, touched, markTouched, watchSource, watchKind, conditionError } = props.state;
const kinds = useWatchKinds();

// Chips rather than tabs: the kinds wrap on a phone, and the trigger's own tabs above are already the loud question.
// Nothing, a command and a page are the sandbox's own; every other chip is a watch kind an enabled extension declares,
// drawn from its declaration. A stored source naming a kind whose extension is off, or gone, keeps a chip of its own.
const CONDITION_OPTIONS = computed<readonly { value: ConditionKind; label: string; icon?: IconName | undefined }[]>(() => {
    const offered = kinds.value.filter((kind) => kind.enabled || kind.id === form.condition);
    const known = new Set([`none`, `guard`, `url`, ...offered.map((kind) => kind.id)]);
    return [
        { value: `none`, label: t(`automationFields.conditionNone`) },
        { value: `guard`, label: t(`automationFields.conditionGuard`), icon: `terminal` },
        ...offered.map((kind) => ({ value: kind.id, label: kind.label, icon: glyph(kind.icon) })),
        { value: `url`, label: t(`automationFields.conditionUrl`), icon: `globe` },
        ...(known.has(form.condition) ? [] : [{ value: form.condition, label: form.condition }]),
    ];
});
const conditionCaption = computed<string>(() => {
    switch (form.condition) {
        case `none`:
            return t(`automationFields.conditionCaption.none`);
        case `guard`:
            return t(`automationFields.conditionCaption.guard`);
        case `url`:
            return t(`automationFields.conditionCaption.url`);
        default:
            return watchKind.value?.description ?? ``;
    }
});
// A kind that is declared but whose extension is off: the watch fails, as an error on each run, until it is back.
const kindOff = computed(() => (watchKind.value !== undefined && !watchKind.value.enabled ? watchKind.value.extension : undefined));
const conditionShown = computed(() => touched.has(`condition`) && conditionError.value !== undefined);
const isSource = computed(() => form.condition !== `none` && form.condition !== `guard`);

// A contributed kind's boxes, kept per kind so flipping between kinds while deciding loses nothing typed.
const paramsHere = (): Record<string, string | boolean> => {
    const kind = form.condition;
    form.watchParams[kind] ??= {};
    return form.watchParams[kind];
};
const textOf = (key: string): string => {
    const value = form.watchParams[form.condition]?.[key];
    return value === undefined || value === true || value === false ? `` : value;
};
const switchOf = (key: string): boolean => form.watchParams[form.condition]?.[key] === true;
const setParam = (key: string, value: string | boolean): void => {
    paramsHere()[key] = value;
};
const typed = (event: Event): string => (event.target instanceof HTMLInputElement ? event.target.value : ``);

const FIRE_ON_OPTIONS = computed(
    () =>
        [
            { value: `pass`, label: t(`automationFields.everyPass`) },
            { value: `change`, label: t(`automationFields.onlyOnChange`) },
        ] as const satisfies readonly { value: FireOn; label: string }[],
);

// CHECK NOW: the source as it stands, run once by the daemon, nothing saved. The answer is kept beside the source it was
// for and shown only while the boxes still say the same thing, so an edited source never wears an old verdict.
const check = useWatchCheck();
type Checked = { readonly key: string; readonly result: WatchCheckResult } | { readonly key: string; readonly error: string };
const checked = ref<Checked>();
const sourceKey = computed(() => (watchSource.value === undefined ? undefined : JSON.stringify(watchSource.value)));
const shownCheck = computed(() => (checked.value !== undefined && checked.value.key === sourceKey.value ? checked.value : undefined));
const checkNow = async (): Promise<void> => {
    const source = watchSource.value;
    if (source === undefined) {
        markTouched(`condition`);
        return;
    }
    const key = JSON.stringify(source);
    try {
        checked.value = { key, result: await check.mutateAsync(source) };
    } catch (err) {
        checked.value = { key, error: err instanceof Error ? err.message : t(`automationFields.checkFailed`) };
    }
};
// What the verdict means for THIS watch: a pass fires on the next check, unless it fires only on a change, where the
// first check just notes what it sees.
const checkVerdict = (result: WatchCheckResult): string => {
    if (!result.pass) {
        return t(`automationFields.checkWaiting`);
    }
    return form.fireOn === `change` ? t(`automationFields.checkPassesChange`) : t(`automationFields.checkPassesFires`);
};
</script>

<template>
    <div class="@container flex flex-col gap-3">
        <div class="flex flex-wrap gap-1.5">
            <button
                v-for="option in CONDITION_OPTIONS"
                :key="option.value"
                type="button"
                :class="ui.chip({ on: form.condition === option.value })"
                :aria-pressed="form.condition === option.value"
                @click="form.condition = option.value"
            >
                <Icon v-if="option.icon" :name="option.icon" class="text-2xs" />
                {{ option.label }}
            </button>
        </div>
        <p class="text-2xs text-subtle">{{ conditionCaption }}</p>

        <!-- The block a command is read in, with a caret: a code block's own ground and rim, as the opened automation draws it. -->
        <CodeField
            v-if="form.condition === `guard`"
            v-model="form.guard"
            class="rounded-md border bg-canvas transition-colors hover:border-line-strong focus-within:border-line-strong"
            :class="conditionShown ? `border-danger` : `border-line`"
            lang="bash"
            rows="2"
            :placeholder="t(`automationFields.guardPlaceholder`)"
            :aria-label="t(`automationFields.guardCommand`)"
            @blur="markTouched(`condition`)"
        />

        <!-- A contributed kind's parameters, as its declaration names them: a box per text field, a switch per switch. -->
        <div v-if="watchKind !== undefined && watchKind.fields.length > 0" class="grid max-w-2xl gap-3 @2xl:grid-cols-2">
            <template v-for="field in watchKind.fields" :key="field.key">
                <label v-if="field.type === `switch`" class="flex items-center gap-2 self-end pb-2 text-xs text-content">
                    <ToggleSwitch :model-value="switchOf(field.key)" :aria-label="field.label" @update:model-value="setParam(field.key, $event)" />
                    {{ field.label }}
                    <InfoHint v-if="field.hint" :label="field.label" :text="field.hint" />
                </label>
                <label v-else class="ui-field min-w-0">
                    <span class="flex items-center gap-1 text-xs text-subtle">
                        {{ field.label }}
                        <InfoHint v-if="field.hint" :label="field.label" :text="field.hint" />
                    </span>
                    <input
                        :value="textOf(field.key)"
                        :placeholder="field.placeholder"
                        spellcheck="false"
                        :class="[ui.input(`font-mono`), conditionShown && field.required === true && textOf(field.key).trim() === `` ? `ui-field-error-box` : ``]"
                        @input="setParam(field.key, typed($event))"
                        @blur="markTouched(`condition`)"
                    />
                </label>
            </template>
        </div>
        <p v-if="kindOff !== undefined" class="flex items-start gap-1.5 text-xs text-warning">
            <Icon name="exclamation-triangle" class="shrink-0 text-2xs" />
            {{ t(`automationFields.kindOff`, { extension: kindOff }) }}
        </p>

        <template v-if="form.condition === `url`">
            <div class="grid max-w-2xl gap-3 @2xl:grid-cols-2">
                <label class="ui-field min-w-0">
                    <span class="text-xs text-subtle">{{ t(`automationFields.page`) }}</span>
                    <input
                        v-model="form.pageUrl"
                        type="url"
                        placeholder="https://example.com/status"
                        spellcheck="false"
                        :class="[ui.input(`font-mono`), conditionShown ? `ui-field-error-box` : ``]"
                        @blur="markTouched(`condition`)"
                    />
                </label>
                <label class="ui-field min-w-0">
                    <span class="text-xs text-subtle">{{ t(`automationFields.onlyWhatMatches`) }}</span>
                    <input
                        v-model="form.pageSelect"
                        placeholder="v(\d+\.\d+\.\d+)"
                        spellcheck="false"
                        :class="ui.input(`font-mono`)"
                        @blur="markTouched(`condition`)"
                    />
                </label>
            </div>
            <p class="text-2xs text-subtle">{{ t(`automationFields.pageCaption`) }}</p>
        </template>

        <span v-if="conditionShown" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ conditionError }}
        </span>

        <!-- CHECK NOW: what the watch would see today, before it is armed. Sources only: a guard command runs
             with the role's credentials, which nobody has approved for a preview. -->
        <div v-if="isSource" class="flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-2">
                <Button
                    size="small"
                    tier="boring"
                    :label="t(`automationFields.checkNow`)"
                    :loading="check.isPending.value"
                    @click="checkNow"
                >
                    <template #icon><Icon name="refresh" /></template>
                </Button>
                <span v-if="shownCheck === undefined" class="text-2xs text-subtle">{{ t(`automationFields.checkNowHint`) }}</span>
            </div>
            <div
                v-if="shownCheck !== undefined && `result` in shownCheck"
                class="flex flex-col gap-1 rounded-md border border-line bg-canvas px-3 py-2"
            >
                <span class="flex items-center gap-1.5 text-xs" :class="shownCheck.result.pass ? `text-success` : `text-muted`">
                    <Icon :name="shownCheck.result.pass ? `check-circle` : `clock`" class="text-2xs" />
                    {{ checkVerdict(shownCheck.result) }}
                </span>
                <pre class="max-h-32 overflow-auto font-mono text-2xs break-words whitespace-pre-wrap text-content">{{ shownCheck.result.saw }}</pre>
            </div>
            <p v-else-if="shownCheck !== undefined" class="flex items-start gap-1.5 text-xs text-danger">
                <Icon name="exclamation-triangle" class="shrink-0 text-2xs" />
                {{ shownCheck.error }}
            </p>
        </div>

        <!-- WHEN IT FIRES: every passing check, or only a change in what the check saw. Nothing to compare without a check. -->
        <template v-if="form.condition !== `none`">
            <div class="flex flex-wrap items-center gap-3 text-xs text-content">
                {{ t(`automationFields.fireOn`) }}
                <SegmentedControl v-model="form.fireOn" :options="FIRE_ON_OPTIONS" />
            </div>
            <p class="-mt-1 text-2xs text-subtle">
                {{ form.fireOn === `change` ? t(`automationFields.fireOnCaption.change`) : t(`automationFields.fireOnCaption.pass`) }}
            </p>
        </template>
    </div>
</template>
