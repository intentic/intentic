<script setup lang="ts">
import {
    PRIVACY_DICTIONARY_SAMPLE_MAX,
    PRIVACY_OWN_LISTS_MAX,
    type PrivacyNameList,
    type PrivacyNameListKind,
    type PrivacyOwnNameList,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract/schemas/privacy";
import { DisclosureRow, FilterBar, Icon, Notice, ui } from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { dictionaryOf, inflects, mintId, newOwnList, withListOn, withOwnList, withOwnListBack, withoutOwnList } from "./privacyOwn";
import { type NameTrait, nameVerdict, shownWord, sourceHost, traitsOf } from "./privacyShield";
import PrivacyOwnListEditor from "./PrivacyOwnListEditor.vue";
import { usePrivacyDictionary } from "../../../models/sandbox/usePrivacyShield";

// What the shield's name dictionary holds, under "Finding names", and the owner's say over it: each built-in list with
// how many words, how they are matched and where they come from, and a switch to stop reading it; the owner's own lists
// beside them, each opened in place to edit; and a search that browses the lists by a word's first letters and says
// whether a word or a full name would be masked. The lists are the detector's own, read by the daemon under the policy
// as saved, so what this shows is what it does. Every change is saved as it is made, handed up as a function of the
// policy as it stands then.

const t = useT();

const { policy, ready } = defineProps<{
    policy: PrivacyShieldPolicy | undefined;
    ready: boolean;
}>();

const emit = defineEmits<{ write: [change: (policy: PrivacyShieldPolicy) => PrivacyShieldPolicy] }>();

const open = ref(false);
const query = ref(``);
const { dictionary, answered, isFetching, error } = usePrivacyDictionary(query);

const lists = computed<readonly PrivacyNameList[]>(() => dictionary.value?.lists ?? []);

// The switches read the policy on screen, so a press shows at once; the daemon's answer catches up with the counts.
const ownLists = computed<readonly PrivacyOwnNameList[]>(() => dictionaryOf(policy).lists);
const off = computed(() => new Set(dictionaryOf(policy).off));

const summary = computed(() => {
    const totals = dictionary.value?.totals;
    if (totals === undefined) {
        return undefined;
    }
    const own = ownLists.value.length;
    return [
        t(`sandbox.agentPrivacyShield.dictionarySummary`, { firstNames: formatFixed(totals.firstNames, 0), surnames: formatFixed(totals.surnames, 0) }),
        own > 0 ? t(`sandbox.agentPrivacyShield.dictionarySummaryOwn`, { count: formatFixed(own, 0) }, own) : undefined,
        off.value.size > 0 ? t(`sandbox.agentPrivacyShield.dictionarySummaryOff`, { count: formatFixed(off.value.size, 0) }, off.value.size) : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
});

// Each list's title and note, by the id the daemon gives it; a list this build does not know shows its id and source.
const LISTS = computed<Readonly<Record<string, { readonly title: string; readonly note: string }>>>(() => ({
    "first-names-pl": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.firstNamesPl.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.firstNamesPl.note`),
    },
    "first-names-pl-rare": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.firstNamesPlRare.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.firstNamesPlRare.note`),
    },
    "diminutives-pl": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.diminutivesPl.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.diminutivesPl.note`),
    },
    "surnames-pl": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.surnamesPl.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.surnamesPl.note`),
    },
    "first-names-en": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.firstNamesEn.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.firstNamesEn.note`),
    },
    "nicknames-en": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.nicknamesEn.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.nicknamesEn.note`),
    },
    "surnames-en": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.surnamesEn.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.surnamesEn.note`),
    },
    "ambiguous-pl": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.ambiguousPl.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.ambiguousPl.note`),
    },
    "ambiguous-en": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.ambiguousEn.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.ambiguousEn.note`),
    },
    "common-words": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.commonWords.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.commonWords.note`),
    },
    "titles-pl": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.titlesPl.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.titlesPl.note`),
    },
    "titles-en": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.titlesEn.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.titlesEn.note`),
    },
    "never-names": {
        title: t(`sandbox.agentPrivacyShield.dictionaryLists.neverNames.title`),
        note: t(`sandbox.agentPrivacyShield.dictionaryLists.neverNames.note`),
    },
}));
const titleOf = (list: Pick<PrivacyNameList, `id`>): string =>
    LISTS.value[list.id]?.title ?? ownLists.value.find((own) => own.id === list.id)?.title ?? list.id;

const wordsText = (count: number): string => t(`sandbox.agentPrivacyShield.dictionaryWords`, { count: formatFixed(count, 0) }, count);
const matchingText = (inflected: boolean): string =>
    inflected ? t(`sandbox.agentPrivacyShield.dictionaryInflected`) : t(`sandbox.agentPrivacyShield.dictionaryAsWritten`);

const rows = computed(() =>
    lists.value
        .filter((list) => list.own !== true)
        .map((list) => ({
            list,
            on: !off.value.has(list.id),
            title: titleOf(list),
            note: LISTS.value[list.id]?.note ?? list.source,
            host: sourceHost(list.url),
            words: wordsText(list.count),
            matching: matchingText(list.matching === `inflected`),
        })),
);

// What a list of the owner's holds, in the words the kind switch uses.
const OWN_KINDS = computed(
    () =>
        ({
            "first-name": t(`sandbox.agentPrivacyShield.ownList.kinds.firstName`),
            surname: t(`sandbox.agentPrivacyShield.ownList.kinds.surname`),
            ambiguous: t(`sandbox.agentPrivacyShield.ownList.kinds.ambiguous`),
            title: t(`sandbox.agentPrivacyShield.ownList.kinds.title`),
            never: t(`sandbox.agentPrivacyShield.ownList.kinds.never`),
        }) satisfies Record<PrivacyNameListKind, string>,
);

const ownRows = computed(() =>
    ownLists.value.map((list) => ({
        list,
        kind: OWN_KINDS.value[list.kind],
        words: wordsText(list.words.length),
        matching: matchingText(inflects(list) && list.matching === `inflected`),
    })),
);

// One list of the owner's open for editing at a time, under its own row.
const editing = ref<string | undefined>(undefined);

const writeList = (id: string, change: (list: PrivacyOwnNameList) => PrivacyOwnNameList): void => {
    emit(`write`, (current) => {
        const list = dictionaryOf(current).lists.find((each) => each.id === id);
        return list === undefined ? current : withOwnList(current, change(list));
    });
};

const addList = (): void => {
    const id = mintId(`list`, ownLists.value);
    emit(`write`, (current) => withOwnList(current, newOwnList(id, t(`sandbox.agentPrivacyShield.ownList.untitled`))));
    removed.value = undefined;
    editing.value = id;
};

// The list last removed, to put back where it stood.
const removed = ref<{ readonly list: PrivacyOwnNameList; readonly index: number } | undefined>(undefined);
const removeList = (list: PrivacyOwnNameList): void => {
    removed.value = { list, index: ownLists.value.findIndex((each) => each.id === list.id) };
    editing.value = undefined;
    emit(`write`, (current) => withoutOwnList(current, list.id));
};
const undoRemove = (): void => {
    const back = removed.value;
    removed.value = undefined;
    if (back !== undefined) {
        emit(`write`, (current) => withOwnListBack(current, back.list, back.index));
    }
};

const TRAITS = computed(
    () =>
        ({
            firstName: t(`sandbox.agentPrivacyShield.dictionaryTraits.firstName`),
            surname: t(`sandbox.agentPrivacyShield.dictionaryTraits.surname`),
            surnameForm: t(`sandbox.agentPrivacyShield.dictionaryTraits.surnameForm`),
            ambiguous: t(`sandbox.agentPrivacyShield.dictionaryTraits.ambiguous`),
            never: t(`sandbox.agentPrivacyShield.dictionaryTraits.never`),
        }) satisfies Record<NameTrait, string>,
);

// The answer for what was typed, once typing has settled; nothing while the box is empty.
const lookup = computed(() => (answered.value === `` ? undefined : dictionary.value?.lookup));
const verdict = computed(() => {
    if (lookup.value === undefined) {
        return undefined;
    }
    const word = lookup.value.text;
    const kind = nameVerdict(lookup.value);
    return {
        kind,
        text: {
            found: t(`sandbox.agentPrivacyShield.dictionaryFound`, { word }),
            never: t(`sandbox.agentPrivacyShield.dictionaryNever`, { word }),
            needsContext: t(`sandbox.agentPrivacyShield.dictionaryNeedsContext`, { word }),
            notFound: t(`sandbox.agentPrivacyShield.dictionaryNotFound`, { word }),
        }[kind],
    };
});

const matches = computed(() =>
    answered.value === ``
        ? []
        : (dictionary.value?.matches ?? []).map((match) => ({
              word: shownWord(match.word, match.lists, lists.value),
              key: match.word,
              held: match.lists.map((id) => titleOf({ id })).join(`, `),
          })),
);
// A query of one word browses the lists; a full name only gets its verdict.
const browsing = computed(() => answered.value !== `` && !answered.value.includes(` `));

const INERT = `pointer-events-none opacity-60`;
</script>

<template>
    <DisclosureRow
        v-model:open="open"
        icon="book"
        :title="t(`sandbox.agentPrivacyShield.dictionaryTitle`)"
        :description="summary"
        :disabled="dictionary === undefined && error === undefined"
    >
        <template #below>
            <div class="flex flex-col gap-3 pb-1">
                <p class="text-2xs text-muted">{{ t(`sandbox.agentPrivacyShield.dictionaryIntro`) }}</p>

                <Notice v-if="error !== undefined" tone="danger">{{ error }}</Notice>

                <ul v-else class="flex flex-col divide-y divide-line-subtle">
                    <li v-for="row in rows" :key="row.list.id" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 py-1.5">
                        <span class="min-w-0 flex-1" :class="{ 'opacity-60': !row.on }">
                            <span class="block text-xs text-content">{{ row.title }}</span>
                            <span class="block text-2xs text-muted">
                                {{ row.note }}
                                <template v-if="row.host !== undefined">
                                    <a :href="row.list.url" target="_blank" rel="noreferrer noopener" class="text-link hover:underline">{{ row.host }}</a
                                    ><span v-if="row.list.license !== undefined" class="text-subtle"> · {{ row.list.license }}</span>
                                </template>
                                <span v-else class="text-subtle">· {{ t(`sandbox.agentPrivacyShield.dictionaryHandWritten`) }}</span>
                            </span>
                        </span>
                        <span class="flex shrink-0 items-center gap-3">
                            <span class="text-2xs text-subtle" :class="{ 'opacity-60': !row.on }">
                                <span class="tabular-nums text-content">{{ row.words }}</span> · {{ row.matching }}
                            </span>
                            <ToggleSwitch
                                :model-value="row.on"
                                :disabled="!ready"
                                :aria-label="t(`sandbox.agentPrivacyShield.dictionaryListOn`, { list: row.title })"
                                @update:model-value="(on: boolean) => emit(`write`, (current) => withListOn(current, row.list.id, on))"
                            />
                        </span>
                    </li>
                </ul>

                <!-- The owner's own lists, read beside the built-in ones; each opens in place to be edited. -->
                <div class="flex flex-col gap-2" :class="{ [INERT]: !ready }">
                    <div class="flex flex-col gap-0.5">
                        <p class="text-xs font-medium text-content">{{ t(`sandbox.agentPrivacyShield.ownLists`) }}</p>
                        <p class="text-2xs text-muted">{{ t(`sandbox.agentPrivacyShield.ownListsNote`) }}</p>
                    </div>
                    <ul v-if="ownRows.length > 0" class="flex flex-col divide-y divide-line-subtle">
                        <li v-for="row in ownRows" :key="row.list.id" class="flex flex-col gap-2 py-1.5">
                            <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5">
                                <button
                                    type="button"
                                    class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                    :class="{ 'opacity-60': !row.list.on }"
                                    :aria-expanded="editing === row.list.id"
                                    @click="editing = editing === row.list.id ? undefined : row.list.id"
                                >
                                    <Icon :name="editing === row.list.id ? `chevron-down` : `chevron-right`" class="shrink-0 text-3xs text-subtle" />
                                    <span class="min-w-0">
                                        <span class="block truncate text-xs text-content">{{ row.list.title }}</span>
                                        <span class="block text-2xs text-muted">{{ row.kind }}</span>
                                    </span>
                                </button>
                                <span class="flex shrink-0 items-center gap-3">
                                    <span class="text-2xs text-subtle" :class="{ 'opacity-60': !row.list.on }">
                                        <span class="tabular-nums text-content">{{ row.words }}</span> · {{ row.matching }}
                                    </span>
                                    <ToggleSwitch
                                        :model-value="row.list.on"
                                        :disabled="!ready"
                                        :aria-label="t(`sandbox.agentPrivacyShield.dictionaryListOn`, { list: row.list.title })"
                                        @update:model-value="(on: boolean) => writeList(row.list.id, (list) => ({ ...list, on }))"
                                    />
                                </span>
                            </div>
                            <PrivacyOwnListEditor
                                v-if="editing === row.list.id"
                                :list="row.list"
                                :ready="ready"
                                @write="(change) => writeList(row.list.id, change)"
                                @remove="removeList(row.list)"
                            />
                        </li>
                    </ul>
                    <p v-else class="text-2xs text-subtle">{{ t(`sandbox.agentPrivacyShield.ownListsEmpty`) }}</p>
                    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <button
                            v-if="ownLists.length < PRIVACY_OWN_LISTS_MAX"
                            type="button"
                            :class="ui.textButton({ size: `xs`, flush: true })"
                            @click="addList"
                        >
                            <Icon name="plus" class="text-3xs" />{{ t(`sandbox.agentPrivacyShield.ownListsAdd`) }}
                        </button>
                        <span v-if="removed !== undefined" aria-live="polite" class="flex items-baseline gap-1.5 text-2xs">
                            <span class="text-muted">{{ t(`sandbox.agentPrivacyShield.ownListsRemoved`, { list: removed.list.title }) }}</span>
                            <button type="button" :class="ui.textButton({ size: `xs`, flush: true })" @click="undoRemove">{{ t(`ui.action.undo`) }}</button>
                        </span>
                    </div>
                </div>

                <FilterBar
                    v-model="query"
                    :placeholder="t(`sandbox.agentPrivacyShield.dictionarySearch`)"
                    :aria-label="t(`sandbox.agentPrivacyShield.dictionarySearchLabel`)"
                    :busy="isFetching"
                    clearable
                />

                <div v-if="lookup !== undefined && verdict !== undefined" class="flex flex-col gap-1.5" :class="isFetching ? `opacity-60` : ``">
                    <!-- Each word of what was typed, with what the lists say of it. -->
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span v-for="(word, index) in lookup.words" :key="index" class="inline-flex flex-wrap items-center gap-1">
                            <span class="text-xs font-medium text-content">{{ word.word }}</span>
                            <span v-for="trait in traitsOf(word)" :key="trait" class="rounded bg-content/5 px-1.5 py-0.5 text-3xs text-subtle">{{
                                TRAITS[trait]
                            }}</span>
                        </span>
                    </div>
                    <p class="text-2xs" :class="verdict.kind === `found` ? `text-success` : `text-muted`">{{ verdict.text }}</p>
                </div>

                <div v-if="browsing" class="flex flex-col gap-1.5" :class="isFetching ? `opacity-60` : ``">
                    <template v-if="matches.length > 0">
                        <p class="text-2xs text-subtle">{{ t(`sandbox.agentPrivacyShield.dictionaryStartsWith`, { query: answered }) }}</p>
                        <!-- Words, not rows: a page of them reads at a glance, and which lists hold one is on hover. -->
                        <div class="flex flex-wrap gap-1">
                            <span
                                v-for="match in matches"
                                :key="match.key"
                                v-tooltip.top="match.held"
                                class="rounded bg-content/5 px-1.5 py-0.5 text-2xs text-content"
                                >{{ match.word }}</span
                            >
                        </div>
                        <p v-if="matches.length >= PRIVACY_DICTIONARY_SAMPLE_MAX" class="text-2xs text-subtle">
                            {{ t(`sandbox.agentPrivacyShield.dictionaryMore`, { count: PRIVACY_DICTIONARY_SAMPLE_MAX }) }}
                        </p>
                    </template>
                    <!-- Said only once the answer for this query is in: the one on screen may still be the last query's. -->
                    <p v-else-if="!isFetching" class="text-2xs text-subtle">{{ t(`sandbox.agentPrivacyShield.dictionaryNoMatches`, { query: answered }) }}</p>
                </div>
            </div>
        </template>
    </DisclosureRow>
</template>
