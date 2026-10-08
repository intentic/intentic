<script setup lang="ts">
import { Notice, type NoticeModel, ui, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import type { BrokerRule } from "@intentic/extension-manifest";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { useCredentialGates, useCredentialPolicy } from "./useSecrets";

// How a connection's credential reaches the agent, under its approver and host guard: held by the sandbox's credential
// gateway (the default wherever the connector declares routes), an SSH key held by its ssh agent, or handed over as it
// is, and the method and path rules the gateway enforces on every request it attaches the credential to. Only the owner changes either; everybody else
// reads it. The rules editor is the plain JSON the daemon stores, since a rule is three short fields and a form for it
// would hide the order that decides which rule wins.

const t = useT();

const { row, expanded } = defineProps<{ row: SecretRow; expanded: boolean }>();

const { isOwner } = useCredentialGates();
const { setPolicy } = useCredentialPolicy();

const policy = computed(() => row.entry.credential);
// The gateway's rules and its on/off switch: for a card it carries, or one the owner set to raw that it could carry again.
const gatewayCard = computed(() => policy.value?.delivery === `gateway` || policy.value?.delivery === `raw`);
const editing = ref(false);
const draft = ref(``);
const draftError = ref<string | undefined>(undefined);
const error = ref<NoticeModel | undefined>(undefined);

watch(
    [() => expanded, policy],
    () => {
        editing.value = false;
        draft.value = JSON.stringify(policy.value?.rules ?? [], null, 2);
        draftError.value = undefined;
        error.value = undefined;
    },
    { immediate: true },
);

const save = async (change: { delivery?: `gateway` | `raw`; rules?: BrokerRule[] | null }): Promise<boolean> => {
    error.value = undefined;
    if (row.gateSubject === undefined) {
        return false;
    }
    try {
        await setPolicy.mutateAsync({ subject: row.gateSubject, ...change });
        return true;
    } catch (err) {
        error.value = noticeFrom(err, t(`capabilities.secretCredentialPolicy.couldNotSave`));
        return false;
    }
};

const toggleGateway = (held: boolean): void => void save({ delivery: held ? `gateway` : `raw` });

// Parsed here only to say what is wrong before a round trip; the daemon validates each rule again.
const saveRules = async (): Promise<void> => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(draft.value);
    } catch {
        draftError.value = t(`capabilities.secretCredentialPolicy.notJson`);
        return;
    }
    if (!Array.isArray(parsed)) {
        draftError.value = t(`capabilities.secretCredentialPolicy.notJson`);
        return;
    }
    draftError.value = undefined;
    if (await save({ rules: parsed as BrokerRule[] })) {
        editing.value = false;
    }
};

const ruleLine = (rule: BrokerRule): string =>
    `${rule.methods?.join(`/`) ?? t(`capabilities.secretCredentialPolicy.anyMethod`)} ${rule.paths?.join(`, `) ?? t(`capabilities.secretCredentialPolicy.anyPath`)}`;
</script>

<template>
    <div v-if="policy !== undefined" class="mt-3 border-t border-line pt-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`capabilities.secretCredentialPolicy.heading`) }}</span>

        <div class="flex items-center justify-between gap-2 pt-1.5">
            <span class="text-xs text-content">{{
                policy.delivery === `gateway`
                    ? t(`capabilities.secretCredentialPolicy.heldByGateway`)
                    : policy.delivery === `raw`
                      ? t(`capabilities.secretCredentialPolicy.handedOverByChoice`)
                      : policy.delivery === `ssh-agent`
                        ? t(`capabilities.secretCredentialPolicy.heldBySshAgent`)
                        : t(`capabilities.secretCredentialPolicy.handedOverNoRoute`)
            }}</span>
            <ToggleSwitch
                v-if="isOwner && gatewayCard"
                :model-value="policy.delivery === `gateway`"
                :aria-label="t(`capabilities.secretCredentialPolicy.keepInGateway`)"
                @update:model-value="toggleGateway"
            />
        </div>
        <p class="pt-0.5 text-2xs text-muted">
            {{
                policy.delivery === `gateway`
                    ? t(`capabilities.secretCredentialPolicy.gatewayExplain`)
                    : policy.delivery === `raw`
                      ? t(`capabilities.secretCredentialPolicy.rawExplain`)
                      : policy.delivery === `ssh-agent`
                        ? t(`capabilities.secretCredentialPolicy.sshAgentExplain`)
                        : t(`capabilities.secretCredentialPolicy.directExplain`)
            }}
        </p>

        <template v-if="gatewayCard">
            <p class="pt-2 text-2xs text-muted">
                {{
                    policy.rulesFrom === `owner`
                        ? t(`capabilities.secretCredentialPolicy.yourRules`)
                        : t(`capabilities.secretCredentialPolicy.connectorRules`)
                }}
            </p>
            <ul v-if="!editing && policy.rules.length > 0" class="pt-1">
                <li v-for="(rule, index) of policy.rules" :key="index" class="text-2xs text-content">
                    <span class="font-medium">{{ rule.action }}</span>
                    <span class="font-mono text-subtle"> {{ ruleLine(rule) }}</span>
                    <span v-if="rule.why" class="text-muted"> · {{ rule.why }}</span>
                </li>
            </ul>
            <p v-else-if="!editing" class="pt-1 text-2xs text-muted">{{ t(`capabilities.secretCredentialPolicy.noRules`) }}</p>

            <template v-if="isOwner">
                <textarea
                    v-if="editing"
                    v-model="draft"
                    :class="ui.input({ size: `sm` }, 'mt-1 w-full resize-y font-mono')"
                    rows="8"
                    spellcheck="false"
                    :aria-label="t(`capabilities.secretCredentialPolicy.rulesJson`)"
                />
                <p v-if="draftError" class="pt-1 text-2xs text-warning">{{ draftError }}</p>
                <div class="flex items-center gap-3 pt-1.5">
                    <button v-if="!editing" type="button" :class="ui.textButton({ size: `xs` })" @click="editing = true">
                        {{ t(`capabilities.secretCredentialPolicy.editRules`) }}
                    </button>
                    <template v-else>
                        <button type="button" :class="ui.textButton({ size: `xs` })" v-action="saveRules">{{ t(`ui.action.save`) }}</button>
                        <button type="button" :class="ui.textButton({ size: `xs` })" @click="editing = false">{{ t(`ui.action.cancel`) }}</button>
                    </template>
                    <button
                        v-if="policy.rulesFrom === `owner` && !editing"
                        type="button"
                        :class="ui.textButton({ size: `xs` })"
                        v-action="() => save({ rules: null })"
                    >
                        {{ t(`capabilities.secretCredentialPolicy.useConnectorRules`) }}
                    </button>
                </div>
            </template>
        </template>
        <Notice v-if="error" :of="error" class="mt-2" />
    </div>
</template>
