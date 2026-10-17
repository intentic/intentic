<!-- The hub search's answers, in place of the hub's index while something is typed: grouped by hub, this hub first. -->
<script setup lang="ts">
import { Row, RowGroup, ui } from "@intentic/ui";
import { sectionIcon } from "@intentic/ui/icons";
import { useT } from "@intentic/ui/i18n";
import { useRoute, useRouter } from "vue-router";
import { searchInQuickOpen, useQuickOpen } from "../commands/useQuickOpen";
import type { HubSearchResult } from "./hubSearch";
import type { HubSearchPanel } from "./useHubSearchPanel";

const t = useT();

const { search, listId, look } = defineProps<{
    search: HubSearchPanel;
    listId: string;
    /** `rail`: the desktop column's dense rows. `page`: a phone's index, where a row gets the whole width. */
    look: `rail` | `page`;
}>();

const route = useRoute();
const router = useRouter();

// A real link, so a middle press or a modified one opens the answer in a tab of its own as any link does; a plain
// press goes there here and lands on the card.
const href = (result: HubSearchResult): string => router.resolve(result.to).href;
const press = (event: MouseEvent, result: HubSearchResult): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
    }
    event.preventDefault();
    search.open(result);
};

// The answer whose card is on screen now, so the list says where the reader already is.
const current = (result: HubSearchResult): boolean =>
    route.path === result.to.path &&
    route.hash === result.to.hash &&
    Object.entries(result.to.query).every(([key, value]) => route.query[key] === value);

// Nothing in either hub: the palette searches agents, files and commands too, and the words are carried over, so a
// miss here is one press from a wider search rather than a dead end. Offered only where this window draws a palette.
const { mounted: paletteHere } = useQuickOpen();
const words = (): string => search.query.value.trim();
</script>

<template>
    <div :id="listId" role="listbox" :aria-label="t(`shell.hubSearch.results`)" :class="look === `page` ? `flex flex-col gap-6` : `flex flex-col`">
        <template v-for="group in search.groups.value" :key="group.hub">
            <!-- The rail's own heading style, so an answer list reads as the index it stands in for. -->
            <section v-if="look === `rail`" role="group" :aria-label="group.heading" class="pt-3 first:pt-0">
                <h3 aria-hidden="true" class="pb-1 pl-2 pr-1" :class="ui.sectionLabel({ size: `xs` })">{{ group.heading }}</h3>
                <div class="flex flex-col gap-0.5">
                    <a
                        v-for="(result, index) in group.results"
                        :id="`${listId}-${group.from + index}`"
                        :key="result.key"
                        :ref="(el) => search.setRowEl(result.key, el)"
                        :href="href(result)"
                        role="option"
                        tabindex="-1"
                        :aria-selected="group.from + index === search.activeIndex.value"
                        class="block"
                        @click="press($event, result)"
                        @mouseenter="search.activeIndex.value = group.from + index"
                    >
                        <Row
                            as="div"
                            density="dense"
                            :icon="sectionIcon(result.slug, result.icon)"
                            :title="result.title"
                            :description="result.trail === `` ? undefined : result.trail"
                            :selected="current(result)"
                            interactive
                            class="rounded-lg"
                            :class="{ 'ui-row-select-on': group.from + index === search.activeIndex.value }"
                        />
                    </a>
                </div>
            </section>
            <!-- A phone's index: each answer a full-width row, as each section is there. -->
            <RowGroup v-else role="group" :label="group.heading">
                <a
                    v-for="(result, index) in group.results"
                    :id="`${listId}-${group.from + index}`"
                    :key="result.key"
                    :href="href(result)"
                    role="option"
                    :aria-selected="group.from + index === search.activeIndex.value"
                    class="block"
                    @click="press($event, result)"
                >
                    <Row
                        as="div"
                        interactive
                        chevron
                        :icon="sectionIcon(result.slug, result.icon)"
                        :title="result.title"
                        :description="result.trail === `` ? undefined : result.trail"
                    />
                </a>
            </RowGroup>
        </template>

        <div v-if="search.rows.value.length === 0" role="status" class="flex flex-col items-start gap-1.5 px-2 py-2 text-xs">
            <p class="text-muted">{{ t(`shell.hubSearch.noMatches`, { query: words() }) }}</p>
            <button v-if="paletteHere" type="button" :class="ui.textButton()" @click="searchInQuickOpen(words())">
                <Icon name="search" class="text-2xs" aria-hidden="true" />{{ t(`shell.hubSearch.searchEverything`, { query: words() }) }}
            </button>
        </div>
    </div>
</template>
