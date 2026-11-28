<script setup lang="ts">
import { Button, InfoHint, Notice, Picker, type PickerOption, SegmentedControl } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef } from "vue";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useSandboxScope } from "../../../../client/sandbox/scope/useSandboxScope";
import { useTier } from "../../../../client/sandbox/useTier";
import { farSandboxNote, pairableSandboxes } from "../../../../components/linkPairing";
import { pairContact } from "../../../../components/contactPairing";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { contactsChanged } from "../../../../models/messages/useMessages";

// PAIR WITH ONE OF YOUR SANDBOXES: the editor is signed in to both, so it carries each one's document to the other and
// both pin each other's key with no message crossing (contactPairing.ts). As this sandbox (a maintainer's, on both sides)
// or as the reader's own route between the two, which anyone may make for themselves. Messages both ways to start; each
// side changes what the other may do on its own Contacts.

const emit = defineEmits<{ done: []; cancel: [] }>();

const t = useT();
const api = useMessagesApi();
const { sandboxes } = useSandbox();
// The sandbox this form stands in, which is never offered as the other side.
const here = useSandboxScope();
const { canShip } = useTier();

const others = computed(() => pairableSandboxes(sandboxes.value, here.id.value));
const farOptions = computed<readonly PickerOption<string>[]>(() =>
    others.value.map((sandbox) => ({ value: sandbox.id, label: sandbox.name, description: farSandboxNote(sandbox) })),
);
const farId = ref<string>();

type Scope = `sandbox` | `person`;
const scope = ref<Scope>(canShip.value ? `sandbox` : `person`);
const scopes = computed(() => [
    { label: t(`sandbox.messages.pair.asSandbox`), value: `sandbox` as const, disabled: !canShip.value, title: canShip.value ? undefined : t(`sandbox.messages.pair.asSandboxHeld`) },
    { label: t(`sandbox.messages.pair.forMe`), value: `person` as const },
]);

const pairing = ref(false);
const notice = shallowRef<ReturnType<typeof noticeFrom>>();
const pair = async (): Promise<void> => {
    const far = others.value.find((sandbox) => sandbox.id === farId.value);
    if (far === undefined || pairing.value) {
        return;
    }
    pairing.value = true;
    notice.value = undefined;
    try {
        await pairContact(
            api,
            { far: { id: far.id, name: far.name }, scope: scope.value, here: { message: true }, there: { message: true } },
            canShip.value,
            { tooOld: t(`sandbox.messages.pair.tooOld`, { name: far.name }) },
        );
        await contactsChanged();
        emit(`done`);
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.messages.pair.failed`, { name: far.name }));
    } finally {
        pairing.value = false;
    }
};
</script>

<template>
    <p v-if="others.length === 0" class="text-xs text-muted">{{ t(`sandbox.messages.pair.noOthers`) }}</p>
    <form v-else class="flex flex-col gap-3" data-pair-contact @submit.prevent="pair">
        <label class="flex flex-col gap-1">
            <span class="text-xs text-muted">{{ t(`sandbox.messages.pair.which`) }}</span>
            <Picker
                v-model="farId"
                :options="farOptions"
                variant="input"
                :aria-label="t(`sandbox.messages.pair.which`)"
                :header="t(`sandbox.messages.pair.which`)"
                :placeholder="t(`sandbox.messages.pair.pickOne`)"
                class="ui-field-sm max-w-sm"
            />
        </label>
        <div class="flex flex-col gap-1">
            <span class="flex items-center gap-1 text-xs text-muted">
                {{ t(`sandbox.messages.pair.speaksAs`) }}
                <InfoHint :label="t(`sandbox.messages.pair.speaksAs`)">
                    <span class="block text-xs text-content">{{ t(`sandbox.messages.pair.speaksAsHint`) }}</span>
                </InfoHint>
            </span>
            <SegmentedControl v-model="scope" :options="scopes" :aria-label="t(`sandbox.messages.pair.speaksAs`)" />
        </div>
        <Notice v-if="notice" :of="notice" />
        <div class="flex items-center justify-end gap-2">
            <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="pairing" @click="emit(`cancel`)" />
            <Button tier="accent" type="submit" size="small" :label="t(`sandbox.messages.pair.pair`)" :loading="pairing" :disabled="pairing || farId === undefined">
                <template #icon><Icon name="link" /></template>
            </Button>
        </div>
    </form>
</template>
