<!-- A value too short for the sandbox to hide from the model: what that means, and the way out that fits where the value lives. -->
<script setup lang="ts">
import { Button, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { SECRET_MASK_MIN } from "@intentic/sandbox-contract/schemas/secrets";
import { computed, ref } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { useSecrets } from "../../../../models/capabilities/useSecrets";
import SecretFact from "./SecretFact.vue";
import { FIXED_VALUE, VALUE_NOTE } from "./secretLook";

const t = useT();

const { row } = defineProps<{ row: SecretRow }>();
// Mounted only on a row that has one; the fallback keeps the types honest rather than asserting.
const short = computed(() => row.tooShort ?? { names: [], replaceable: false });

const { regenerate } = useSecrets();
const confirming = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

// A connection holds several values; naming the field says which one, where the row's own name would not.
const which = computed(() => short.value.names.filter((name) => name !== row.entry.key).join(`, `));
// The way out, by where the value lives: one press for a value a person set here, the account's site for a connection,
// the computer for a keyring's entry.
const fix = computed(() => {
    if (short.value.replaceable) {
        return t(`capabilities.secretTooShort.replaceCaution`);
    }
    if (row.entry.device !== undefined) {
        return t(`capabilities.secretTooShort.onComputer`, { machine: row.entry.device.machine, min: SECRET_MASK_MIN });
    }
    return row.group === `credential`
        ? t(`capabilities.secretTooShort.onSite`, { min: SECRET_MASK_MIN })
        : t(`capabilities.secretTooShort.longer`, { min: SECRET_MASK_MIN });
});

const replace = async (): Promise<void> => {
    error.value = undefined;
    try {
        // The inventory refreshes without the warning, which moves the row out of what needs attention: that is the answer.
        await regenerate.mutateAsync(row.entry.key);
    } catch (err) {
        error.value = noticeFrom(err, t(`capabilities.secretTooShort.couldNotReplace`));
    } finally {
        confirming.value = false;
    }
};
</script>

<template>
    <SecretFact :label="t(`capabilities.secretTooShort.label`)">
        <span :class="FIXED_VALUE" data-secret-too-short>
            <span class="text-sm text-warning">{{
                which === `` ? t(`capabilities.secretTooShort.title`) : t(`capabilities.secretTooShort.titleNamed`, { names: which })
            }}</span>
            <span :class="VALUE_NOTE">{{ t(`capabilities.secretTooShort.explain`) }}</span>
            <span :class="VALUE_NOTE" class="mt-1">{{ fix }}</span>
            <span v-if="short.replaceable" class="flex flex-wrap items-center gap-1.5 pt-1.5">
                <Button v-if="!confirming" size="small" tier="boring" :label="t(`capabilities.secretTooShort.replace`)" @click="confirming = true" />
                <template v-else>
                    <Button size="small" tier="accent" tone="warning" :label="t(`capabilities.secretTooShort.confirm`)" @click="replace" />
                    <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="confirming = false" />
                </template>
            </span>
        </span>
        <Notice v-if="error" :of="error" class="mt-1" />
    </SecretFact>
</template>
