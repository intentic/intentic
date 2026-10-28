<script setup lang="ts">
import { browserOwnsClick, SearchBar, SectionHeader, useDevice, useListNavigation } from "@intentic/ui";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { isTrialProvider, termsOf } from "@intentic/sandbox-contract/models/agent-catalog";
import {
    accessBadge,
    accessKnown,
    accessStateFor,
    anyProviderReady,
    nothingShared,
    providerReady,
    providerRunnable,
    trialBadge,
    withheldBadge,
} from "../../../models/providers/access";
import { formatReset } from "../../../models/providers/usageStatus";
import { providerWithheld, spentModels } from "../../../models/providers/aiReach";
import { badgeMeta } from "./catalog";
import { type CatalogLoadState, providerModelsState } from "../../../models/providers/providerCatalog";
import {
    customEntryFor,
    filterEntries,
    foldUnconnected,
    isOlderEntry,
    newerThanEntry,
    type PickerEntry,
    type PickerLane,
    lanesOf,
    offeredProviders,
    pickerBlocks,
    pickerEntries,
    pickerSections,
    promotesFreeAccess,
} from "../../../models/conversations/accounts/modelPickerState";
import { loadAllProviderModels, loadProviderModels } from "../../../models/conversations/accounts/useChat-catalog";
import { refreshConnections } from "../../../models/conversations/accounts/useChat-accounts";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import PickerFoldRow from "./PickerFoldRow.vue";
import PickerConnectFirst from "./PickerConnectFirst.vue";
import PickerNothingShared from "./PickerNothingShared.vue";
import PickerRail from "./PickerRail.vue";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { modelsPath } from "../../../lib/routes/modelsPath";
import { browsingCatalog } from "../../../models/providers/loadBrowsingCatalog";
import PickerCatalogStatus from "./PickerCatalogStatus.vue";

const t = useT();

/* THE APP'S ONE MODEL PICKER (search + provider rail + one grouped list). */

/* `submit` is the keyboard's way to the `commit` slot, and it is deliberately NOT plain Enter. */
const emit = defineEmits<{ pick: [PickerEntry]; submit: []; close: [] }>();
const {
    provider,
    model,
    unpickable,
    leadRows,
    leadSelected,
    helperJobs = false,
} = defineProps<{
    // The pair the list checkmarks; both, since a model id is only meaningful under the provider that vends it.
    provider: AgentProvider;
    model: string;
    // Rows this caller can't switch to (mid-stream rule): true, or the reason, said where the row's description would be.
    unpickable?: (entry: PickerEntry) => boolean | string;
    // Rows pinned above every provider lane: a MODE rather than a model (Auto). They belong to no lane and no rail.
    leadRows?: readonly PickerEntry[];
    // Which lead row is the current selection, by key. Set, it is the only checkmark in the list: a mode and a model
    // cannot both be what the next turn runs, and two ticks would say they could.
    leadSelected?: string;
    // True where the pick is for one-shot helper jobs (a commit message, a title), the one place a helper-only model
    // may be picked. Everywhere else such a row is listed and refused, saying why.
    helperJobs?: boolean;
}>();

const { mobile } = useDevice();

const query = ref(``);
// The rail filter holds a lane key, not a provider: one chip stands for every locally-run card.
const rail = ref<string | undefined>();
const searchInput = ref<{ focus: () => void } | null>(null);

const searching = computed(() => query.value.trim().length > 0);

// A lead row belongs to no provider, so every provider-shaped question about it has to be short-circuited: readiness
// (or search would sink it below every connected model), and the lock badge below. It is a mode, not a credential.
const isLead = (entry: PickerEntry): boolean => (leadRows ?? []).some((lead) => lead.key === entry.key);
// Every question of order, fold and rail asks whether the READER can run a provider (providerRunnable): connected, and
// theirs to spend (Access ▸ People). A provider connected here but not shared with them sits with the ones nothing can
// run yet, so the models they can use lead the list rather than share it with models that would only be refused.
const leadAwareReady = (candidate: AgentProvider): boolean =>
    (leadRows ?? []).some((entry) => entry.provider === candidate) || providerRunnable(candidate);

// Rail lanes: the providers the sections offer (a retired trial drops out of both), folded by the same rule.
const offered = computed(() => offeredProviders(provider, providerRunnable));
const railLanes = computed<readonly PickerLane[]>(() => lanesOf(offered.value));

// The free sign-in's chip is lit only for a reader who has connected nothing; after that it states its price in the
// same quiet chip as every other locked row.
const promoteFree = computed(() => promotesFreeAccess(railLanes.value.flatMap((lane) => lane.providers), providerRunnable));

// Custom-model row appended last to results; targets the railed lane's first provider, else the current one.
const railLane = computed<PickerLane | undefined>(() => railLanes.value.find((lane) => lane.key === rail.value));
const customEntry = computed<PickerEntry | undefined>(() =>
    searching.value ? customEntryFor(pickerEntries.value, query.value, railLane.value?.providers[0] ?? provider) : undefined,
);

// Which groups show their full catalog, by lane key; resets with query and rail on every open.
const expanded = ref<ReadonlySet<string>>(new Set());
const toggleExpanded = (target: string): void => {
    const next = new Set(expanded.value);
    if (!next.delete(target)) {
        next.add(target);
    }
    expanded.value = next;
};

// Nothing here is the reader's to run, though something is connected: the one line that says so leads the list.
const nothingYours = computed(() => nothingShared());

// Lanes the reader cannot run yet wait behind one row once something can (foldUnconnected); search reads them all anyway.
// With nothing of theirs at all, every lane waits there, under the line that says why: a list of rows none of which can be
// picked says less than that line. A lane the rail names is shown whatever it holds, since naming it asked for it.
const othersOpen = ref(false);
const fold = computed(() => {
    const laid = pickerSections(pickerEntries.value, provider, rail.value, providerRunnable);
    return nothingYours.value && rail.value === undefined ? { shown: [], folded: laid } : foldUnconnected(laid, provider, providerRunnable);
});
// After the last lane shown, else after the lead rows (Auto) where every lane is folded, else first.
const foldAfter = computed(() =>
    searching.value || fold.value.folded.length === 0 ? undefined : (fold.value.shown.at(-1)?.key ?? (sections.value[0]?.key === `lead` ? `lead` : undefined)),
);
const foldFirst = computed(() => !searching.value && fold.value.folded.length > 0 && foldAfter.value === undefined);
// Whether everything behind the fold is withheld from the reader, which its row then names (rather than connecting more).
const foldWithheld = computed(() => fold.value.folded.every((section) => section.providers.every(providerWithheld)));

// The visible list: one flat section while searching, else one section per lane, blocks latest then older.
const sections = computed<
    readonly {
        key: string;
        // The group header. Absent while searching, where one flat section spans every provider.
        label: string | undefined;
        // The lane's single provider; absent while searching and for the folded local lane (no single account).
        provider: AgentProvider | undefined;
        // Every provider the section draws, for the facts that survive folding: the catalog's load state.
        providers: readonly AgentProvider[];
        blocks: { key: string; label: string | undefined; rows: { entry: PickerEntry; index: number }[] }[];
        rowCount: number;
        hidden: number;
        expanded: boolean;
        collapsible: boolean;
        // What this provider costs if not connected, or that it is not shared with the reader; undefined while searching,
        // where each row carries its own.
        badge: string | undefined;
        // The reader may not run this provider (Access ▸ People): its chip states that, and no Connect sits beside it.
        withheld: boolean;
        // The trial's remaining allowance; separate from `badge` since it's a count, not a price, with no Connect link.
        trial: string | undefined;
    }[]
>(() => {
    let index = 0;
    const withRows = (entries: readonly PickerEntry[]): { entry: PickerEntry; index: number }[] =>
        entries.map((entry) => ({ entry, index: index++ }));
    // An unlabelled section that is one flat run of rows (search results, the lead rows): no provider, nothing folded.
    const flatSection = (key: string, rows: { entry: PickerEntry; index: number }[]) => ({
        key,
        label: undefined,
        provider: undefined,
        providers: [],
        blocks: [{ key, label: undefined, rows }],
        rowCount: rows.length,
        hidden: 0,
        expanded: false,
        collapsible: false,
        badge: undefined,
        withheld: false,
        trial: undefined,
    });
    if (searching.value) {
        // Lead rows search alongside the catalog rather than being pinned through a query: somebody typing a model
        // name is asking for that model, not for the mode sitting above it.
        // A retired trial is not found by name either; every other row keeps search's whole-catalogue reach.
        const catalog = pickerEntries.value.filter((entry) => !isTrialProvider(entry.provider) || offered.value.includes(entry.provider));
        const matched = filterEntries([...(leadRows ?? []), ...catalog], query.value, rail.value, leadAwareReady, isOlderEntry);
        // Ranked hits first, custom entry last, so Enter takes the real match; search stays flat, no family folding.
        const rows = withRows(customEntry.value === undefined ? matched : [...matched, customEntry.value]);
        return [flatSection(`search`, rows)];
    }
    const leading = rail.value === undefined ? (leadRows ?? []) : [];
    return [
        // Its own section above every lane, unlabelled: a heading over one row would make a mode look like a provider.
        ...(leading.length === 0 ? [] : [flatSection(`lead`, withRows(leading))]),
        ...[...fold.value.shown, ...(othersOpen.value ? fold.value.folded : [])].map((section) => {
            const isExpanded = expanded.value.has(section.key);
            const single = section.providers.length === 1 ? section.providers[0] : undefined;
            // The selected model survives collapse only for the current provider's lane; only that checkmark is real.
            const blocks = pickerBlocks(section.groups, section.providers.includes(provider) ? model : undefined, isExpanded);
            const rowCount = blocks.reduce((count, block) => count + block.entries.length, 0);
            return {
                key: section.key,
                label: section.label,
                provider: single,
                providers: section.providers,
                blocks: blocks.map((block) => ({ key: block.key, label: block.label, rows: withRows(block.entries) })),
                rowCount,
                hidden: section.total - rowCount,
                expanded: isExpanded,
                // Offered only when it would actually change the list, so a short group never grows a dead control.
                collapsible: isExpanded || section.total > rowCount,
                badge: single === undefined ? undefined : (withheldBadge(single) ?? accessBadge(single)),
                withheld: single !== undefined && providerWithheld(single),
                trial: single === undefined ? undefined : trialBadge(single),
            };
        }),
    ];
});
const flat = computed<readonly PickerEntry[]>(() =>
    sections.value.flatMap((section) => section.blocks.flatMap((block) => block.rows.map((row) => row.entry))),
);

const { activeIndex, activeRow, move, setRowEl } = useListNavigation(flat, (entry) => entry.key);

// The selected row: the caller's current pair (the harness, where a caller has one, is a separate axis).
// A selected lead row takes the tick alone: while a mode is on there is no model pick to confirm, and ticking the one
// it would fall back to would claim a decision nobody has made yet.
const isSelected = (entry: PickerEntry): boolean =>
    leadSelected === undefined ? entry.provider === provider && entry.value === model : entry.key === leadSelected;
// A model that can only write one-shot jobs on a list picking for a turn is listed, not vanished, and refused with its
// reason where its description would be (the daemon refuses it too); so is a row the caller refuses in words.
const isHelperOnly = (entry: PickerEntry): boolean => !helperJobs && entry.helperOnly !== undefined;
// A row of a provider the reader may not run (Access ▸ People): listed, dimmed and refused, never offered, since the
// daemon would refuse the turn and nothing the reader can do here changes that. Browsing, the lane's chip says why;
// searching, where the row stands alone, it says so itself, where its description would be.
const isWithheld = (entry: PickerEntry): boolean => !isLead(entry) && providerWithheld(entry.provider);
const refusedWhy = (entry: PickerEntry): string | undefined => {
    const refused = unpickable?.(entry) ?? false;
    if (refused !== true && refused !== false) {
        return refused;
    }
    if (isWithheld(entry)) {
        return searching.value ? t(`common.access.short.notShared`) : undefined;
    }
    const helper = entry.helperOnly === `no-tool-calls` ? t(`chat.modelPicker.helperOnlyNoTools`) : t(`chat.modelPicker.helperOnlyQuickJobs`);
    return isHelperOnly(entry) ? helper : undefined;
};
const isDisabled = (entry: PickerEntry): boolean => (unpickable?.(entry) ?? false) !== false || isHelperOnly(entry) || isWithheld(entry);
// A row whose provider has no credential yet; dimmed and lock-marked, never disabled. A lead row has no provider to
// hold a credential, so asking would lock a mode that is always available and make it read as refused. A withheld row
// is not locked: connecting would not make it the reader's.
const isLocked = (entry: PickerEntry): boolean => !isLead(entry) && !providerReady(entry.provider) && !providerWithheld(entry.provider);

// Nothing in this sandbox can run: every row is locked, so the way to unlock them leads the list (PickerConnectFirst).
// Not when something is connected and none of it is the reader's: connecting is not their way on (PickerNothingShared).
const nothingConnected = computed(() => accessKnown.value && !anyProviderReady() && !nothingYours.value);

// Deep link to Sandbox ▸ Models, opened on this provider's lane with its sign-in already starting. A real link, not a
// button click, so hover shows the destination and Ctrl/Cmd-click opens it in another tab.
const connectTo = (target: AgentProvider) => modelsPath({ provider: target });

// A plain click closes the picker; a modified one opens elsewhere and must leave this list untouched.
const closeOnPlainClick = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        emit(`close`);
    }
};

const pick = (entry: PickerEntry): void => {
    if (isDisabled(entry)) {
        return;
    }
    emit(`pick`, entry);
};

const pickActive = (): void => {
    if (activeRow.value !== undefined) {
        pick(activeRow.value);
    }
};

// Esc clears the query first, then closes on a second press; stopPropagation stops the host Popover's own Esc handler
// from closing early.
const onEsc = (event: KeyboardEvent): void => {
    if (query.value.length > 0) {
        event.stopPropagation();
        query.value = ``;
        return;
    }
    emit(`close`);
};

// Rail clicks re-point the filter without ending keyboard flow: focus returns to the search input (desktop only, so
// mobile's keyboard stays down).
const railTo = (target: string | undefined): void => {
    rail.value = target;
    if (!mobile.value) {
        searchInput.value?.focus();
    }
};

// Ticks while the picker is open (it is mounted only then), so a row stops reading "back at 15:04" the moment it is 15:04.
const now = useNow(true, 30_000);
watch(now, () => { void browsingCatalog.refresh(); }, { immediate: true });

// No account of the reader's can serve this model now, by the answer Usage left and the spawn listing read (aiReach.ts spentModels):
// dimmed and stamped, never hidden nor disabled, as it comes back on its own. Unlike `isLocked`: a provider with no credential.
const spentRows = computed(() => spentModels(pickerEntries.value, now.value));
const isCooling = (entry: PickerEntry): boolean => spentRows.value.has(entry.key);
const coolingBadge = (entry: PickerEntry): string | undefined => {
    const reopensAt = spentRows.value.get(entry.key)?.reopensAt;
    return !isCooling(entry) ? undefined : reopensAt === undefined ? t(`chat.modelPicker.unavailable`) : t(`chat.modelPicker.backAt`, { at: formatReset(reopensAt, now.value) });
};

// A version its family has moved past, said on the row: Opus 5 and Opus 5.5 differ by two characters, and a row picked
// by mistake became the model every new chat opened on.
const olderWords = (entry: PickerEntry): readonly string[] => {
    const newer = newerThanEntry(entry);
    return newer === undefined ? [] : [t(`chat.modelPicker.olderThan`, { newer: newer.label })];
};

const rowAriaLabel = (entry: PickerEntry): string => {
    const cooling = coolingBadge(entry);
    const helperOnly = refusedWhy(entry);
    return [
        entry.label,
        ...(isSelected(entry) ? [t(`chat.modelPicker.currentModel`)] : []),
        ...(isLocked(entry) ? [accessBadge(entry.provider) ?? t(`chat.modelPicker.notConnected`)] : []),
        ...(isWithheld(entry) && !searching.value ? [t(`common.access.short.notShared`)] : []),
        ...olderWords(entry),
        ...(cooling === undefined ? [] : [cooling]),
        ...(helperOnly === undefined ? [] : [helperOnly]),
    ].join(`, `);
};

// A provider whose connected account can no longer be refreshed; badged so a broken credential isn't mistaken for a
// healthy one.
const providerNeedsReauth = (target: AgentProvider): boolean => accessStateFor(target).needsReauth;

// The vendor's note on a provider whose own loop its terms forbid (the owner keeps such routes by choice); only that
// status earns the list header, since a merely unlisted loop is a choice made later, in the footer.
const forbiddenNote = (target: AgentProvider): string | undefined => {
    const terms = termsOf(target, `native`);
    return terms?.status === `against-terms` ? terms.note : undefined;
};

// A folded lane's state is loading/error until every card has answered, error winning; codex/grok have no static floor,
// so an empty catalog would otherwise misread as truly empty.
const stateFor = (providers: readonly AgentProvider[]): CatalogLoadState => {
    const states = providers.map((target) => providerModelsState.value[target]);
    if (states.includes(`error`)) {
        return `error`;
    }
    return states.every((state) => state === `loaded`) ? `loaded` : `loading`;
};

// Retry re-fetches only the cards that failed: a lane's healthy ones already answered.
const retrySection = (providers: readonly AgentProvider[]): void => {
    for (const target of providers.filter((candidate) => providerModelsState.value[candidate] === `error`)) {
        void loadProviderModels(target);
    }
};

onMounted(() => {
    // The catalogs are daemon-owned and cached there: refresh on every open so search spans warm lists.
    void loadAllProviderModels();
    // Access data (locks, reauth, plan) is only as fresh as the daemon's bound; also refresh on every open.
    void refreshConnections();
    // Desktop only: on mobile the software keyboard would instantly cover half the sheet.
    if (!mobile.value) {
        void nextTick(() => searchInput.value?.focus());
    }
});
</script>

<template>
    <!-- Flex column with a shrinkable middle, so the panel fits whatever height its host gives (a desktop popover caps to the room around its trigger). -->
    <div class="flex min-h-0 flex-col" role="combobox" aria-haspopup="listbox" aria-expanded="true" :aria-label="t(`chat.modelPicker.modelPicker`)">
        <!-- Keys bind on the bar, not the field: they bubble from the input, and what they mean (Enter picks, Esc clears then closes) is this panel's business. -->
        <SearchBar
            ref="searchInput"
            v-model="query"
            class="shrink-0"
            :placeholder="t(`chat.modelPicker.searchModels`)"
            aria-controls="model-picker-list"
            :aria-activedescendant="flat.length > 0 ? `model-picker-opt-${activeIndex}` : undefined"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
            @keydown.enter.exact.prevent="pickActive"
            @keydown.enter.meta.prevent="emit(`submit`)"
            @keydown.enter.ctrl.prevent="emit(`submit`)"
            @keydown.esc="onEsc"
        />

        <!-- Fixed height so the rail's filter states never resize the panel; min-h-40, not 0, since the footer's height depends on what's connected. -->
        <div class="flex h-80 min-h-40 flex-col max-md:h-auto max-md:min-h-0">
            <PickerRail :lanes="railLanes" :rail="rail" :provider="provider" @select="railTo" />

            <div
                id="model-picker-list"
                class="min-h-0 min-w-0 flex-1 overflow-y-auto py-1 max-md:overflow-visible"
                role="listbox"
                :aria-label="t(`shared.models`)"
            >
                <PickerConnectFirst v-if="nothingConnected && !searching" @navigate="closeOnPlainClick" />
                <PickerNothingShared v-else-if="nothingYours && !searching" />
                <PickerFoldRow v-if="foldFirst" v-model="othersOpen" :withheld="foldWithheld" />
                <template v-for="section in sections" :key="section.key">
                    <!-- Group header doubles as the access line (cost + way out); absent once connected, since a usable provider needs no annotation. -->
                    <SectionHeader v-if="section.label !== undefined" :label="section.label" density="dense" class="px-3 pb-1 pt-2" role="presentation">
                        <template #info>
                            <template v-if="section.provider !== undefined">
                                <Icon
                                    v-if="providerNeedsReauth(section.provider)"
                                    name="exclamation-triangle"
                                    class="text-2xs text-warning"
                                    v-tooltip.top="t(`chat.words.reconnectNeeded`)"
                                />
                                <!-- A provider whose own loop its vendor forbids, said quietly: the full note sits in the picker footer once picked. -->
                                <Icon
                                    v-if="forbiddenNote(section.provider) !== undefined"
                                    name="exclamation-circle"
                                    class="text-2xs text-subtle"
                                    v-tooltip.top="forbiddenNote(section.provider)"
                                />
                                <span
                                    v-if="section.badge !== undefined"
                                    class="rounded px-1 py-px text-[0.6rem] font-medium"
                                    :class="
                                        promoteFree && accessStateFor(section.provider).access?.kind === `free`
                                            ? `bg-primary-500/15 text-accent`
                                            : `bg-content/5 text-subtle`
                                    "
                                    >{{ section.badge }}</span
                                >
                            </template>
                            <!-- The trial's count; no Connect beside it, since this provider already works. -->
                            <span v-if="section.trial !== undefined" class="rounded bg-primary-500/15 px-1 py-px text-[0.6rem] font-medium text-accent">{{
                                section.trial
                            }}</span>
                        </template>
                        <template v-if="section.provider !== undefined && section.badge !== undefined && !section.withheld" #actions>
                            <RouterLink :to="connectTo(section.provider)" class="text-2xs text-link" @click="closeOnPlainClick">
                                {{ t(`ui.action.connect`) }}
                            </RouterLink>
                        </template>
                    </SectionHeader>
                    <PickerCatalogStatus v-if="!searching && section.label !== undefined" :provider="section.provider" :withheld="section.withheld" :row-count="section.rowCount" :state="stateFor(section.providers)" @retry="retrySection(section.providers)" @navigate="closeOnPlainClick" />
                    <template v-for="block in section.blocks" :key="block.key">
                        <!-- Family header, shown only for older-version blocks; the latest band needs none, since the section header above already names the group. -->
                        <p v-if="block.label !== undefined" class="px-3 pb-0.5 pt-1.5 pl-8 text-2xs text-subtle" role="presentation">
                            {{ block.label }}
                        </p>
                        <button
                            v-for="row in block.rows"
                            :id="`model-picker-opt-${row.index}`"
                            :key="row.entry.key"
                            :ref="(el) => setRowEl(row.entry.key, el)"
                            type="button"
                            role="option"
                            :aria-selected="row.index === activeIndex"
                            :aria-label="rowAriaLabel(row.entry)"
                            class="ui-row-select ui-off flex w-full items-center gap-2 px-3 py-1.5 text-left max-md:min-h-11"
                            :class="{
                                'ui-row-select-on': row.index === activeIndex,
                                'opacity-60': isLocked(row.entry) || isCooling(row.entry) || isHelperOnly(row.entry) || isWithheld(row.entry),
                            }"
                            :disabled="isDisabled(row.entry)"
                            @click="pick(row.entry)"
                            @mouseenter="activeIndex = row.index"
                        >
                            <ProviderLogo
                                :provider="row.entry.provider"
                                class="shrink-0 text-xs"
                                :class="isSelected(row.entry) ? 'text-accent' : 'text-muted'"
                            />
                            <span
                                class="max-w-[55%] shrink-0 truncate text-sm md:text-xs"
                                :class="isSelected(row.entry) ? 'text-link' : 'text-content'"
                            >
                                {{ row.entry.label }}
                            </span>
                            <span
                                v-if="isOlderEntry(row.entry)"
                                class="shrink-0 rounded-sm border border-line px-1 text-2xs leading-4 text-subtle"
                                aria-hidden="true"
                                v-tooltip.top="olderWords(row.entry)[0]"
                                >{{ t(`chat.modelPicker.older`) }}</span
                            >
                            <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ refusedWhy(row.entry) ?? row.entry.description }}</span>
                            <!-- No account can serve this model until then; the instant, not a dot, since the wait is the decision. -->
                            <span v-if="isCooling(row.entry)" class="shrink-0 whitespace-nowrap text-2xs text-warning">
                                {{ coolingBadge(row.entry) }}
                            </span>
                            <Icon
                                v-for="badge in (row.entry.badges ?? []).slice(0, 3)"
                                :key="badge"
                                :name="badgeMeta()[badge].icon"
                                class="shrink-0 text-2xs text-subtle"
                                :aria-label="badgeMeta()[badge].label"
                            />
                            <!-- The per-row lock, redundant with the section chip while browsing; in search the row is all there is to go on. -->
                            <Icon
                                v-if="isLocked(row.entry)"
                                name="lock"
                                class="shrink-0 text-2xs text-subtle"
                                v-tooltip.top="accessBadge(row.entry.provider)"
                            />
                            <Icon v-if="isSelected(row.entry)" name="check" class="shrink-0 text-2xs text-accent" aria-hidden="true" />
                        </button>
                    </template>
                    <!-- Group disclosure: a group opens at one row per family so Claude's catalog doesn't bury others. -->
                    <button
                        v-if="section.label !== undefined && section.collapsible"
                        type="button"
                        class="ui-row-select flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-2xs text-subtle max-md:min-h-11"
                        :aria-expanded="section.expanded"
                        :aria-label="
                            section.expanded
                                ? t(`chat.modelPicker.showFewerModels`, { label: section.label })
                                : t(`chat.modelPicker.showOlderModels`, { hidden: section.hidden, label: section.label })
                        "
                        @click="toggleExpanded(section.key)"
                    >
                        <Icon :name="section.expanded ? `chevron-up` : `chevron-down`" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
                        <span>{{ section.expanded ? t(`ui.action.showFewer`) : t(`chat.modelPicker.showOlder`, { hidden: section.hidden }) }}</span>
                    </button>
                    <PickerFoldRow v-if="section.key === foldAfter" v-model="othersOpen" :withheld="foldWithheld" />
                </template>
                <div v-if="searching && flat.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">
                    <p>{{ t(`chat.modelPicker.noModelsMatch`) }}</p>
                    <button v-if="rail !== undefined" type="button" class="mt-1 text-2xs text-link" @click="railTo(undefined)">
                        {{ t(`chat.modelPicker.searchAllProviders`) }}
                    </button>
                </div>
            </div>
        </div>

        <div class="sr-only" aria-live="polite">{{ t(`chat.modelPicker.models2`, { count: flat.length }) }}</div>

        <!-- Whatever the caller configures beside the model; empty for a caller that only chooses one. -->
        <slot name="footer" />
        <!-- And the press that spends it, for a caller whose answer starts something. See the header. -->
        <slot name="commit" />
    </div>
</template>
