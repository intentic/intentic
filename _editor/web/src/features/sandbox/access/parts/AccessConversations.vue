<!-- WHO READS WHOSE CONVERSATIONS, on Access ▸ People beside who may come in (sandbox-contract schemas/seal.ts): everyone
     who can see a conversation's part of the workspace, or each author choosing, or private by default. One choice, saved
     as it is pressed, for Full access and the owner; anyone else reads it. An organisation that fixed it holds it, and the
     block says so. Its (i) says, honestly, what a private conversation is sealed from here, which depends on whose machine
     the sandbox runs on. -->
<script setup lang="ts">
import type { SealMode } from "@intentic/sandbox-contract/schemas/seal";
import { InfoHint, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useTier } from "../../../../client/sandbox/useTier";
import { useSealHouse } from "../../../../models/conversations/seal/useSealHouse";

const t = useT();

const { house, setMode } = useSealHouse();
const { canShip } = useTier();

const MODES: readonly SealMode[] = [`everyone`, `chooses`, `private`];
const label = (mode: SealMode): string => t(`sandbox.sealHouse.mode.${mode}`);
const options = computed(() => MODES.map((mode) => ({ value: mode, label: label(mode), disabled: saving.value })));
const changeable = computed(() => canShip.value && house.value?.locked !== true);
// What is true now: who changes it, when the reader cannot, and how many are private. Empty draws no note.
const note = computed((): string => {
    const answer = house.value;
    if (answer === undefined) {
        return ``;
    }
    const who = answer.locked ? t(`sandbox.sealHouse.locked`) : canShip.value ? undefined : t(`sandbox.sealHouse.whoChanges`);
    const count = answer.sealed > 0 ? t(`sandbox.sealHouse.count`, { count: answer.sealed }, answer.sealed) : undefined;
    return [who, count].filter((part) => part !== undefined).join(` `);
});

const saving = ref(false);
const failure = ref<string>();
const choose = async (mode: SealMode): Promise<void> => {
    if (mode === house.value?.mode) {
        return;
    }
    saving.value = true;
    failure.value = undefined;
    try {
        await setMode(mode);
    } catch (error) {
        failure.value = messageOr(error, t(`sandbox.sealHouse.saveFailed`));
    } finally {
        saving.value = false;
    }
};
</script>

<template>
    <RowGroup v-if="house !== undefined" data-setting="access-conversations" :label="t(`sandbox.sealHouse.title`)">
        <!-- What private means here, said plainly: sealed in the app and from every agent, and on a machine of your own, not from its shell. -->
        <template #info>
            <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`sandbox.sealHouse.title`) })">
                <span class="flex flex-col gap-2 text-xs text-content">
                    <span>{{ t(`sandbox.sealHouse.honest`) }}</span>
                    <span v-if="!house.hosted" class="text-muted">{{ t(`sandbox.sealHouse.ownMachine`) }}</span>
                </span>
            </InfoHint>
        </template>
        <Row :title="t(`sandbox.sealHouse.rule`)" :description="t(`sandbox.sealHouse.hint.${house.mode}`)">
            <template #control>
                <SegmentedControl v-if="changeable" :model-value="house.mode" :options="options" @update:model-value="choose" />
                <span v-else class="text-sm text-content" data-seal-mode>{{ label(house.mode) }}</span>
            </template>
        </Row>
        <RowNote v-if="failure !== undefined"><span role="alert" class="text-danger">{{ failure }}</span></RowNote>
        <RowNote v-if="note !== ``">{{ note }}</RowNote>
    </RowGroup>
</template>
