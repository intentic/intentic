<!-- The browser's history page (Ctrl+H): where a profile's browser has been, newest first, a day to a heading, searchable,
     each page openable here or in a new tab and removable on its own, a stretch of time or all of it clearable at once.
     Drawn by the editor from the history index the address bar already holds (omnibox/useBrowsingHistory.ts), so it opens
     instantly and needs no page in the sandbox's browser. Whose history it is can be switched to an agent's browser,
     never mixed with the person's own. -->
<script setup lang="ts">
import { OWN_BROWSING_PROFILE, SEARCH_ENGINES, type SearchEngine,type BrowsingEntry } from "@intentic/sandbox-contract/schemas/browsing";
import { AnchoredOverlay, Button, EmptyState, Icon, Picker, SearchBar, ui } from "@intentic/ui";
import { formatClock, formatDayLong } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, watch } from "vue";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import { engineName, engineOf } from "../omnibox/engines";
import { shownAddress } from "../omnibox/rank";
import { useBrowsingHistory } from "../omnibox/useBrowsingHistory";
import { CLEAR_SPANS, type ClearSpan, dayName, historyDays } from "./historyDays";

const emit = defineEmits<{ open: [url: string, newTab: boolean]; close: [] }>();

const t = useT();
const profile = ref(OWN_BROWSING_PROFILE);
const { history, refresh, forget } = useBrowsingHistory(profile);
watch(profile, () => void refresh(), { immediate: true });

// The pages shown a screenful at a time: a profile's history is thousands of pages.
const PAGE = 200;
const search = ref(``);
const limit = ref(PAGE);
watch([search, profile], () => (limit.value = PAGE));
const list = computed(() => historyDays(history.value.entries, search.value, limit.value));

const PROFILE_NAMES = computed<Readonly<Record<string, string>>>(() => ({
    [OWN_BROWSING_PROFILE]: t(`browsers.browsers.yourBrowser`),
    web: t(`browsers.history.agents`),
}));
const profileOptions = computed(() =>
    [...new Set([OWN_BROWSING_PROFILE, ...history.value.profiles])].map((name) => ({
        value: name,
        label: PROFILE_NAMES.value[name] ?? name,
        icon: name === OWN_BROWSING_PROFILE ? (`user` as const) : name === `web` ? (`robot` as const) : (`globe` as const),
    })),
);

// The sandbox's search engine, set here beside the history it searches with.
const { settings, patch } = useSandboxSettings();
const engineOptions = SEARCH_ENGINES.map((engine) => ({ value: engine, label: engineName(engine), icon: `search` as const }));
const engine = computed<SearchEngine | undefined>({
    get: () => engineOf(settings.value?.searchEngine),
    set: (value) => {
        if (value !== undefined && value !== settings.value?.searchEngine) {
            patch({ searchEngine: value });
        }
    },
});

const now = ref(Date.now());
const headingOf = (day: number): string => {
    const name = dayName(day, now.value);
    return name.kind === `today` ? t(`browsers.history.today`) : name.kind === `yesterday` ? t(`browsers.history.yesterday`) : formatDayLong(name.at);
};

const openEntry = (entry: BrowsingEntry, event: MouseEvent): void => {
    emit(`open`, entry.url, event.ctrlKey || event.metaKey || event.button === 1);
};

const clearOpen = ref(false);
const clearAnchor = ref<HTMLElement | undefined>();
const toggleClear = (event: MouseEvent): void => {
    clearAnchor.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    clearOpen.value = !clearOpen.value;
};
const clearChoices = computed(() => [
    { span: `hour` as const, label: t(`browsers.history.clearHour`) },
    { span: `day` as const, label: t(`browsers.history.clearDay`) },
    { span: `week` as const, label: t(`browsers.history.clearWeek`) },
    { span: `all` as const, label: t(`browsers.history.clearAll`) },
]);
const confirming = ref(false);
const clear = async (span: ClearSpan): Promise<void> => {
    if (span === `all` && !confirming.value) {
        confirming.value = true;
        return;
    }
    clearOpen.value = false;
    confirming.value = false;
    const to = Date.now() + 1;
    await forget(span === `all` ? { kind: `all` } : { kind: `range`, from: to - CLEAR_SPANS[span], to });
};
watch(clearOpen, (shown) => {
    if (!shown) {
        confirming.value = false;
    }
});

const root = ref<HTMLElement | undefined>();
onMounted(() => {
    now.value = Date.now();
    root.value?.querySelector<HTMLInputElement>(`input`)?.focus();
});

const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Escape` && !event.defaultPrevented && !clearOpen.value) {
        event.preventDefault();
        emit(`close`);
    }
};
</script>

<template>
    <section ref="root" class="flex h-full min-h-0 flex-col bg-card" :aria-label="t(`browsers.history.title`)" @keydown="onKeydown">
        <header class="flex shrink-0 flex-col gap-2 border-b border-line px-4 pb-3 pt-3">
            <div class="flex items-center gap-2">
                <slot name="heading">
                    <h2 class="min-w-0 flex-1 truncate text-sm font-medium text-content">{{ t(`browsers.history.title`) }}</h2>
                </slot>
                <button
                    type="button"
                    :class="ui.iconButton({ size: `md`, round: true })"
                    :aria-label="t(`browsers.history.close`)"
                    v-tooltip.bottom="t(`browsers.history.close`)"
                    @click="emit(`close`)"
                >
                    <Icon name="times" class="text-xs" />
                </button>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <SearchBar v-model="search" variant="field" clearable class="min-w-48 flex-1" :placeholder="t(`browsers.history.search`)" :aria-label="t(`browsers.history.search`)" />
                <Picker v-model="profile" :options="profileOptions" variant="ghost" :aria-label="t(`browsers.history.whose`)" :header="t(`browsers.history.whose`)" />
                <Picker v-model="engine" :options="engineOptions" variant="ghost" :aria-label="t(`browsers.history.searchEngine`)" :header="t(`browsers.history.searchEngine`)" />
                <Button size="small" tier="boring" aria-haspopup="menu" :aria-expanded="clearOpen" @click="toggleClear">
                    {{ t(`browsers.history.clear`) }}
                </Button>
                <AnchoredOverlay v-model="clearOpen" :anchor="clearAnchor" side="bottom" cross="end">
                    <div class="flex w-56 flex-col gap-0.5 p-1">
                        <template v-if="!confirming">
                            <button
                                v-for="choice in clearChoices"
                                :key="choice.span"
                                type="button"
                                class="flex cursor-pointer items-center rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                                @click="clear(choice.span)"
                            >
                                {{ choice.label }}
                            </button>
                        </template>
                        <div v-else class="flex flex-col gap-2 p-1.5">
                            <p class="text-xs text-content">{{ t(`browsers.history.confirmAll`) }}</p>
                            <div class="flex justify-end gap-1.5">
                                <Button size="small" tier="quiet" @click="confirming = false">{{ t(`ui.action.cancel`) }}</Button>
                                <Button size="small" tier="accent" tone="danger" @click="clear(`all`)">{{ t(`browsers.history.clear`) }}</Button>
                            </div>
                        </div>
                    </div>
                </AnchoredOverlay>
            </div>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto">
            <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-2 py-3">
                <EmptyState
                    v-if="list.days.length === 0"
                    icon="history"
                    :title="!history.loaded ? t(`browsers.history.loading`) : search.trim() === `` ? t(`browsers.history.empty`) : t(`browsers.history.noMatch`, { query: search.trim() })"
                />
                <section v-for="day in list.days" :key="day.day" class="flex flex-col">
                    <h3 class="px-2 pb-1 text-2xs font-medium text-muted">{{ headingOf(day.day) }}</h3>
                    <a
                        v-for="entry in day.entries"
                        :key="entry.url"
                        :href="entry.url"
                        class="ui-row-select group/entry flex items-center gap-3 rounded-md px-2 py-1.5 text-xs"
                        @click.prevent="openEntry(entry, $event)"
                        @auxclick.prevent="openEntry(entry, $event)"
                    >
                        <span class="w-16 shrink-0 whitespace-nowrap tabular-nums text-subtle">{{ formatClock(entry.last) }}</span>
                        <!-- The favicon's place, a globe until pages carry their site's icon. -->
                        <span class="flex size-4 shrink-0 items-center justify-center text-subtle" aria-hidden="true">
                            <Icon name="globe" class="text-2xs" />
                        </span>
                        <span class="flex min-w-0 flex-1 items-baseline gap-2">
                            <span class="truncate text-content">{{ entry.title ?? shownAddress(entry.url) }}</span>
                            <span class="truncate text-subtle">{{ shownAddress(entry.url) }}</span>
                        </span>
                        <span v-if="entry.visits > 1" class="shrink-0 tabular-nums text-3xs text-subtle">{{ t(`browsers.history.visits`, { count: entry.visits }, entry.visits) }}</span>
                        <button
                            type="button"
                            class="flex size-6 shrink-0 items-center justify-center rounded-full text-subtle opacity-0 transition-opacity hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover/entry:opacity-100"
                            :aria-label="t(`browsers.omnibox.remove`)"
                            v-tooltip.bottom="t(`ui.action.remove`)"
                            @click.stop.prevent="forget({ kind: `urls`, urls: [entry.url] })"
                        >
                            <Icon name="times" class="text-3xs" />
                        </button>
                    </a>
                </section>
                <Button v-if="list.more" size="small" tier="quiet" class="self-center" @click="limit += PAGE">{{ t(`browsers.history.showMore`) }}</Button>
            </div>
        </div>
    </section>
</template>
