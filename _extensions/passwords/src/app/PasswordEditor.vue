<!-- A password's fields, editable: in place on its detail, or as the New sheet's few fields when `item` is absent. -->
<script setup lang="ts">
import { Button, Icon, messageOr, Notice, SegmentedControl, ToggleSwitch, ui } from "@intentic/extension-ui";
import { originKey } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { computed, ref, useId } from "vue";
import { t } from "../i18n.js";
import { generatePassword } from "./generate.js";
import { parsePlace } from "./place.js";
import type { PasswordItem, PasswordPatch, PasswordsPort } from "./port.js";
import { originLabel } from "./words.js";

const { item, port } = defineProps<{ item?: PasswordItem; port: PasswordsPort }>();
const emit = defineEmits<{ saved: [name: string]; cancel: [] }>();

const id = useId();
const title = ref(item?.title ?? ``);
const username = ref(item?.username ?? ``);
const value = ref(``);
const showValue = ref(false);
const kind = ref<`password` | `text`>(item?.kind ?? `password`);
const origins = ref<KeyringOrigin[]>([...(item?.origins ?? [])]);
const note = ref(item?.note ?? ``);
const anyField = ref(item?.anyField ?? false);
const place = ref(``);
const placeError = ref<string | undefined>(undefined);
const error = ref<string | undefined>(undefined);
const saving = ref(false);

const kindOptions = computed(() => [
    { label: t(`app.edit.kindPassword`), value: `password` as const },
    { label: t(`app.edit.kindText`), value: `text` as const },
]);

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

const patchOf = (current: PasswordItem): PasswordPatch => {
    const patch: { -readonly [K in keyof PasswordPatch]: PasswordPatch[K] } = {};
    if (title.value.trim() !== current.title) {
        patch.title = title.value.trim();
    }
    if (username.value.trim() !== (current.username ?? ``)) {
        patch.username = username.value.trim();
    }
    if (value.value !== ``) {
        patch.value = value.value;
    }
    if (kind.value !== current.kind) {
        patch.kind = kind.value;
    }
    if (origins.value.map(originKey).join(`\n`) !== current.origins.map(originKey).join(`\n`)) {
        patch.origins = origins.value;
    }
    if (note.value.trim() !== (current.note ?? ``)) {
        patch.note = note.value.trim();
    }
    if (anyField.value !== current.anyField) {
        patch.anyField = anyField.value;
    }
    return patch;
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
    if (item === undefined && value.value === ``) {
        error.value = t(`app.edit.needValue`);
        return;
    }
    saving.value = true;
    error.value = undefined;
    try {
        if (item === undefined) {
            const first = origins.value[0];
            const added = await port.add({
                title: title.value.trim() || (first === undefined ? `` : originLabel(first)),
                username: username.value.trim() || undefined,
                value: value.value,
                kind: kind.value,
                origins: origins.value,
                note: note.value.trim() || undefined,
            });
            emit(`saved`, added.name);
        } else {
            await port.edit(item.name, patchOf(item));
            emit(`saved`, item.name);
        }
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
            <label :for="`${id}-place`" class="text-xs font-medium text-muted">{{ item === undefined ? t(`app.edit.site`) : t(`app.edit.worksOn`) }}</label>
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
                    :placeholder="item === undefined ? t(`app.edit.sitePlaceholder`) : t(`app.edit.addPlace`)"
                    autocomplete="off"
                    @keydown.enter.prevent="addPlace()"
                />
                <Button v-if="item !== undefined" tier="boring" :label="t(`app.edit.add`)" :disabled="place.trim() === ``" @click="addPlace()" />
            </div>
            <span v-if="placeError" class="text-2xs text-danger" role="alert">{{ placeError }}</span>
            <span v-else class="text-2xs text-subtle">{{ t(`app.edit.addPlaceHint`) }}</span>
        </div>

        <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">{{ t(`app.edit.username`) }}</span>
            <input v-model="username" :class="ui.input()" maxlength="256" autocomplete="off" spellcheck="false" />
        </label>

        <div class="flex flex-col gap-1">
            <label :for="`${id}-value`" class="text-xs font-medium text-muted">{{ kind === `text` ? t(`app.edit.value`) : t(`app.edit.password`) }}</label>
            <div class="flex gap-2">
                <input
                    :id="`${id}-value`"
                    v-model="value"
                    :type="showValue ? `text` : `password`"
                    :class="ui.input(`flex-1 font-mono`)"
                    autocomplete="new-password"
                    spellcheck="false"
                    :placeholder="item === undefined ? `` : t(`app.edit.keepValue`)"
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

        <template v-if="item !== undefined">
            <div class="flex flex-col gap-1">
                <span class="text-xs font-medium text-muted">{{ t(`app.edit.kind`) }}</span>
                <SegmentedControl v-model="kind" :options="kindOptions" :aria-label="t(`app.edit.kind`)" />
            </div>
            <label class="flex items-start gap-3">
                <ToggleSwitch v-model="anyField" :aria-label="t(`app.edit.anyField`)" />
                <span class="flex flex-col">
                    <span class="text-sm text-content">{{ t(`app.edit.anyField`) }}</span>
                    <span class="text-2xs text-subtle">{{ t(`app.edit.anyFieldHelp`) }}</span>
                </span>
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-xs font-medium text-muted">{{ t(`app.edit.note`) }}</span>
                <textarea v-model="note" :class="ui.input(`min-h-20`)" maxlength="500" rows="3" />
            </label>
        </template>

        <div class="flex justify-end gap-2 pt-2">
            <Button tier="quiet" :label="t(`app.cancel`)" @click="emit(`cancel`)" />
            <Button type="submit" :label="t(`app.save`)" :loading="saving" />
        </div>
        <p v-if="saving" class="flex items-center justify-end gap-1.5 text-2xs text-info" role="status"><Icon name="spinner" spin />{{ t(`app.confirmHere`) }}</p>
    </form>
</template>
