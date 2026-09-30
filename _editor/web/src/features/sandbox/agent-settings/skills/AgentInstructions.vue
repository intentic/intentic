<script setup lang="ts">
import { type BuiltinPromptText, SYSTEM_PROMPT_MAX, type SystemPromptMode } from "@intentic/sandbox-contract";
import {
    Button,
    ConfirmDialog,
    CopyButton,
    MarkdownDocument,
    Modal,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    RowNote,
    SegmentedControl,
    type Tip,
} from "@intentic/ui";
import { noticeFrom, useAsyncAction } from "@intentic/ui/async";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { sandboxRpc } from "../../client/sandboxRpc";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useSavings } from "../../usage/useSavings";
import MeasurementPanel from "../models/MeasurementPanel.vue";
import { type ResultTable, tableOf } from "../models/experimentReadings";
import { asPercent } from "../models/numberInputs";
import { useTrimmedDraft } from "../../../../lib/useDraft";
import { promptReach, spokenList } from "./promptReach";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { settings, patch, save } = useSandboxSettings();

const PROMPT_MODES = computed((): { label: string; value: SystemPromptMode }[] => [
    { label: `Intentic`, value: `intentic` },
    { label: `Claude`, value: `claude` },
    { label: t(`sandbox.agentInstructions.custom`), value: `custom` },
]);
const promptMode = computed<SystemPromptMode>(() => settings.value?.systemPromptMode ?? `intentic`);
// What is on disk is handed to the document surface so IT decides what "unsaved" means. Undefined until the settings
// arrive, which is what stops an empty draft looking like a prompt somebody deleted. Saved trimmed, so measured trimmed
// (useTrimmedDraft): measured raw, a save that landed still read "Not saved yet".
const { draft: prompt, stored } = useTrimmedDraft(() => settings.value?.systemPrompt);

const savePrompt = (text: string): void => patch({ systemPrompt: text.trim() });
// A refused write has already been put back on screen (useSandboxSettings); without its reason here, the old value
// simply reappears and the press looks like it did nothing.
const saveError = computed<NoticeModel | undefined>(() =>
    save.error.value === null ? undefined : noticeFrom(save.error.value, t(`sandbox.agentInstructions.couldntSave`)),
);
const setPromptMode = (mode: string): void => patch({ systemPromptMode: mode as SystemPromptMode });

const builtinPrompts = ref<Partial<Record<string, BuiltinPromptText>>>({});
const viewingBase = ref<`intentic` | `claude` | undefined>(undefined);
const { busy: builtinBusy, notice: builtinError, run: runBuiltin } = useAsyncAction();
const loadBuiltin = async (base: `intentic` | `claude`): Promise<BuiltinPromptText | undefined> => {
    if (builtinPrompts.value[base] === undefined) {
        await runBuiltin(async () => {
            builtinPrompts.value = { ...builtinPrompts.value, [base]: await sandboxRpc.settings.builtinPrompt({ base }) };
        }, `Couldn't read that system prompt from your sandbox.`);
    }
    return builtinPrompts.value[base];
};
const viewBuiltin = async (base: `intentic` | `claude`): Promise<void> => {
    viewingBase.value = base;
    await loadBuiltin(base);
};
const VIEW_BASES = [
    { label: `Intentic`, value: `intentic` },
    { label: `Claude`, value: `claude` },
];
const setViewingBase = (base: string): void => void viewBuiltin(base as `intentic` | `claude`);

const fork = (text: string): void => {
    prompt.value = text;
    viewingBase.value = undefined;
    setPromptMode(`custom`);
};

// Starting from a built-in prompt replaces the whole document, so text already in it is asked about first: the owner
// had pasted their own and lost it to one press. An untouched copy of the same prompt has nothing to lose.
const replacing = ref<string | undefined>(undefined);
const forkBuiltin = async (base: `intentic` | `claude`): Promise<void> => {
    const fetched = await loadBuiltin(base);
    if (fetched === undefined) {
        return;
    }
    if (prompt.value.trim() !== `` && prompt.value.trim() !== fetched.text.trim()) {
        replacing.value = fetched.text;
        return;
    }
    fork(fetched.text);
};
const confirmReplace = (): void => {
    if (replacing.value !== undefined) {
        fork(replacing.value);
    }
    replacing.value = undefined;
};

// The holdout keeps whole conversations on the long form, since the guidance rides the prompt for the whole session.
const { savings } = useSavings({});
const guidanceHoldoutPercent = computed<number>(() => asPercent(settings.value?.leanGuidanceHoldout));
const guidanceTable = computed<ResultTable | undefined>(() => tableOf(savings.value?.guidance));

const reach = promptReach();
const viewPromptTip = computed((): Tip => ({
    title: t(`sandbox.agentInstructions.viewPrompt`),
    rows: [
        { label: t(`sandbox.agentInstructions.promptReachReplaces`), value: spokenList(reach.replaces) },
        ...(reach.adds.length > 0
            ? [{ label: t(`sandbox.agentInstructions.promptReachAdds`), value: spokenList(reach.adds) }]
            : []),
    ],
}));
</script>

<template>
    <RowGroup :label="t(`sandbox.words.instructions`)">
        <Row icon="pencil" :title="t(`sandbox.words.systemPrompt`)">
            <template #description>
                <template v-if="promptMode === `custom`">{{ t(`sandbox.agentInstructions.ownPromptAgentRuns`) }}</template>
                <template v-else-if="promptMode === `claude`">{{ t(`sandbox.agentInstructions.claudeCodesOwnPrompt`) }}</template>
                <template v-else>{{ t(`sandbox.agentInstructions.intenticsOwnPromptTuned`) }}</template>
            </template>
            <template #control>
                <SegmentedControl :model-value="promptMode" :options="PROMPT_MODES" @update:model-value="setPromptMode" />
            </template>
            <template #below>
                <template v-if="promptMode !== `custom`">
                    <Button
                        :label="t(`sandbox.agentInstructions.viewPrompt`)"
                        size="small"
                        severity="secondary"
                        v-tooltip.bottom="viewPromptTip"
                        @click="viewBuiltin(promptMode)"
                    />
                </template>

                <!-- What the choice costs and where to start from belong to the row that makes it; the document itself
                     is a region of this same card, below. -->
                <template v-else>
                    <Notice tone="warning" class="text-2xs">
                        {{ t(`sandbox.agentInstructions.wholePromptOn`, { replaces: spokenList(reach.replaces) }) }}
                        <template v-if="reach.adds.length > 0">{{
                            t(`sandbox.agentInstructions.onAddedToPrompt`, { adds: spokenList(reach.adds) })
                        }}</template>
                    </Notice>

                    <div class="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                            :label="t(`sandbox.agentInstructions.startIntentics`)"
                            size="small"
                            severity="secondary"
                            :loading="builtinBusy"
                            @click="forkBuiltin(`intentic`)"
                        />
                        <Button
                            :label="t(`sandbox.agentInstructions.startClaudes`)"
                            size="small"
                            severity="secondary"
                            :loading="builtinBusy"
                            @click="forkBuiltin(`claude`)"
                        />
                    </div>
                </template>
                <Notice v-if="builtinError !== undefined" :of="builtinError" class="mt-2" />
            </template>
        </Row>

        <!-- A custom prompt drops this product's guidance outright, so the form it would take has nothing to choose. -->
        <Row
            v-if="promptMode !== `custom`"
            spine
            icon="list-check"
            :title="t(`sandbox.agentInstructions.leanGuidance`)"
            :description="t(`sandbox.agentInstructions.leanGuidanceDescription`)"
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.leanGuidance ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ leanGuidance: value })"
                />
            </template>
            <template v-if="settings?.leanGuidance === true" #below>
                <MeasurementPanel
                    :percent="guidanceHoldoutPercent"
                    :table="guidanceTable"
                    :note="t(`sandbox.agentInstructions.ofConversationsKeepFullGuidance`)"
                    :on-label="t(`sandbox.agentInstructions.shortForm`)"
                    :off-label="t(`sandbox.agentInstructions.longForm`)"
                    @commit="(leanGuidanceHoldout: number) => patch({ leanGuidanceHoldout })"
                />
            </template>
        </Row>

        <!-- A PROMPT IS A DOCUMENT, and it was the worst-served one in the app: five monospace rows with no structure
             visible. It takes the card it is already on rather than a field shell inside a row's drawer. -->
        <MarkdownDocument
            v-if="promptMode === `custom`"
            v-model="prompt"
            frame="section"
            :editable="settings !== undefined"
            :stored="stored"
            :saving="save.isPending.value"
            save="explicit"
            :label="t(`sandbox.words.systemPrompt`)"
            :max-chars="SYSTEM_PROMPT_MAX"
            :placeholder="t(`sandbox.agentInstructions.writeAssistantsSystemPrompt`)"
            @save="savePrompt"
        />
        <RowNote v-if="saveError !== undefined" variant="block"><Notice :of="saveError" /></RowNote>
    </RowGroup>

    <ConfirmDialog
        :open="replacing !== undefined"
        :header="t(`sandbox.agentInstructions.replaceYourText`)"
        :confirm-label="t(`sandbox.agentInstructions.replace`)"
        @cancel="replacing = undefined"
        @confirm="confirmReplace"
    >
        <p class="text-sm text-muted">{{ t(`sandbox.agentInstructions.replaceYourTextDetail`) }}</p>
    </ConfirmDialog>

    <Modal
        :open="viewingBase !== undefined"
        size="lg"
        :header="t(`sandbox.agentInstructions.builtInSystemPrompts`)"
        @update:open="viewingBase = undefined"
    >
        <SegmentedControl
            v-if="viewingBase !== undefined"
            :model-value="viewingBase"
            :options="VIEW_BASES"
            :aria-label="t(`sandbox.agentInstructions.builtInPromptTo`)"
            @update:model-value="setViewingBase"
        />
        <div v-if="builtinBusy" class="flex items-center gap-2 py-6 text-xs text-muted">
            <Icon name="spinner" spin />
            {{ t(`sandbox.agentInstructions.readingSandbox`) }}
        </div>
        <Notice v-else-if="builtinError !== undefined" :of="builtinError" class="mt-3" />
        <template v-else-if="viewingBase !== undefined && builtinPrompts[viewingBase] !== undefined">
            <p class="mt-3 text-xs text-muted">
                <template v-if="viewingBase === `claude`">
                    {{ t(`sandbox.agentInstructions.claudeCodesOwnPrompt2`) }}
                    <span class="font-mono text-content">{{ builtinPrompts[viewingBase]?.version }}</span
                    >{{ t(`sandbox.agentInstructions.notCopyKeptBy`) }}
                </template>
                <template v-else>
                    {{ t(`sandbox.agentInstructions.intenticsOwnPromptDefault`) }}
                </template>
                {{ t(`sandbox.agentInstructions.eitherWayAppsOwn`) }}
            </p>
            <!-- READ IT AS THE THING YOU WOULD BE FORKING. Two rules rather than a box: the dialog is already the
                 frame, and they say where the passage clips without sinking it into a well. -->
            <div class="ui-softscroll mt-3 max-h-[55dvh] overflow-auto border-y border-line-subtle py-3" style="--prose-measure: 76ch">
                <MarkdownDocument
                    :model-value="builtinPrompts[viewingBase]?.text ?? ``"
                    :label="t(`sandbox.agentInstructions.builtInSystemPrompt`)"
                />
            </div>
            <div class="mt-3 flex items-center justify-end gap-2">
                <CopyButton :text="builtinPrompts[viewingBase]?.text ?? ``" :label="t(`ui.action.copy`)" />
            </div>
        </template>
    </Modal>
</template>
