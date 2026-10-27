<!-- Whether somebody has to release a secret before the agent can use it, and who: the first of the rules on an open secret, changed where it is read. -->
<script setup lang="ts">
import { type NoticeModel, SegmentedControl, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import type { CredentialGateScope } from "@intentic/sandbox-contract/schemas/secrets";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { useCredentialGates } from "../../../../models/capabilities/useSecrets";
import SecretChoice from "./SecretChoice.vue";
import SecretFact from "./SecretFact.vue";
import SecretPopover from "./SecretPopover.vue";
import { EDITABLE_VALUE, FIXED_VALUE, VALUE_NOTE, VALUE_TEXT } from "./secretLook";

// Approvers are an exact list, never a role floor ("only Bob"), so the owner is a choice here too rather than implied.
// Only the owner changes it (the daemon's rule); everybody else reads the same words with nothing to press.

const t = useT();

const { row } = defineProps<{ row: SecretRow }>();

const { gateFor, approverChoices, isOwner, setGate, removeGate } = useCredentialGates();

const gate = computed(() => (row.gateSubject === undefined ? undefined : gateFor(row.gateSubject)));
// A signed-in profile or a running MCP server is mounted for a whole turn: one release covers the conversation.
const defaultScope = (): CredentialGateScope => (row.mountedForTurn ? `conversation` : `use`);

const said = computed(() =>
    gate.value === undefined
        ? t(`capabilities.secretApproval.notNeeded`)
        : gate.value.approvers.join(t(`capabilities.secretApproval.or`)),
);
const note = computed(() => {
    if (gate.value === undefined) {
        return t(`capabilities.secretApproval.notNeededNote`);
    }
    return gate.value.scope === `conversation` ? t(`capabilities.secretApproval.perConversation`) : t(`capabilities.secretApproval.everyUse`);
});

const anchor = ref<HTMLElement>();
const open = ref(false);
const named = ref(false);
const approvers = ref<string[]>([]);
const scope = ref<CredentialGateScope>(`use`);
const saving = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

// Opens on what is stored; asking for people pre-picks the roster's first (the owner), the answer reached for most.
const begin = (): void => {
    named.value = gate.value !== undefined;
    approvers.value = [...(gate.value?.approvers ?? [])];
    scope.value = gate.value?.scope ?? defaultScope();
    error.value = undefined;
    open.value = true;
};

const choose = (people: boolean): void => {
    named.value = people;
    if (people && approvers.value.length === 0) {
        approvers.value = approverChoices.value.slice(0, 1);
    }
};

const toggleApprover = (email: string): void => {
    approvers.value = approvers.value.includes(email) ? approvers.value.filter((entry) => entry !== email) : [...approvers.value, email];
};

// Saveable with somebody named (the route refuses an empty list), or when asking nobody is a change.
const canSave = computed(() => (named.value ? approvers.value.length > 0 : gate.value !== undefined));

const save = async (): Promise<void> => {
    if (row.gateSubject === undefined) {
        return;
    }
    saving.value = true;
    error.value = undefined;
    try {
        if (named.value) {
            await setGate.mutateAsync({
                subject: row.gateSubject,
                kind: row.entry.kind === `capability` ? `capability` : `secret`,
                approvers: approvers.value,
                scope: scope.value,
            });
        } else {
            await removeGate.mutateAsync(row.gateSubject);
        }
        open.value = false;
    } catch (err) {
        error.value = noticeFrom(err, t(`capabilities.secretApproval.couldNotSave`));
    } finally {
        saving.value = false;
    }
};

const SCOPES = computed(() => [
    { label: t(`capabilities.secretApproval.once`), value: `use` as const, title: t(`capabilities.secretApproval.onceNote`) },
    { label: t(`capabilities.secretApproval.restConversation`), value: `conversation` as const, title: t(`capabilities.secretApproval.restConversationNote`) },
]);
</script>

<template>
    <SecretFact :label="t(`capabilities.secretApproval.label`)">
        <button
            v-if="isOwner"
            ref="anchor"
            type="button"
            :class="EDITABLE_VALUE"
            :aria-label="t(`capabilities.secretApproval.change`, { now: said })"
            @click="begin"
        >
            <span :class="VALUE_TEXT" class="[overflow-wrap:anywhere]">{{ said }}</span>
            <span :class="VALUE_NOTE">{{ note }}</span>
        </button>
        <span v-else :class="FIXED_VALUE">
            <span :class="VALUE_TEXT" class="[overflow-wrap:anywhere]">{{ said }}</span>
            <span :class="VALUE_NOTE">{{ note }}</span>
        </span>

        <SecretPopover
            v-model="open"
            :anchor="anchor"
            :header="t(`capabilities.secretApproval.label`)"
            :saving="saving"
            :error="error"
            :can-save="canSave"
            wide
            @save="save"
        >
            <div class="flex flex-col gap-1" role="radiogroup" :aria-label="t(`capabilities.secretApproval.label`)">
                <SecretChoice
                    :checked="!named"
                    :title="t(`capabilities.secretApproval.notNeeded`)"
                    :note="t(`capabilities.secretApproval.notNeededChoice`)"
                    @pick="choose(false)"
                />
                <SecretChoice
                    :checked="named"
                    :title="t(`capabilities.secretApproval.namedPeople`)"
                    :note="t(`capabilities.secretApproval.namedPeopleChoice`)"
                    @pick="choose(true)"
                />
            </div>

            <div v-if="named" class="flex flex-col gap-3 pl-9">
                <div class="flex flex-col gap-1.5">
                    <span class="text-xs text-muted">{{ t(`capabilities.secretApproval.whoRelease`) }}</span>
                    <div v-if="approverChoices.length > 0" class="flex flex-wrap gap-1">
                        <button
                            v-for="email of approverChoices"
                            :key="email"
                            type="button"
                            :class="ui.chip({ on: approvers.includes(email) })"
                            :aria-pressed="approvers.includes(email)"
                            @click="toggleApprover(email)"
                        >
                            {{ email }}
                        </button>
                    </div>
                    <!-- Names come from the Access roster plus the owner; the daemon refuses anyone else. -->
                    <p v-if="approverChoices.length <= 1" class="text-xs text-subtle">
                        {{ approverChoices.length === 0 ? t(`capabilities.secretApproval.nobodyYet`) : t(`capabilities.secretApproval.onlyYou`) }}
                        <RouterLink to="/sandbox/access" class="text-link hover:underline">{{ t(`capabilities.secretApproval.accessTab`) }}</RouterLink>
                    </p>
                    <span v-if="approvers.length === 0" class="text-xs text-warning">{{ t(`capabilities.secretApproval.nameAtLeastOne`) }}</span>
                </div>
                <div class="flex flex-col gap-1.5">
                    <span class="text-xs text-muted">{{ t(`capabilities.secretApproval.howLong`) }}</span>
                    <p v-if="row.mountedForTurn" class="text-xs text-subtle">{{ t(`capabilities.secretApproval.signedInConversation`) }}</p>
                    <SegmentedControl v-else v-model="scope" :options="SCOPES" size="xs" wrap />
                </div>
            </div>
        </SecretPopover>
    </SecretFact>
</template>
