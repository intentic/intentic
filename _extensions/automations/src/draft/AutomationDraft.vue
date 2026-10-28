<!-- A new automation, drawn as the open row it will become: its name and note written in its head, then the same document and column of settings an opened automation has, each value changed where it is read. Nothing is sent until Create. -->
<script setup lang="ts">
import type { Automation, AutomationSummary, AutomationTemplate, Trigger } from "@intentic/sandbox-contract/schemas/automations";
import { ModelPinSchema } from "@intentic/sandbox-contract/schemas/agent";
import { localZone, zoneLabel } from "@intentic/sandbox-contract/time";
import {
    Button,
    CopyButton,
    DisclosureRow,
    Icon,
    type IconName,
    MarkdownDocument,
    Notice,
    noticeOf,
    RowGroup,
    Section,
    ui,
} from "@intentic/extension-ui";
import { computed, nextTick, onMounted, ref } from "vue";
import AutomationFields from "../AutomationFields.vue";
import { availableTemplates, type AvailableSource } from "../catalog";
import { localInputOf } from "../cronSchedule";
import ConditionFields from "../fields/ConditionFields.vue";
import VisitorChatFields from "../fields/VisitorChatFields.vue";
import { host } from "../host";
import { usePersonaDefault } from "../persona/usePersonaDefault";
import GateProperty from "../properties/GateProperty.vue";
import GroupProperty from "../properties/GroupProperty.vue";
import ModelProperty from "../properties/ModelProperty.vue";
import PersonaProperty from "../properties/PersonaProperty.vue";
import ServiceProperty from "../properties/ServiceProperty.vue";
import { type AutomationChange, provideDraftWriter } from "../properties/useAutomationPatch";
import { embedSnippet, useAutomations, useSandboxZone, webhookUrl } from "../useAutomations";
import { triggerKey, useAutomationForm } from "../useAutomationForm";
import EndsProperty from "./EndsProperty.vue";
import TemplatePicker from "./TemplatePicker.vue";
import ThenProperty from "./ThenProperty.vue";
import WhenProperty from "./WhenProperty.vue";
import { t } from "../i18n.js";

const { prefill, at, listenerSources, templates } = defineProps<{
    prefill?: AutomationTemplate;
    /** A moment picked on the calendar: the draft opens as a one-time wake there. */
    at?: number;
    listenerSources: readonly AvailableSource[];
    templates: readonly AutomationTemplate[];
}>();
const emit = defineEmits<{ created: [id: string]; close: [] }>();

const { automations, save } = useAutomations();
const sandboxZone = useSandboxZone();
const state = useAutomationForm(
    computed(() => listenerSources),
    computed(() => templates),
    sandboxZone,
);
const { form, touched, markTouched, touchAll, valid, build, loadTemplate, isVisitorChat, retireOffered, targetsOffered, needsModels, effectiveTarget } = state;
// Who a new automation acts as follows its trigger until the picker is touched: Full access for a plain schedule, No
// accounts for anything that brings outside words in.
usePersonaDefault(form, touched);

// It starts on the model this sandbox gives automations, said in its column like any other value, rather than on a blank
// that refuses Create until somebody finds the picker.
const seedModel = (): void => {
    if (form.models.length > 0) {
        return;
    }
    const start = host().models.agentRun(`automation`);
    const pin = ModelPinSchema.safeParse({
        provider: start.provider,
        model: start.model,
        effort: start.effort,
        thinking: start.thinking,
        fast: start.fast,
        harness: start.harness,
    });
    if (pin.success) {
        form.models = [pin.data];
        form.account = start.account ?? ``;
    }
};

// A moment clicked on the calendar: a one-time wake there, on the clock it was clicked on (the reader's).
if (at !== undefined) {
    const local = localInputOf(at);
    form.kind = `once`;
    form.onceAt = local;
    state.schedule.time = local.slice(11, 16);
    state.schedule.days = [new Date(at).getDay()];
    if (zoneLabel(sandboxZone.value, localZone()) !== undefined) {
        form.tz = localZone();
    }
}

/* ---- templates ---- */

const capabilities = computed(() => host().workspace.capabilities());
// Templates needing nothing show always; others once a capability they name is connected.
const recipes = computed(() => availableTemplates(templates, capabilities.value));
const picked = ref<AutomationTemplate | undefined>(undefined);
// The pick, held only while its trigger still matches the draft's.
const template = computed(() => (picked.value !== undefined && triggerKey(picked.value.trigger) === state.triggerKey.value ? picked.value : undefined));
const pickTemplate = (recipe: AutomationTemplate): void => {
    picked.value = recipe;
    loadTemplate(recipe);
    seedModel();
};
if (prefill === undefined) {
    seedModel();
} else {
    pickTemplate(prefill);
}

/* ---- the settings column: the opened automation's own components, writing into this draft ---- */

// The draft as the record it would save, for the components that read one.
const summary = computed<AutomationSummary>(() => ({ ...build(), runs: [] }));
const samePins = (a: Automation[`models`], b: Automation[`models`]): boolean => JSON.stringify(a) === JSON.stringify(b);
// A change those components make, read back into the form field by field: only what they can change.
const write = (change: AutomationChange): void => {
    const before: Automation = build();
    const next = change(build());
    if (next.actsAs !== before.actsAs) {
        form.actsAs = next.actsAs ?? ``;
        markTouched(`actsAs`);
    }
    if (next.runAs !== before.runAs) {
        form.runAs = next.runAs ?? ``;
    }
    if (!samePins(next.models, before.models)) {
        form.models = (next.models ?? []).map((pin) => ({ ...pin }));
    }
    if (next.account !== before.account) {
        form.account = next.account ?? ``;
    }
    form.requireApproval = next.requireApproval === true;
    form.holdForSeconds = next.holdForSeconds ?? 0;
    if (next.group !== before.group) {
        form.group = next.group ?? ``;
    }
};
provideDraftWriter(write);

// Who it acts as matters wherever something runs: a new agent, or a check command run with that persona's credentials.
const personaShown = computed(() => needsModels.value || form.condition === `guard`);

/* ---- its head ---- */

const TRIGGER_ICON = { schedule: `clock`, once: `pin`, event: `bolt`, listener: `wifi`, workspace: `eye` } as const satisfies Record<Trigger[`kind`], IconName>;
const nameInput = ref<HTMLInputElement>();
// Opens on its name: pressing New automation already said what comes next.
onMounted(() => nameInput.value?.focus({ preventScroll: true }));
const nameShown = computed(() => (touched.has(`name`) ? state.nameError.value : undefined));

/* ---- creating it ---- */

const mode = ref<`draft` | `settings`>(`draft`);
const submitError = ref<string | undefined>(undefined);
const shaking = ref(false);
// What still stands between the draft and Create, said in one line beside the press once somebody has pressed it.
const missing = computed(() =>
    [
        state.nameError.value,
        state.promptError.value,
        state.modelsError.value,
        state.onceError.value,
        state.conditionError.value,
        state.originsError.value,
        state.expiresError.value,
        state.conversationError.value,
        state.sendersError.value,
        form.kind === `schedule` && state.cronPreview.value !== undefined && `error` in state.cronPreview.value ? state.cronPreview.value.error : undefined,
    ].filter((problem): problem is string => problem !== undefined),
);
const tried = ref(false);
// After creating a webhook or a Visitor chat, the draft stays to hand over what to paste.
const savedId = ref<string | undefined>(undefined);
const savedAutomation = computed(() => automations.value.find((automation) => automation.id === savedId.value));

const submit = async (): Promise<void> => {
    tried.value = true;
    touchAll();
    if (!valid.value) {
        if (state.nameError.value !== undefined) {
            nameInput.value?.focus();
        }
        shaking.value = false;
        void nextTick(() => {
            shaking.value = true;
        });
        return;
    }
    if (save.isPending.value) {
        return;
    }
    submitError.value = undefined;
    try {
        const id = form.id.trim();
        await save.mutateAsync(build());
        if (form.kind === `event` || isVisitorChat.value) {
            savedId.value = id;
            return;
        }
        finish(id);
    } catch (err) {
        submitError.value = err instanceof Error ? err.message : t(`automationRow.couldntSave`);
    }
};
// Deferred until Done, not fired at save, or the handoff and the new row would both show the same URL at once.
const finish = (id: string): void => {
    emit(`created`, id);
    emit(`close`);
};

const focusPrompt = (event: MouseEvent): void => {
    if (event.target === event.currentTarget && event.currentTarget instanceof HTMLElement) {
        event.currentTarget.querySelector<HTMLElement>(`[contenteditable="true"], textarea`)?.focus();
    }
};
const promptLabel = computed(() => (effectiveTarget.value === `notify` ? t(`automationDraft.message`) : t(`automationDraft.instructions`)));
const promptPlaceholder = computed(() =>
    effectiveTarget.value === `notify` ? t(`automationFields.notifyPlaceholder`) : t(`automationDraft.instructionsPlaceholder`),
);
</script>

<template>
    <RowGroup :label="t(`automationDraft.newAutomation`)">
        <template #actions>
            <TemplatePicker v-if="recipes.length > 0 && savedId === undefined" :templates="recipes" :picked="template" @pick="pickTemplate" />
            <button type="button" :class="ui.iconButton()" :aria-label="t(`automationDraft.close`)" v-tooltip.top="t(`automationDraft.close`)" @click="emit(`close`)">
                <Icon name="times" class="text-xs" />
            </button>
        </template>

        <!-- Open and fixed open: a stray press on its head must not fold away what was typed. -->
        <DisclosureRow class="@container" body="drawer" hit="pair" open disabled>
            <template #lead="{ mark, iconClass }">
                <span class="flex shrink-0 items-center justify-center rounded-md bg-overlay text-muted" :style="{ width: `${mark}px`, height: `${mark}px` }">
                    <Icon :name="TRIGGER_ICON[form.kind]" :class="iconClass" />
                </span>
            </template>
            <!-- Its name and note, written where the row will show them. -->
            <template #title>
                <input
                    ref="nameInput"
                    v-model="form.id"
                    spellcheck="false"
                    autocomplete="off"
                    :placeholder="t(`automationDraft.namePlaceholder`)"
                    :aria-label="t(`automationDraft.name`)"
                    :aria-invalid="nameShown !== undefined"
                    class="field-bare -mx-1 w-full min-w-0 rounded-sm px-1 transition-colors hover:bg-content/5"
                    :class="nameShown ? `text-danger` : ``"
                    @blur="markTouched(`name`)"
                    @keydown.enter.prevent="submit"
                />
            </template>
            <template #description>
                <span v-if="nameShown" class="text-danger">{{ nameShown }}</span>
                <input
                    v-else
                    v-model="form.note"
                    maxlength="200"
                    :placeholder="t(`automationDraft.notePlaceholder`)"
                    :aria-label="t(`automationDraft.note`)"
                    class="field-bare -mx-1 w-full min-w-0 rounded-sm px-1 text-xs text-muted transition-colors hover:bg-content/5"
                />
            </template>

            <template #below>
                <!-- The handoff: what creating a webhook or a Visitor chat does not finish by itself. -->
                <div v-if="savedId !== undefined" class="flex flex-col gap-3 pr-3">
                    <p class="text-sm text-content">
                        <Icon name="check-circle" class="mr-1.5 text-success" />{{
                            savedAutomation && embedSnippet(savedAutomation) ? t(`automationComposer.visitorChatCreatedDrop`) : t(`automationComposer.automationCreatedWireUp`)
                        }}
                    </p>
                    <div v-if="savedAutomation" class="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2">
                        <code class="min-w-0 flex-1 break-all font-mono text-2xs text-content">{{ embedSnippet(savedAutomation) ?? webhookUrl(savedAutomation) }}</code>
                        <CopyButton
                            :text="embedSnippet(savedAutomation) ?? webhookUrl(savedAutomation) ?? ``"
                            :aria-label="
                                embedSnippet(savedAutomation)
                                    ? t(`automationComposer.copyEmbedSnippet`, { id: savedAutomation.id })
                                    : t(`automationComposer.copyWebhookUrl`, { id: savedAutomation.id })
                            "
                        />
                    </div>
                    <p v-if="savedAutomation && embedSnippet(savedAutomation)" class="text-xs text-muted">
                        {{ t(`automationComposer.pasteBefore`) }} <span class="font-mono">&lt;/body&gt;</span> {{ t(`automationComposer.onAnyPageListed`) }}
                    </p>
                    <p v-else class="text-xs text-muted">{{ template?.setup ?? t(`automationComposer.anyExternalSystemWake`) }}</p>
                    <Button tier="accent" class="self-end" :label="t(`automationComposer.done`)" @click="finish(savedId ?? ``)" />
                </div>

                <div v-else class="flex flex-col gap-6 pr-3">
                    <Notice v-if="submitError" :of="noticeOf(submitError)" />

                    <!-- The full form, for what has no value of its own on the draft (a listener's people, tools, a fallback model):
                         the same draft, with its way back and its Create at its top. -->
                    <template v-if="mode === `settings`">
                        <div class="flex items-center gap-2">
                            <Button size="small" tier="quiet" :label="t(`automationDraft.back`)" @click="mode = `draft`">
                                <template #icon><Icon name="chevron-left" /></template>
                            </Button>
                            <span class="flex-1"></span>
                            <Button tier="accent" size="small" :label="t(`automationDraft.create`)" :loading="save.isPending.value" @click="submit" />
                        </div>
                        <AutomationFields :state="state" :recipe-note="template?.title" />
                    </template>

                    <!-- Settings beside the document with room, above it without, as an opened automation has them. -->
                    <div v-else class="flex flex-col gap-6 @3xl:flex-row @3xl:gap-8">
                        <div class="@3xl:order-last @3xl:w-1/3 @3xl:shrink-0 @3xl:border-l border-line-subtle @3xl:pl-6">
                            <dl class="flex flex-col gap-2">
                                <WhenProperty :state="state" />
                                <EndsProperty v-if="retireOffered" :state="state" />
                                <ThenProperty v-if="targetsOffered" :state="state" />
                                <ServiceProperty v-if="needsModels" :automation="summary" />
                                <PersonaProperty v-if="personaShown" :automation="summary" />
                                <template v-if="needsModels">
                                    <ModelProperty :automation="summary" />
                                    <p v-if="touched.has(`models`) && state.modelsError.value" class="text-xs text-danger">{{ state.modelsError.value }}</p>
                                </template>
                                <GateProperty :automation="summary" />
                                <GroupProperty :automation="summary" />
                            </dl>
                        </div>

                        <div class="flex min-w-0 flex-1 flex-col gap-6">
                            <!-- What it is told, written in the type it will be read in, with no box around it. -->
                            <Section :label="promptLabel">
                                <!-- The whole block takes the caret, not only its first line: an empty document is one line tall. -->
                                <div class="-mx-2 min-h-16 cursor-text rounded-md px-2 py-1 transition-colors hover:bg-content/5" @click="focusPrompt">
                                    <MarkdownDocument
                                        v-model="form.prompt"
                                        editable
                                        save="none"
                                        frame="none"
                                        :placeholder="promptPlaceholder"
                                        :label="promptLabel"
                                    />
                                </div>
                                <p v-if="touched.has(`prompt`) && state.promptError.value" class="mt-1 text-xs text-danger">{{ state.promptError.value }}</p>
                                <p v-else-if="state.staleStarter.value" class="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-xs text-warning">
                                    <span>{{
                                        t(`automationFields.sStarterSendsDifferent`, { label: state.staleStarter.value.label, label2: state.listenerSource.value.label })
                                    }}</span>
                                    <button type="button" :class="ui.textButton({ tone: `quiet` })" @click="state.applyStarter">
                                        {{ t(`automationFields.useStarter`, { label: state.listenerSource.value.label }) }}
                                    </button>
                                </p>
                            </Section>
                            <Section v-if="isVisitorChat" :label="t(`automationDraft.site`)">
                                <VisitorChatFields :state="state" />
                            </Section>
                            <Section :label="t(`automationDraft.check`)">
                                <ConditionFields :state="state" />
                            </Section>
                        </div>
                    </div>

                    <div
                        class="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3"
                        :class="shaking ? `ui-shake` : ``"
                        @animationend="shaking = false"
                    >
                        <Button v-if="mode === `draft`" size="small" tier="quiet" :label="t(`automationDraft.allSettings`)" @click="mode = `settings`">
                            <template #icon><Icon name="sliders-h" /></template>
                        </Button>
                        <span class="min-w-0 flex-1 text-xs text-danger" aria-live="polite">{{
                            tried ? missing.join(` `) : ``
                        }}</span>
                        <Button size="small" tier="quiet" :label="t(`automationDraft.cancel`)" @click="emit(`close`)" />
                        <Button size="small" tier="accent" :label="t(`automationDraft.create`)" :loading="save.isPending.value" @click="submit">
                            <template #icon><Icon name="check" /></template>
                        </Button>
                    </div>
                </div>
            </template>
        </DisclosureRow>
    </RowGroup>
</template>
