<script setup lang="ts">
import {
    PRIVACY_TITLE_MAX,
    type PrivacyNameListKind,
    type PrivacyNameMatching,
    type PrivacyOwnNameList,
} from "@intentic/sandbox-contract/schemas/privacy";
import { Button, SegmentedControl, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { inflects, OWN_WORD_LIMITS } from "./privacyOwn";
import PrivacyValueList from "./PrivacyValueList.vue";

// One of the owner's own name lists, opened under its row in the dictionary: its title, what its words are, whether a
// Polish name on it is matched in every form, and the words. Each change is saved as it is made, as everywhere on the
// page, handed up as a function of the list as it stands then.

const t = useT();

const { list, ready } = defineProps<{
    list: PrivacyOwnNameList;
    ready: boolean;
}>();

const emit = defineEmits<{
    write: [change: (list: PrivacyOwnNameList) => PrivacyOwnNameList];
    remove: [];
}>();

const KINDS = computed(() => [
    { label: t(`sandbox.agentPrivacyShield.ownList.kinds.firstName`), value: `first-name` as const },
    { label: t(`sandbox.agentPrivacyShield.ownList.kinds.surname`), value: `surname` as const },
    { label: t(`sandbox.agentPrivacyShield.ownList.kinds.ambiguous`), value: `ambiguous` as const },
    { label: t(`sandbox.agentPrivacyShield.ownList.kinds.title`), value: `title` as const },
    { label: t(`sandbox.agentPrivacyShield.ownList.kinds.never`), value: `never` as const },
]);

const KIND_NOTES = computed(
    () =>
        ({
            "first-name": t(`sandbox.agentPrivacyShield.ownList.kindNotes.firstName`),
            surname: t(`sandbox.agentPrivacyShield.ownList.kindNotes.surname`),
            ambiguous: t(`sandbox.agentPrivacyShield.ownList.kindNotes.ambiguous`),
            title: t(`sandbox.agentPrivacyShield.ownList.kindNotes.title`),
            never: t(`sandbox.agentPrivacyShield.ownList.kindNotes.never`),
        }) satisfies Record<PrivacyNameListKind, string>,
);

const MATCHING = computed(() => [
    { label: t(`sandbox.agentPrivacyShield.dictionaryInflected`), value: `inflected` as const },
    { label: t(`sandbox.agentPrivacyShield.dictionaryAsWritten`), value: `as-written` as const },
]);

// The title is typed here and saved when the field is left or Enter pressed; emptied, it goes back to what it was.
const title = ref(list.title);
watch(
    () => list.title,
    (saved) => {
        title.value = saved;
    },
);
const commitTitle = (): void => {
    const next = title.value.trim();
    if (next === `` || next === list.title) {
        title.value = list.title;
        return;
    }
    emit(`write`, (current) => ({ ...current, title: next }));
};

const labels = computed(() => ({
    field: t(`sandbox.agentPrivacyShield.ownList.wordsField`, { list: list.title }),
    placeholder: t(`sandbox.agentPrivacyShield.ownList.wordsPlaceholder`),
    empty: t(`sandbox.agentPrivacyShield.ownList.wordsEmpty`),
    hint: t(`sandbox.agentPrivacyShield.ownList.wordsHint`),
}));
</script>

<template>
    <div class="flex flex-col gap-3 rounded border border-line-subtle p-3" :class="{ 'pointer-events-none opacity-60': !ready }">
        <div class="flex flex-wrap items-center gap-2">
            <input
                v-model="title"
                type="text"
                autocomplete="off"
                spellcheck="false"
                :maxlength="PRIVACY_TITLE_MAX"
                :aria-label="t(`sandbox.agentPrivacyShield.ownList.titleField`)"
                :class="ui.input({ size: `sm` }, `min-w-0 flex-1`)"
                @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
                @keydown.esc.prevent="title = list.title"
                @blur="commitTitle"
            />
            <Button size="small" tier="quiet" tone="danger" @click="emit(`remove`)">{{ t(`sandbox.agentPrivacyShield.ownList.remove`) }}</Button>
        </div>

        <div class="flex flex-col gap-1.5">
            <SegmentedControl
                :model-value="list.kind"
                :options="KINDS"
                size="xs"
                wrap
                @update:model-value="(kind: PrivacyNameListKind) => emit(`write`, (current) => ({ ...current, kind }))"
            />
            <p class="text-2xs text-muted">{{ KIND_NOTES[list.kind] }}</p>
        </div>

        <div v-if="inflects(list)" class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <SegmentedControl
                :model-value="list.matching"
                :options="MATCHING"
                size="xs"
                @update:model-value="(matching: PrivacyNameMatching) => emit(`write`, (current) => ({ ...current, matching }))"
            />
            <span class="text-2xs text-subtle">{{ t(`sandbox.agentPrivacyShield.ownList.matchingNote`) }}</span>
        </div>

        <PrivacyValueList
            :values="list.words"
            :ready="ready"
            :limits="OWN_WORD_LIMITS"
            split="words"
            :labels="labels"
            @write="(change) => emit(`write`, (current) => ({ ...current, words: change(current.words) }))"
        />
    </div>
</template>
