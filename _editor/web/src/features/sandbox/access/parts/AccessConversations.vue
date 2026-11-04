<!-- WHO READS WHOSE CONVERSATIONS, on Access ▸ People beside who may come in (sandbox-contract schemas/seal.ts): everyone
     who can see a conversation's part of the workspace, or each author choosing, or private by default. One choice, saved
     as it is pressed, for Full access and the owner; anyone else reads it. An organisation that fixed it holds it, and the
     block says so. Under it, honestly, what a private conversation is sealed from here, which depends on whose machine
     the sandbox runs on. -->
<script setup lang="ts">
import type { SealMode } from "@intentic/sandbox-contract/schemas/seal";
import { Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRole } from "../../../../client/sandbox/useRole";
import { useSealHouse } from "../../../../models/conversations/seal/useSealHouse";

const t = useT();

const { house, setMode } = useSealHouse();
const { canShip } = useRole();

const MODES: readonly SealMode[] = [`everyone`, `chooses`, `private`];
const label = (mode: SealMode): string => t(`sandbox.sealHouse.mode.${mode}`);
const options = computed(() => MODES.map((mode) => ({ value: mode, label: label(mode), disabled: saving.value })));
const changeable = computed(() => canShip.value && house.value?.locked !== true);
// Who changes it, when the reader cannot; then, honestly, what a private conversation is sealed from on this machine.
const note = computed((): string => {
    const answer = house.value;
    if (answer === undefined) {
        return ``;
    }
    const who = answer.locked ? t(`sandbox.sealHouse.locked`) : canShip.value ? undefined : t(`sandbox.sealHouse.whoChanges`);
    const machine = answer.hosted ? undefined : t(`sandbox.sealHouse.ownMachine`);
    const count = answer.sealed > 0 ? t(`sandbox.sealHouse.count`, { count: answer.sealed }, answer.sealed) : undefined;
    return [who, t(`sandbox.sealHouse.honest`), machine, count].filter((part) => part !== undefined).join(` `);
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
        <Row :title="t(`sandbox.sealHouse.rule`)" :description="t(`sandbox.sealHouse.hint.${house.mode}`)">
            <template #control>
                <SegmentedControl v-if="changeable" :model-value="house.mode" :options="options" @update:model-value="choose" />
                <span v-else class="text-sm text-content" data-seal-mode>{{ label(house.mode) }}</span>
            </template>
        </Row>
        <RowNote v-if="failure !== undefined"><span role="alert" class="text-danger">{{ failure }}</span></RowNote>
        <!-- What private means here, said plainly: sealed in the app and from every agent, and on a machine of your own, not from its shell. -->
        <RowNote>{{ note }}</RowNote>
    </RowGroup>
</template>
