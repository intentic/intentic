<script setup lang="ts">
import { browserOwnsClick, SearchBar, useDevice, useListNavigation } from "@intentic/ui";
import { computed, nextTick, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { type AgentProvider, capabilitiesOf, PROVIDERS } from "@intentic/sandbox-contract";
import { accessBadge, accessStateFor, providerReady, trialBadge } from "../session/access";
import { BADGE_META } from "./catalog";
import { acpProviders, type CatalogLoadState, endpointProviders, providerModelsState } from "../accounts/providerCatalog";
import {
    customEntryFor,
    filterEntries,
    type PickerEntry,
    type PickerLane,
    lanesOf,
    pickerBlocks,
    pickerEntries,
    pickerSections,
} from "./modelPickerState";
import { loadAllProviderModels, loadProviderModels } from "./useChat-catalog";
import { refreshConnections } from "../accounts/useChat-accounts";
import { useSandboxVersion } from "../../sandbox/overview/useSandboxVersion";
import ProviderLogo from "../accounts/ProviderLogo.vue";

/* THE APP'S ONE MODEL PICKER (search + provider rail + one grouped list): width-agnostic so a desktop host
 * puts it in a Popover and a mobile host in a BottomSheet, and CALLER-AGNOSTIC so every surface that spends a
 * model gets the same list. Rows span every provider and are MODELS ONLY: a pick is a (provider, model) pair.
 *
 * IT PICKS, IT DOES NOT APPLY. The selection arrives as two props and leaves as one `pick` event, which is what
 * lets the chat composer bind it to a conversation (ChatModelPicker), the suggested-session box bind it to a
 * draft that has no tab yet, and an extension bind it to a run it is about to start (api.models.pick). Anything
 * that configures a SESSION rather than choosing a model goes in the `footer` slot: accounts, the harness axis,
 * extended thinking, because none of that means anything to a caller who has no session.
 *
 * AND A `commit` SLOT UNDER THAT, for the one kind of caller whose answer SPENDS MONEY. Everywhere else a model
 * row is the answer and answering closes the panel: the composer writes it to the conversation, the settings row
 * writes it to a pin, and both keep editing after it. A run button cannot work that way — the panel it opens is
 * configuring a run that has not started, so an answer would have to START it, and the panel would be a control
 * where clicking a list row bills you. Those callers leave `pick` staging the selection instead and put their own
 * verb in this slot, which is the whole reason the panel now ends in a press rather than in a dismissal.
 *
 * The slot is drawn by the CALLER, exactly as `footer` is: this panel owns the column, not the chrome inside it.
 * A caller that fills it must be `shrink-0` (it is the one row that may never be squeezed out by a tall footer)
 * and `sticky bottom-0` so it stays in thumb reach in the mobile sheet, which scrolls as one piece.
 *
 * ACCESS IS THE FIRST THING A ROW STATES. Every provider's catalog is non-empty whether or not its credential is
 * connected (the daemon serves a seed floor so a turn always resolves a model), so the list used to offer models
 * that could not run, indistinguishable from ones that could. Connected providers now lead, the rest follow
 * dimmed under a chip naming what they'd cost: "Free · Google sign-in" against "Needs ChatGPT subscription",
 * because which of those it is decides whether the row is worth a click. A locked row stays PICKABLE on purpose:
 * selecting it points the caller there and its own connect gate takes over with the handshake, so choosing a
 * model and connecting for it stay one continuous move.
 *
 * The rail is a FILTER, never a switcher. Hosts remount the body per open, so the query/rail reset and the
 * catalogs refresh on every open. */

/* `submit` is the keyboard's way to the `commit` slot, and it is deliberately NOT plain Enter. Enter picks the
 * highlighted row, everywhere, in every binding of this panel — that is the one keystroke a search-and-choose
 * list may not redefine per caller, and for the callers that commit it is how the list's value gets set at all.
 * ⌘/Ctrl-Enter is this app's send (the composer's own), and it is the right shape for the other half: a
 * deliberate two-finger gesture for the press that starts something. A caller with no commit bar ignores it. */
const emit = defineEmits<{ pick: [PickerEntry]; submit: []; close: [] }>();
const { provider, model, unpickable } = defineProps<{
    // The pair the list checkmarks; both, since a model id is only meaningful under the provider that vends it.
    provider: AgentProvider;
    model: string;
    // Rows this caller can't switch to (mid-stream rule); undefined for a caller only picking a future run's model.
    unpickable?: (entry: PickerEntry) => boolean;
}>();

const { mobile } = useDevice();

const query = ref(``);
// The rail filter holds a lane key, not a provider: one chip stands for every locally-run card.
const rail = ref<string | undefined>();
const searchInput = ref<{ focus: () => void } | null>(null);

const searching = computed(() => query.value.trim().length > 0);

// Rail lanes: native providers, then endpoints and ACP agents, folded by the same rule the sections use.
const railLanes = computed<readonly PickerLane[]>(() =>
    lanesOf([
        ...PROVIDERS.map((option) => option.value),
        ...endpointProviders.value.map((endpoint) => endpoint.id),
        ...acpProviders.value.map((agent) => agent.id),
    ]),
);

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
        // What this provider costs if not connected; undefined while searching, where each row carries its own lock.
        badge: string | undefined;
        // The trial's remaining allowance; separate from `badge` since it's a count, not a price, with no Connect link.
        trial: string | undefined;
    }[]
>(() => {
    let index = 0;
    const withRows = (entries: readonly PickerEntry[]): { entry: PickerEntry; index: number }[] =>
        entries.map((entry) => ({ entry, index: index++ }));
    if (searching.value) {
        const matched = filterEntries(pickerEntries.value, query.value, rail.value, providerReady);
        // Ranked hits first, custom entry last, so Enter takes the real match; search stays flat, no family folding.
        const rows = withRows(customEntry.value === undefined ? matched : [...matched, customEntry.value]);
        return [
            {
                key: `search`,
                label: undefined,
                provider: undefined,
                providers: [],
                blocks: [{ key: `search`, label: undefined, rows }],
                rowCount: rows.length,
                hidden: 0,
                expanded: false,
                collapsible: false,
                badge: undefined,
                trial: undefined,
            },
        ];
    }
    return pickerSections(pickerEntries.value, provider, rail.value, providerReady).map((section) => {
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
            badge: single === undefined ? undefined : accessBadge(single),
            trial: single === undefined ? undefined : trialBadge(single),
        };
    });
});
const flat = computed<readonly PickerEntry[]>(() =>
    sections.value.flatMap((section) => section.blocks.flatMap((block) => block.rows.map((row) => row.entry))),
);

const { activeIndex, activeRow, move, setRowEl } = useListNavigation(flat, (entry) => entry.key);

// The selected row: the caller's current pair (the harness, where a caller has one, is a separate axis).
const isSelected = (entry: PickerEntry): boolean => entry.provider === provider && entry.value === model;
const isDisabled = (entry: PickerEntry): boolean => unpickable?.(entry) === true;
// A row whose provider has no credential yet; dimmed and lock-marked, never disabled.
const isLocked = (entry: PickerEntry): boolean => !providerReady(entry.provider);

// Deep link to the handshake: `?connect=<provider>` opens the Agent tab on that card. A real link, not a button click,
// so hover shows the destination and Ctrl/Cmd-click opens it in another tab.
const connectTo = (target: AgentProvider) => ({ path: `/sandbox/agent`, query: { connect: target } });

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

const rowAriaLabel = (entry: PickerEntry): string =>
    `${entry.label}${isSelected(entry) ? `, current model` : ``}${isLocked(entry) ? `, ${accessBadge(entry.provider)}` : ``}`;

// A provider whose connected account can no longer be refreshed; badged so a broken credential isn't mistaken for a
// healthy one.
const providerNeedsReauth = (target: AgentProvider): boolean => accessStateFor(target).needsReauth;

// Whether this provider's runtime can serve a turn, from the daemon's background probe; distinct from the credential
// badges above. Silent unless sure; asked against the native harness, the axis a row would run on by default.
const { runtimeIssue } = useSandboxVersion();
const providerRuntimeIssue = (target: AgentProvider): string | undefined => runtimeIssue(capabilitiesOf(target, `native`).runtime);

// What a lane stands on: its first provider; every other rail fact is an account fact.
const railLead = (lane: PickerLane): AgentProvider => lane.providers[0]!;
const railReady = (lane: PickerLane): boolean => lane.providers.some(providerReady);
const railActive = (lane: PickerLane): boolean => lane.providers.includes(provider);

// The rail tooltip carries what the icon can't: whether this lane can run, and at what price.
const railTooltip = (lane: PickerLane): string => {
    const lead = railLead(lane);
    return [
        lane.label,
        ...(railActive(lane) ? [`active`] : []),
        ...(accessBadge(lead) !== undefined ? [accessBadge(lead)!] : []),
        ...(providerNeedsReauth(lead) ? [`needs reconnect`] : []),
        ...(providerRuntimeIssue(lead) !== undefined ? [providerRuntimeIssue(lead)!] : []),
    ].join(` · `);
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
    <!--
        Flex column with a shrinkable middle, so the panel fits whatever height its host gives (a desktop popover caps
        to the room around its trigger). Search and footer hold their size; the list gives.
    -->
    <div class="flex min-h-0 flex-col" role="combobox" aria-haspopup="listbox" aria-expanded="true" aria-label="Model picker">
        <!--
            Keys bind on the bar, not the field: they bubble from the input, and what they mean (Enter picks, Esc
            clears then closes) is this panel's business.
        -->
        <SearchBar
            ref="searchInput"
            v-model="query"
            class="shrink-0"
            placeholder="Search models…"
            aria-controls="model-picker-list"
            :aria-activedescendant="flat.length > 0 ? `model-picker-opt-${activeIndex}` : undefined"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
            @keydown.enter.exact.prevent="pickActive"
            @keydown.enter.meta.prevent="emit(`submit`)"
            @keydown.enter.ctrl.prevent="emit(`submit`)"
            @keydown.esc="onEsc"
        />

        <!--
            Fixed height so the rail's filter states never resize the panel; min-h-40, not 0, since the footer's height
            depends on what's connected, and a picker with no models must not fully collapse into it.
        -->
        <div class="flex h-80 min-h-40 flex-col max-md:h-auto max-md:min-h-0">
            <!--
                Provider strip filters, never switches: scoping to one provider is a safe glance; switching only
                happens by picking a model row.
            -->
            <div
                role="radiogroup"
                aria-label="Filter by provider"
                class="scrollbar-thin flex w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-1.5 py-1.5"
            >
                <button
                    type="button"
                    role="radio"
                    :aria-checked="rail === undefined"
                    class="ui-row-select ui-row-select-horizontal flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11"
                    :class="{ 'ui-row-select-on': rail === undefined }"
                    v-tooltip.bottom="'All providers'"
                    aria-label="All providers"
                    @click="railTo(undefined)"
                >
                    <Icon name="th-large" class="text-sm" :class="rail === undefined ? 'text-primary-500' : 'text-subtle'" />
                </button>
                <div class="mx-0.5 my-auto h-5 w-px shrink-0 bg-line" aria-hidden="true"></div>
                <button
                    v-for="lane in railLanes"
                    :key="lane.key"
                    type="button"
                    role="radio"
                    :aria-checked="rail === lane.key"
                    class="ui-row-select ui-row-select-horizontal relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11"
                    :class="{ 'ui-row-select-on': rail === lane.key }"
                    v-tooltip.bottom="railTooltip(lane)"
                    :aria-label="railTooltip(lane)"
                    @click="railTo(lane.key)"
                >
                    <ProviderLogo
                        :provider="railLead(lane)"
                        :class="[rail === lane.key ? 'text-primary-500' : 'text-subtle', { 'opacity-50': !railReady(lane) }]"
                    />
                    <!-- The current provider's dot: independent of the filter selection; both must be legible at once. -->
                    <span v-if="railActive(lane)" class="absolute right-1 top-1 h-1 w-1 rounded-full bg-primary-500" aria-hidden="true"></span>
                    <!--
                        One corner, two mutually exclusive faults: a provider with a broken account has an account, so
                        it is never the locked one.
                    -->
                    <Icon
                        v-if="providerNeedsReauth(railLead(lane))"
                        name="exclamation-triangle"
                        class="absolute bottom-0.5 right-0.5 text-[0.5rem] text-warning"
                        aria-hidden="true"
                    />
                    <Icon
                        v-else-if="!railReady(lane)"
                        name="lock"
                        class="absolute bottom-0.5 right-0.5 text-[0.5rem] text-subtle"
                        aria-hidden="true"
                    />
                </button>
            </div>

            <div
                id="model-picker-list"
                class="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto py-1 max-md:overflow-visible"
                role="listbox"
                aria-label="Models"
            >
                <template v-for="section in sections" :key="section.key">
                    <!--
                        Group header doubles as the access line (cost + way out); absent once connected, since a usable
                        provider needs no annotation. The folded local lane carries only the label, having no account.
                    -->
                    <div
                        v-if="section.label !== undefined"
                        class="flex items-center gap-1.5 px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-subtle"
                        role="presentation"
                    >
                        <span>{{ section.label }}</span>
                        <template v-if="section.provider !== undefined">
                            <Icon
                                v-if="providerNeedsReauth(section.provider)"
                                name="exclamation-triangle"
                                class="text-2xs text-warning"
                                v-tooltip.top="'This account needs to be reconnected'"
                            />
                            <template v-if="section.badge !== undefined">
                                <span
                                    class="rounded px-1 py-px text-[0.6rem] font-medium normal-case tracking-normal"
                                    :class="
                                        accessStateFor(section.provider).access?.kind === `free`
                                            ? `bg-primary-500/15 text-primary-500`
                                            : `bg-content/5 text-subtle`
                                    "
                                    >{{ section.badge }}</span
                                >
                                <RouterLink
                                    :to="connectTo(section.provider)"
                                    class="ml-auto text-2xs normal-case tracking-normal text-link"
                                    @click="closeOnPlainClick"
                                >
                                    Connect
                                </RouterLink>
                            </template>
                        </template>
                        <!-- The trial's count; no Connect beside it, since this provider already works. -->
                        <span
                            v-if="section.trial !== undefined"
                            class="rounded bg-primary-500/15 px-1 py-px text-[0.6rem] font-medium normal-case tracking-normal text-primary-500"
                            >{{ section.trial }}</span
                        >
                    </div>
                    <template v-for="block in section.blocks" :key="block.key">
                        <!--
                            Family header, shown only for older-version blocks; the latest band needs none, since the
                            section header above already names the group.
                        -->
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
                            :class="{ 'ui-row-select-on': row.index === activeIndex, 'opacity-60': isLocked(row.entry) }"
                            :disabled="isDisabled(row.entry)"
                            @click="pick(row.entry)"
                            @mouseenter="activeIndex = row.index"
                        >
                            <ProviderLogo
                                :provider="row.entry.provider"
                                class="shrink-0 text-xs"
                                :class="isSelected(row.entry) ? 'text-primary-500' : 'text-muted'"
                            />
                            <span
                                class="max-w-[55%] shrink-0 truncate text-sm md:text-xs"
                                :class="isSelected(row.entry) ? 'text-link' : 'text-content'"
                            >
                                {{ row.entry.label }}
                            </span>
                            <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ row.entry.description }}</span>
                            <Icon
                                v-for="badge in (row.entry.badges ?? []).slice(0, 3)"
                                :key="badge"
                                :name="BADGE_META[badge].icon"
                                class="shrink-0 text-2xs text-subtle"
                                :aria-label="BADGE_META[badge].label"
                            />
                            <!--
                                The per-row lock, redundant with the section chip while browsing; in search the row is
                                all there is to go on.
                            -->
                            <Icon
                                v-if="isLocked(row.entry)"
                                name="lock"
                                class="shrink-0 text-2xs text-subtle"
                                v-tooltip.top="accessBadge(row.entry.provider)"
                            />
                            <Icon v-if="isSelected(row.entry)" name="check" class="shrink-0 text-2xs text-primary-500" aria-hidden="true" />
                        </button>
                    </template>
                    <!--
                        Group disclosure: a group opens at one row per family so Claude's catalog doesn't bury others.
                        Not role=option; the keyboard path to a buried version is search.
                    -->
                    <button
                        v-if="section.label !== undefined && section.collapsible"
                        type="button"
                        class="ui-row-select flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-2xs text-subtle max-md:min-h-11"
                        :aria-expanded="section.expanded"
                        :aria-label="section.expanded ? `Show fewer ${section.label} models` : `Show ${section.hidden} older ${section.label} models`"
                        @click="toggleExpanded(section.key)"
                    >
                        <Icon :name="section.expanded ? `chevron-up` : `chevron-down`" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
                        <span>{{ section.expanded ? `Show fewer` : `Show ${section.hidden} older` }}</span>
                    </button>
                    <!-- Catalog state row (loading / error+retry): searching hides it. -->
                    <template v-if="!searching && section.label !== undefined && section.rowCount === 0">
                        <div v-if="stateFor(section.providers) === `error`" class="flex items-center gap-2 px-3 py-1.5 text-2xs text-danger">
                            <span>Couldn't load models.</span>
                            <button type="button" class="text-link" @click="retrySection(section.providers)">Retry</button>
                        </div>
                        <div v-else-if="stateFor(section.providers) === `loaded`" class="px-3 py-1.5 text-2xs text-subtle">No models discovered.</div>
                        <div v-else class="flex items-center gap-2 px-3 py-1.5 text-2xs text-subtle">
                            <Icon name="spinner" spin /> Loading models…
                        </div>
                    </template>
                </template>
                <div v-if="searching && flat.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">
                    <p>No models match.</p>
                    <button v-if="rail !== undefined" type="button" class="mt-1 text-2xs text-link" @click="railTo(undefined)">
                        Search all providers
                    </button>
                </div>
                <!--
                    The door to everything this list can only badge: a second account, dropping one, sign-in mechanics.
                    Hidden while searching; a real link, at the foot of the list.
                -->
                <RouterLink
                    v-if="!searching"
                    to="/sandbox/agent"
                    class="ui-row-select flex w-full items-center gap-2 border-t border-line px-3 py-2 text-2xs text-subtle hover:text-content max-md:min-h-11"
                    @click="closeOnPlainClick"
                >
                    <Icon name="key" class="shrink-0 text-2xs" aria-hidden="true" />
                    <span>All AI accounts</span>
                </RouterLink>
            </div>
        </div>

        <div class="sr-only" aria-live="polite">{{ flat.length }} models</div>

        <!-- Whatever the caller configures beside the model; empty for a caller that only chooses one. -->
        <slot name="footer" />
        <!-- And the press that spends it, for a caller whose answer starts something. See the header. -->
        <slot name="commit" />
    </div>
</template>
