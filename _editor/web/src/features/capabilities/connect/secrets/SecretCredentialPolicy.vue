<!-- How a connection's credential reaches the agent, and the rules the credential gateway holds it to: two facts on its open row, each changed where it is read. -->
<script setup lang="ts">
import { parseJsonOr } from "@intentic/base/json";
import { Button, type NoticeModel, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import type { BrokerRule } from "@intentic/extension-manifest";
import { computed, ref } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { useCredentialGates, useCredentialPolicy } from "../../../../models/capabilities/useSecrets";
import SecretChoice from "./SecretChoice.vue";
import SecretFact from "./SecretFact.vue";
import SecretPopover from "./SecretPopover.vue";
import { EDITABLE_VALUE, FIXED_VALUE, VALUE_NOTE, VALUE_TEXT } from "./secretLook";

// Held by the sandbox's credential gateway (the default wherever the connector declares routes), an SSH key held by its
// ssh agent, or handed over as it is; and the method and path rules the gateway enforces on every request it attaches the
// credential to. Whoever runs secrets changes either. The rules editor is the plain JSON the daemon stores, since a rule is
// three short fields and a form for it would hide the order that decides which rule wins.

const t = useT();

const { row } = defineProps<{ row: SecretRow }>();

const { runsSecrets } = useCredentialGates();
const { setPolicy } = useCredentialPolicy();

const policy = computed(() => row.entry.credential);
// The gateway's rules and its switch: for a credential it carries, or one set to raw by hand that it could carry again.
const gatewayCard = computed(() => policy.value?.delivery === `gateway` || policy.value?.delivery === `raw`);

// What the agent gets, in the words of its answer, and what that means under it.
const delivery = computed<{ said: string; note: string } | undefined>(() => {
    switch (policy.value?.delivery) {
        case `gateway`:
            return { said: t(`capabilities.secretCredentialPolicy.viaGateway`), note: t(`capabilities.secretCredentialPolicy.viaGatewayNote`) };
        case `raw`:
            return { said: t(`capabilities.secretCredentialPolicy.realValue`), note: t(`capabilities.secretCredentialPolicy.byYourChoiceNote`) };
        case `direct`:
            return { said: t(`capabilities.secretCredentialPolicy.realValue`), note: t(`capabilities.secretCredentialPolicy.noRouteNote`) };
        case `ssh-agent`:
            return { said: t(`capabilities.secretCredentialPolicy.viaSshAgent`), note: t(`capabilities.secretCredentialPolicy.viaSshAgentNote`) };
        default:
            return undefined;
    }
});

// A rule as a line a person reads: what it does, in the colour of what it does, to which requests, and why.
const ACTION_TONE = { allow: `text-success`, ask: `text-warning`, deny: `text-danger` } as const;
const actionWord = (rule: BrokerRule): string => {
    switch (rule.action) {
        case `allow`:
            return t(`capabilities.secretCredentialPolicy.allow`);
        case `ask`:
            return t(`capabilities.secretCredentialPolicy.ask`);
        case `deny`:
            return t(`capabilities.secretCredentialPolicy.deny`);
    }
};
const requestsOf = (rule: BrokerRule): string =>
    `${rule.methods?.join(`/`) ?? t(`capabilities.secretCredentialPolicy.anyMethod`)} ${rule.paths?.join(`, `) ?? t(`capabilities.secretCredentialPolicy.anyPath`)}`;
const rulesNote = computed(() => {
    if (policy.value === undefined || policy.value.rules.length === 0) {
        return t(`capabilities.secretCredentialPolicy.noRulesNote`);
    }
    return policy.value.rulesFrom === `owner` ? t(`capabilities.secretCredentialPolicy.yourRules`) : t(`capabilities.secretCredentialPolicy.connectorRules`);
});

const save = async (change: { delivery?: `gateway` | `raw`; rules?: BrokerRule[] | null }, failed: { value: NoticeModel | undefined }): Promise<boolean> => {
    failed.value = undefined;
    if (row.gateSubject === undefined) {
        return false;
    }
    try {
        await setPolicy.mutateAsync({ subject: row.gateSubject, ...change });
        return true;
    } catch (err) {
        failed.value = noticeFrom(err, t(`capabilities.secretCredentialPolicy.couldNotSave`));
        return false;
    }
};

// Delivery: keep it in the gateway, or hand the agent the real value.
const deliveryAnchor = ref<HTMLElement>();
const deliveryOpen = ref(false);
const held = ref(true);
const deliverySaving = ref(false);
const deliveryError = ref<NoticeModel | undefined>(undefined);
const beginDelivery = (): void => {
    held.value = policy.value?.delivery === `gateway`;
    deliveryError.value = undefined;
    deliveryOpen.value = true;
};
const saveDelivery = async (): Promise<void> => {
    if (held.value === (policy.value?.delivery === `gateway`)) {
        deliveryOpen.value = false;
        return;
    }
    deliverySaving.value = true;
    if (await save({ delivery: held.value ? `gateway` : `raw` }, deliveryError)) {
        deliveryOpen.value = false;
    }
    deliverySaving.value = false;
};

// Rules: the JSON the daemon stores, parsed here only to say what is wrong before a round trip.
const rulesAnchor = ref<HTMLElement>();
const rulesOpen = ref(false);
const draft = ref(``);
const draftError = ref<string | undefined>(undefined);
const rulesSaving = ref(false);
const rulesError = ref<NoticeModel | undefined>(undefined);
const beginRules = (): void => {
    draft.value = JSON.stringify(policy.value?.rules ?? [], null, 2);
    draftError.value = undefined;
    rulesError.value = undefined;
    rulesOpen.value = true;
};
const saveRules = async (): Promise<void> => {
    const parsed = parseJsonOr(draft.value, undefined);
    if (!Array.isArray(parsed)) {
        draftError.value = t(`capabilities.secretCredentialPolicy.notJson`);
        return;
    }
    draftError.value = undefined;
    rulesSaving.value = true;
    if (await save({ rules: parsed as BrokerRule[] }, rulesError)) {
        rulesOpen.value = false;
    }
    rulesSaving.value = false;
};
const useConnectorRules = async (): Promise<void> => {
    if (await save({ rules: null }, rulesError)) {
        rulesOpen.value = false;
    }
};
</script>

<template>
    <template v-if="policy !== undefined && delivery !== undefined">
        <SecretFact :label="t(`capabilities.secretCredentialPolicy.deliveryLabel`)">
            <button
                v-if="runsSecrets && gatewayCard"
                ref="deliveryAnchor"
                type="button"
                :class="EDITABLE_VALUE"
                :aria-label="t(`capabilities.secretCredentialPolicy.changeDelivery`, { now: delivery.said })"
                @click="beginDelivery"
            >
                <span :class="VALUE_TEXT">{{ delivery.said }}</span>
                <span :class="VALUE_NOTE">{{ delivery.note }}</span>
            </button>
            <span v-else :class="FIXED_VALUE">
                <span :class="VALUE_TEXT">{{ delivery.said }}</span>
                <span :class="VALUE_NOTE">{{ delivery.note }}</span>
            </span>

            <SecretPopover
                v-model="deliveryOpen"
                :anchor="deliveryAnchor"
                :header="t(`capabilities.secretCredentialPolicy.deliveryLabel`)"
                :saving="deliverySaving"
                :error="deliveryError"
                wide
                @save="saveDelivery"
            >
                <div class="flex flex-col gap-1" role="radiogroup" :aria-label="t(`capabilities.secretCredentialPolicy.deliveryLabel`)">
                    <SecretChoice
                        :checked="held"
                        :title="t(`capabilities.secretCredentialPolicy.keepInGateway`)"
                        :note="t(`capabilities.secretCredentialPolicy.gatewayExplain`)"
                        @pick="held = true"
                    />
                    <SecretChoice
                        :checked="!held"
                        :title="t(`capabilities.secretCredentialPolicy.handOver`)"
                        :note="t(`capabilities.secretCredentialPolicy.rawExplain`)"
                        @pick="held = false"
                    />
                </div>
            </SecretPopover>
        </SecretFact>

        <SecretFact v-if="gatewayCard" :label="t(`capabilities.secretCredentialPolicy.rulesLabel`)">
            <component
                :is="runsSecrets ? `button` : `span`"
                ref="rulesAnchor"
                :type="runsSecrets ? `button` : undefined"
                :class="runsSecrets ? EDITABLE_VALUE : FIXED_VALUE"
                :aria-label="runsSecrets ? t(`capabilities.secretCredentialPolicy.changeRules`) : undefined"
                @click="runsSecrets ? beginRules() : undefined"
            >
                <ul v-if="policy.rules.length > 0" class="flex flex-col">
                    <li v-for="(rule, index) of policy.rules" :key="index" :class="VALUE_TEXT">
                        <!-- Spaces inside the moustaches: a space between two tags is the formatter's to lose, and was ("denyDELETE"). -->
                        <span class="font-medium" :class="ACTION_TONE[rule.action]">{{ `${actionWord(rule)} ` }}</span>
                        <span class="font-mono text-xs">{{ requestsOf(rule) }}</span>
                        <span v-if="rule.why" class="text-subtle">{{ ` · ${rule.why}` }}</span>
                    </li>
                </ul>
                <span v-else :class="VALUE_TEXT">{{ t(`capabilities.secretCredentialPolicy.noRules`) }}</span>
                <span :class="VALUE_NOTE">{{ rulesNote }}</span>
            </component>

            <SecretPopover
                v-model="rulesOpen"
                :anchor="rulesAnchor"
                :header="t(`capabilities.secretCredentialPolicy.rulesLabel`)"
                :saving="rulesSaving"
                :error="rulesError"
                wide
                @save="saveRules"
            >
                <p class="text-xs text-muted">{{ t(`capabilities.secretCredentialPolicy.rulesExplain`) }}</p>
                <textarea
                    v-model="draft"
                    :class="ui.input({ size: `sm` }, `w-full resize-y font-mono`)"
                    rows="10"
                    spellcheck="false"
                    :aria-label="t(`capabilities.secretCredentialPolicy.rulesJson`)"
                />
                <p v-if="draftError" class="text-xs text-warning">{{ draftError }}</p>
                <Button
                    v-if="policy.rulesFrom === `owner`"
                    class="self-start"
                    size="small"
                    tier="boring"
                    :label="t(`capabilities.secretCredentialPolicy.useConnectorRules`)"
                    @click="useConnectorRules"
                />
            </SecretPopover>
        </SecretFact>
    </template>
</template>
