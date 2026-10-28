<!-- What has to be true before a fire goes ahead, checked with no model: nothing, a command, or a check the sandbox makes itself (a package version, a release, a page); with what that check sees today, and whether it fires on every pass or only on a change. -->
<script setup lang="ts">
import type { FireOn, WatchCheckResult } from "@intentic/sandbox-contract/schemas/automations";
import { Button, CodeField, Icon, type IconName, SegmentedControl, ToggleSwitch, ui } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { useWatchCheck } from "../useAutomations";
import type { AutomationFormState, ConditionKind } from "../useAutomationForm";
import { t } from "../i18n.js";

const props = defineProps<{ state: AutomationFormState }>();
const { form, touched, markTouched, watchSource, conditionError } = props.state;

// Chips rather than tabs: five kinds wrap on a phone, and the trigger's own tabs above are already the loud question.
const CONDITION_OPTIONS = computed<readonly { value: ConditionKind; label: string; icon?: IconName }[]>(() => [
    { value: `none`, label: t(`automationFields.conditionNone`) },
    { value: `guard`, label: t(`automationFields.conditionGuard`), icon: `terminal` },
    { value: `npm`, label: t(`automationFields.conditionNpm`), icon: `box` },
    { value: `github-release`, label: t(`automationFields.conditionGithub`), icon: `github` },
    { value: `url`, label: t(`automationFields.conditionUrl`), icon: `globe` },
]);
const conditionCaption = (condition: ConditionKind): string =>
    ({
        none: t(`automationFields.conditionCaption.none`),
        guard: t(`automationFields.conditionCaption.guard`),
        npm: t(`automationFields.conditionCaption.npm`),
        "github-release": t(`automationFields.conditionCaption.github`),
        url: t(`automationFields.conditionCaption.url`),
    })[condition];
const conditionShown = computed(() => touched.has(`condition`) && conditionError.value !== undefined);
const isSource = computed(() => form.condition === `npm` || form.condition === `github-release` || form.condition === `url`);

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
        <p class="text-2xs text-subtle">{{ conditionCaption(form.condition) }}</p>

        <!-- The block a command is read in, with a caret: a code block's own ground and rim, as the opened automation draws it. -->
        <div
            v-if="form.condition === `guard`"
            class="rounded-md border bg-canvas transition-colors hover:border-line-strong focus-within:border-line-strong"
            :class="conditionShown ? `border-danger` : `border-line`"
        >
            <CodeField
                v-model="form.guard"
                lang="bash"
                rows="2"
                :placeholder="t(`automationFields.guardPlaceholder`)"
                :aria-label="t(`automationFields.guardCommand`)"
                @blur="markTouched(`condition`)"
            />
        </div>

        <template v-if="form.condition === `npm`">
            <div class="flex flex-wrap gap-1.5">
                <button
                    type="button"
                    :class="ui.chip({ on: form.npmBy === `range` })"
                    :aria-pressed="form.npmBy === `range`"
                    @click="form.npmBy = `range`"
                >
                    {{ t(`automationFields.waitForVersion`) }}
                </button>
                <button
                    type="button"
                    :class="ui.chip({ on: form.npmBy === `tag` })"
                    :aria-pressed="form.npmBy === `tag`"
                    @click="form.npmBy = `tag`"
                >
                    {{ t(`automationFields.followTag`) }}
                </button>
            </div>
            <div class="grid max-w-2xl gap-3 @2xl:grid-cols-2">
                <label class="ui-field min-w-0">
                    <span class="text-xs text-subtle">{{ t(`automationFields.package`) }}</span>
                    <input
                        v-model="form.npmPackage"
                        placeholder="bun"
                        spellcheck="false"
                        :class="[ui.input(`font-mono`), conditionShown && form.npmPackage.trim() === `` ? `ui-field-error-box` : ``]"
                        @blur="markTouched(`condition`)"
                    />
                </label>
                <label v-if="form.npmBy === `range`" class="ui-field min-w-0">
                    <span class="text-xs text-subtle">{{ t(`automationFields.versionRange`) }}</span>
                    <input
                        v-model="form.npmRange"
                        placeholder=">=1.4.3"
                        spellcheck="false"
                        :class="[ui.input(`font-mono`), conditionShown && form.npmRange.trim() === `` ? `ui-field-error-box` : ``]"
                        @blur="markTouched(`condition`)"
                    />
                </label>
                <label v-else class="ui-field min-w-0">
                    <span class="text-xs text-subtle">{{ t(`automationFields.distTag`) }}</span>
                    <input v-model="form.npmTag" :placeholder="t(`automationFields.tagPlaceholder`)" spellcheck="false" :class="ui.input(`font-mono`)" />
                </label>
            </div>
            <p class="text-2xs text-subtle">
                {{ form.npmBy === `range` ? t(`automationFields.npmCaption.range`) : t(`automationFields.npmCaption.tag`) }}
            </p>
        </template>

        <div v-if="form.condition === `github-release`" class="flex flex-wrap items-end gap-x-6 gap-y-2">
            <label class="ui-field w-full min-w-0 max-w-sm">
                <span class="text-xs text-subtle">{{ t(`automationFields.repository`) }}</span>
                <input
                    v-model="form.githubRepo"
                    placeholder="oven-sh/bun"
                    spellcheck="false"
                    :class="[ui.input(`font-mono`), conditionShown ? `ui-field-error-box` : ``]"
                    @blur="markTouched(`condition`)"
                />
            </label>
            <label class="flex items-center gap-2 pb-2 text-xs text-content">
                <ToggleSwitch v-model="form.githubPrereleases" :aria-label="t(`automationFields.prereleasesToo`)" />
                {{ t(`automationFields.prereleasesToo`) }}
            </label>
        </div>

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
             with the persona's credentials, which nobody has approved for a preview. -->
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
                <span>{{ t(`automationFields.fireOn`) }}</span>
                <SegmentedControl v-model="form.fireOn" :options="FIRE_ON_OPTIONS" />
            </div>
            <p class="-mt-1 text-2xs text-subtle">
                {{ form.fireOn === `change` ? t(`automationFields.fireOnCaption.change`) : t(`automationFields.fireOnCaption.pass`) }}
            </p>
        </template>
    </div>
</template>
