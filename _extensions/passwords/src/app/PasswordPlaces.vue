<!-- Where a password works, changed where it is read: a place's × takes it off, and a place typed under them is added with
     Enter. Each change is written on its own (through the person's yes at the computer), never gathered behind a Save. -->
<script setup lang="ts">
import { Button, Icon, ui } from "@intentic/extension-ui";
import { originKey } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { ref, useId } from "vue";
import { t } from "../i18n.js";
import { parsePlace } from "./place.js";
import { originLabel } from "./words.js";

const { origins, editable = false, busy = false } = defineProps<{
    origins: readonly KeyringOrigin[];
    /** May this reader change them (the computer lets this app manage passwords). */
    editable?: boolean;
    busy?: boolean;
}>();
const emit = defineEmits<{ change: [origins: KeyringOrigin[]] }>();

const id = useId();
const place = ref(``);
const placeError = ref<string | undefined>(undefined);

const add = (): void => {
    const typed = place.value.trim();
    if (typed === ``) {
        return;
    }
    const origin = parsePlace(typed);
    if (origin === undefined) {
        placeError.value = t(`app.edit.badPlace`, { place: typed });
        return;
    }
    placeError.value = undefined;
    place.value = ``;
    if (!origins.some((known) => originKey(known) === originKey(origin))) {
        emit(`change`, [...origins, origin]);
    }
};
const remove = (origin: KeyringOrigin): void => {
    emit(
        `change`,
        origins.filter((known) => originKey(known) !== originKey(origin)),
    );
};
</script>

<template>
    <div class="flex flex-col gap-2">
        <div v-if="origins.length > 0" class="flex flex-wrap gap-1.5">
            <span v-for="origin in origins" :key="originKey(origin)" :class="ui.chip({ trail: editable })">
                {{ originLabel(origin) }}
                <button
                    v-if="editable"
                    type="button"
                    :class="ui.iconButton({ size: `xs` })"
                    :disabled="busy"
                    :aria-label="t(`app.edit.removePlace`, { place: originLabel(origin) })"
                    @click="remove(origin)"
                >
                    <Icon name="times" />
                </button>
            </span>
        </div>
        <span v-else class="text-xs text-muted">{{ t(`app.detail.worksNowhere`) }}</span>
        <template v-if="editable">
            <div class="flex gap-2">
                <input
                    :id="`${id}-place`"
                    v-model="place"
                    :class="ui.input({ size: `sm` }, `flex-1`)"
                    :placeholder="t(`app.edit.addPlace`)"
                    :aria-label="t(`app.edit.addPlace`)"
                    autocomplete="off"
                    :disabled="busy"
                    @keydown.enter.prevent="add()"
                />
                <Button tier="boring" size="small" :label="t(`app.edit.add`)" :disabled="busy || place.trim() === ``" @click="add()" />
            </div>
            <span v-if="placeError" class="text-2xs text-danger" role="alert">{{ placeError }}</span>
            <span v-else class="text-2xs text-subtle">{{ t(`app.edit.addPlaceHint`) }}</span>
        </template>
    </div>
</template>
