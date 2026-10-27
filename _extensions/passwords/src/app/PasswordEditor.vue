<!-- The New sheet's few fields: a password that does not exist yet has nowhere to be changed in place. One that exists is
     changed where its detail shows each value (PasswordDetail.vue). -->
<script setup lang="ts">
import { Button, Icon, messageOr, Notice, ui } from "@intentic/extension-ui";
import { originKey } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { ref, useId } from "vue";
import { t } from "../i18n.js";
import { generatePassword } from "./generate.js";
import { parsePlace } from "./place.js";
import type { PasswordsPort } from "./port.js";
import { originLabel } from "./words.js";

const { port } = defineProps<{ port: PasswordsPort }>();
const emit = defineEmits<{ saved: [name: string]; cancel: [] }>();

const id = useId();
const title = ref(``);
const username = ref(``);
const value = ref(``);
const showValue = ref(false);
const origins = ref<KeyringOrigin[]>([]);
const place = ref(``);
const placeError = ref<string | undefined>(undefined);
const error = ref<string | undefined>(undefined);
const saving = ref(false);

const addPlace = (): boolean => {
    const typed = place.value.trim();
    if (typed === ``) {
        return true;
    }
    const origin = parsePlace(typed);
    if (origin === undefined) {
        placeError.value = t(`app.edit.badPlace`, { place: typed });
        return false;
    }
    placeError.value = undefined;
    if (!origins.value.some((known) => originKey(known) === originKey(origin))) {
        origins.value = [...origins.value, origin];
    }
    place.value = ``;
    return true;
};
const removePlace = (origin: KeyringOrigin): void => {
    origins.value = origins.value.filter((known) => originKey(known) !== originKey(origin));
};

const generate = (): void => {
    value.value = generatePassword();
    showValue.value = true;
};

const save = async (): Promise<void> => {
    // A place typed and not yet added is added by Save, as a person expects of a field they filled in.
    if (!addPlace()) {
        return;
    }
    if (title.value.trim() === `` && origins.value.length === 0) {
        error.value = t(`app.edit.needTitle`);
        return;
    }
    if (value.value === ``) {
        error.value = t(`app.edit.needValue`);
        return;
    }
    saving.value = true;
    error.value = undefined;
    try {
        const first = origins.value[0];
        const added = await port.add({
            title: title.value.trim() || (first === undefined ? `` : originLabel(first)),
            username: username.value.trim() || undefined,
            value: value.value,
            kind: `password`,
            origins: origins.value,
            note: undefined,
        });
        emit(`saved`, added.name);
    } catch (failure) {
        error.value = messageOr(failure, t(`app.error.act`));
    } finally {
        saving.value = false;
        value.value = ``;
    }
};
</script>

<template>
    <form class="flex flex-col gap-4" @submit.prevent="save()">
        <Notice v-if="error" tone="danger" size="sm" @dismiss="error = undefined">{{ error }}</Notice>

        <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">{{ t(`app.edit.title`) }}</span>
            <input v-model="title" :class="ui.input()" maxlength="200" autocomplete="off" />
        </label>

        <div class="flex flex-col gap-1.5">
            <label :for="`${id}-place`" class="text-xs font-medium text-muted">{{ t(`app.edit.site`) }}</label>
            <div v-if="origins.length > 0" class="flex flex-wrap gap-1.5">
                <span v-for="origin in origins" :key="originKey(origin)" :class="ui.chip({ trail: true })">
                    {{ originLabel(origin) }}
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `xs` })"
                        :aria-label="t(`app.edit.removePlace`, { place: originLabel(origin) })"
                        @click="removePlace(origin)"
                    >
                        <Icon name="times" />
                    </button>
                </span>
            </div>
            <div class="flex gap-2">
                <input
                    :id="`${id}-place`"
                    v-model="place"
                    :class="ui.input(`flex-1`)"
                    :placeholder="t(`app.edit.sitePlaceholder`)"
                    autocomplete="off"
                    @keydown.enter.prevent="addPlace()"
                />
            </div>
            <span v-if="placeError" class="text-2xs text-danger" role="alert">{{ placeError }}</span>
            <span v-else class="text-2xs text-subtle">{{ t(`app.edit.addPlaceHint`) }}</span>
        </div>

        <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">{{ t(`app.edit.username`) }}</span>
            <input v-model="username" :class="ui.input()" maxlength="256" autocomplete="off" spellcheck="false" />
        </label>

        <div class="flex flex-col gap-1">
            <label :for="`${id}-value`" class="text-xs font-medium text-muted">{{ t(`app.edit.password`) }}</label>
            <div class="flex gap-2">
                <input
                    :id="`${id}-value`"
                    v-model="value"
                    :type="showValue ? `text` : `password`"
                    :class="ui.input(`flex-1 font-mono`)"
                    autocomplete="new-password"
                    spellcheck="false"
                />
                <button
                    type="button"
                    :class="ui.iconButton({ size: `lg` })"
                    :aria-label="showValue ? t(`app.edit.hide`) : t(`app.edit.show`)"
                    :aria-pressed="showValue"
                    @click="showValue = !showValue"
                >
                    <Icon :name="showValue ? `eye-slash` : `eye`" />
                </button>
                <Button tier="boring" :label="t(`app.edit.generate`)" @click="generate()">
                    <template #icon><Icon name="sparkles" /></template>
                </Button>
            </div>
        </div>

        <div class="flex justify-end gap-2 pt-2">
            <Button tier="quiet" :label="t(`app.cancel`)" @click="emit(`cancel`)" />
            <Button tier="accent" type="submit" :label="t(`app.save`)" :loading="saving" />
        </div>
        <p v-if="saving" class="flex items-center justify-end gap-1.5 text-2xs text-info" role="status"><Icon name="spinner" spin />{{ t(`app.confirmHere`) }}</p>
    </form>
</template>
