<!-- Where a Visitor chat is embedded and who may use it: its sites, its door, its bot check, its greeting and disclosure, and its daily ceiling. -->
<script setup lang="ts">
import { WEBCHAT_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract/schemas/automations";
import { Icon, ToggleSwitch, ui } from "@intentic/extension-ui";
import { computed } from "vue";
import type { AutomationFormState } from "../useAutomationForm";
import { t } from "../i18n.js";

const props = defineProps<{ state: AutomationFormState }>();
const { form, touched, markTouched, originsError } = props.state;

const ACCESS_OPTIONS = computed(
    () =>
        [
            { value: `public`, label: t(`automationFields.anyone`) },
            { value: `google`, label: t(`automationFields.googleSignIn`) },
        ] as const,
);
const ANTI_BOT_OPTIONS = computed(
    () =>
        [
            { value: `pow`, label: t(`automationFields.builtInCheck`) },
            { value: `turnstile`, label: t(`automationFields.cloudflareTurnstile`) },
            { value: `off`, label: t(`automationFields.off`) },
        ] as const,
);
</script>

<template>
            <div class="@container"><div class="grid gap-3 @2xl:grid-cols-2">
            <label class="ui-field @2xl:col-span-2">
                <span class="text-xs text-subtle">{{ t(`automationFields.allowedSites`) }}</span>
                <textarea
                    v-model="form.origins"
                    rows="2"
                    placeholder="https://example.com&#10;https://www.example.com"
                    class="font-mono"
                    :class="[ui.input(), touched.has('origins') && originsError ? 'ui-field-error-box' : '']"
                    @blur="markTouched('origins')"
                ></textarea>
                <span v-if="touched.has('origins') && originsError" class="ui-field-error">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    {{ originsError }}
                </span>
                <p v-else class="text-2xs text-subtle">{{ t(`automationFields.onePerLineScheme`) }}</p>
            </label>
            <div class="ui-field">
                <span class="text-xs text-subtle">{{ t(`automationFields.whoChat`) }}</span>
                <div class="flex flex-wrap gap-1.5">
                    <button
                        v-for="option in ACCESS_OPTIONS"
                        :key="option.value"
                        type="button"
                        :class="ui.chip({ on: form.access === option.value })"
                        :aria-pressed="form.access === option.value"
                        @click="form.access = option.value"
                    >
                        {{ option.label }}
                    </button>
                </div>
            </div>
            <div class="ui-field">
                <span class="text-xs text-subtle">{{ t(`automationFields.botCheck`) }}</span>
                <div class="flex flex-wrap gap-1.5">
                    <button
                        v-for="option in ANTI_BOT_OPTIONS"
                        :key="option.value"
                        type="button"
                        :class="ui.chip({ on: form.antiBot === option.value })"
                        :aria-pressed="form.antiBot === option.value"
                        @click="form.antiBot = option.value"
                    >
                        {{ option.label }}
                    </button>
                </div>
                <p class="text-2xs text-subtle">
                    <template v-if="form.antiBot === 'pow'">{{ t(`automationFields.aboutSecondEachVisitors`) }}</template>
                    <template v-else-if="form.antiBot === 'turnstile'">{{ t(`automationFields.invisibleMostVisitorsNeeds`) }}</template>
                    <template v-else>{{ t(`automationFields.onlyAllowedSitesDaily`) }}</template>
                </p>
            </div>
            <label v-if="form.access === 'google'" class="ui-field">
                <span class="text-xs text-subtle">{{ t(`automationFields.googleClientId`) }}</span>
                <input
                    v-model="form.googleClientId"
                    placeholder="1234-abc.apps.googleusercontent.com"
                    class="font-mono"
                    :class="ui.input()"
                />
                <p class="text-2xs text-subtle">{{ t(`automationFields.sitesOwnOauthClient`) }}</p>
            </label>
            <template v-if="form.antiBot === 'turnstile'">
                <label class="ui-field">
                    <span class="text-xs text-subtle">{{ t(`automationFields.turnstileSiteKey`) }}</span>
                    <input
                        v-model="form.turnstileSiteKey"
                        :placeholder="t(`automationFields.n0x4aaa`)"
                        class="font-mono"
                        :class="ui.input()"
                    />
                </label>
                <label class="ui-field">
                    <span class="text-xs text-subtle">{{ t(`automationFields.turnstileSecretKey`) }}</span>
                    <input
                        v-model="form.turnstileSecret"
                        type="password"
                        :placeholder="t(`automationFields.n0x4aaa`)"
                        class="font-mono"
                        :class="ui.input()"
                    />
                    <p class="text-2xs text-subtle">{{ t(`automationFields.staysInSandboxOnly`) }}</p>
                </label>
            </template>
            <label class="ui-field">
                <span class="text-xs text-subtle">{{ t(`automationFields.greetingOptional`) }}</span>
                <input v-model="form.greeting" :placeholder="t(`automationFields.hiAskMeAnything`)" :class="ui.input()" />
            </label>
            <label class="flex items-center gap-2 text-sm">
                <input v-model="form.aiDisclosure" type="checkbox" />
                {{ t(`automationFields.aiDisclosure`) }}
            </label>
            <label v-if="form.aiDisclosure" class="ui-field">
                <span class="text-xs text-subtle">{{ t(`automationFields.aiDisclosureText`) }}</span>
                <input v-model="form.aiDisclosureText" maxlength="300" :placeholder="t(`automationFields.aiDisclosureDefault`)" :class="ui.input()" />
            </label>
            <label class="ui-field">
                <span class="text-xs text-subtle">{{ t(`automationFields.dailyMessageLimit`) }}</span>
                <input
                    v-model="form.dailyMessageMax"
                    type="number"
                    min="1"
                    :placeholder="String(WEBCHAT_DAILY_MAX_DEFAULT)"
                    :class="ui.input()"
                />
                <p class="text-2xs text-subtle">
                    {{ t(`automationFields.eachMessageRunsAgent`, { webchat_daily_max_default: WEBCHAT_DAILY_MAX_DEFAULT }) }}
                </p>
            </label>
        </div></div>
</template>
