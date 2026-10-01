<script setup lang="ts">
import { PRIVACY_DICTIONARY_SAMPLE_MAX, type PrivacyNameList } from "@intentic/sandbox-contract";
import { DisclosureRow, FilterBar, Notice } from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { type NameTrait, nameVerdict, shownWord, sourceHost, traitsOf } from "./privacyShield";
import { usePrivacyDictionary } from "./usePrivacyShield";

// What the shield's name dictionary holds, under "Finding names": each list with how many words, how they are matched
// and where they come from, and a search that browses the lists by a word's first letters and says whether a word or a
// full name would be masked. The lists are the detector's own, read by the daemon, so what this shows is what it does.

const t = useT();

const open = ref(false);
const query = ref(``);
const { dictionary, answered, isFetching, error } = usePrivacyDictionary(query);

const lists = computed<readonly PrivacyNameList[]>(() => dictionary.value?.lists ?? []);

const summary = computed(() => {
    const totals = dictionary.value?.totals;
    return totals === undefined
        ? undefined
        : t(`sandbox.agentPrivacyShield.dictionarySummary`, {
              firstNames: formatFixed(totals.firstNames, 0),
              surnames: formatFixed(totals.surnames, 0),
          });
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
const titleOf = (list: Pick<PrivacyNameList, `id`>): string => LISTS.value[list.id]?.title ?? list.id;

const rows = computed(() =>
    lists.value.map((list) => ({
        list,
        title: titleOf(list),
        note: LISTS.value[list.id]?.note ?? list.source,
        host: sourceHost(list.url),
        words: t(`sandbox.agentPrivacyShield.dictionaryWords`, { count: formatFixed(list.count, 0) }, list.count),
        matching: list.matching === `inflected` ? t(`sandbox.agentPrivacyShield.dictionaryInflected`) : t(`sandbox.agentPrivacyShield.dictionaryAsWritten`),
    })),
);

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
                    <li v-for="row in rows" :key="row.list.id" class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
                        <span class="min-w-0 flex-1">
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
                        <span class="shrink-0 text-2xs text-subtle">
                            <span class="tabular-nums text-content">{{ row.words }}</span> · {{ row.matching }}
                        </span>
                    </li>
                </ul>

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
