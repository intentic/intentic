<script setup lang="ts">
import { browserOwnsClick, SearchBar, useDevice, useListNavigation } from "@intentic/ui";
import { computed, nextTick, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { type AgentProvider, capabilitiesOf, PROVIDERS, TRIAL_NOTICE } from "@intentic/sandbox-contract";
import { accessBadge, accessStateFor, providerReady, trialBadge } from "../composables/chat/access";
import { BADGE_META } from "../composables/chat/catalog";
import { acpProviders, endpointProviders, providerDisplayLabel, providerModelsState } from "../composables/chat/providerCatalog";
import { customEntryFor, filterEntries, type PickerEntry, pickerBlocks, pickerEntries, pickerSections } from "../composables/chat/modelPicker";
import { loadAllProviderModels, loadProviderModels, refreshConnections } from "../composables/chat/useChat";
import { useSandboxVersion } from "../composables/sandbox/useSandboxVersion";
import ProviderLogo from "./ProviderLogo.vue";

/* THE APP'S ONE MODEL PICKER (search + provider rail + one grouped list) — width-agnostic so a desktop host
 * puts it in a Popover and a mobile host in a BottomSheet, and CALLER-AGNOSTIC so every surface that spends a
 * model gets the same list. Rows span every provider and are MODELS ONLY: a pick is a (provider, model) pair.
 *
 * IT PICKS, IT DOES NOT APPLY. The selection arrives as two props and leaves as one `pick` event, which is what
 * lets the chat composer bind it to a conversation (ChatModelPicker), the suggested-session box bind it to a
 * draft that has no tab yet, and an extension bind it to a run it is about to start (api.models.pick). Anything
 * that configures a SESSION rather than choosing a model goes in the `footer` slot — accounts, the harness axis,
 * extended thinking — because none of that means anything to a caller who has no session.
 *
 * ACCESS IS THE FIRST THING A ROW STATES. Every provider's catalog is non-empty whether or not its credential is
 * connected (the daemon serves a seed floor so a turn always resolves a model), so the list used to offer models
 * that could not run, indistinguishable from ones that could. Connected providers now lead, the rest follow
 * dimmed under a chip naming what they'd cost — "Free · Google sign-in" against "Needs ChatGPT subscription",
 * because which of those it is decides whether the row is worth a click. A locked row stays PICKABLE on purpose:
 * selecting it points the caller there and its own connect gate takes over with the handshake, so choosing a
 * model and connecting for it stay one continuous move.
 *
 * The rail is a FILTER, never a switcher. Hosts remount the body per open, so the query/rail reset and the
 * catalogs refresh on every open. */

const emit = defineEmits<{ pick: [PickerEntry]; close: [] }>();
const { provider, model, unpickable } = defineProps<{
    // The pair the list checkmarks. Both, because a model id is only meaningful under the provider that vends it.
    provider: AgentProvider;
    model: string;
    // Rows this caller cannot switch to right now — the chat's mid-stream rule (a provider switch retires the
    // session), and nothing at all for a caller that is only choosing what a future run opens on.
    unpickable?: (entry: PickerEntry) => boolean;
}>();

const { mobile } = useDevice();

const query = ref(``);
const rail = ref<AgentProvider | undefined>();
const searchInput = ref<{ focus: () => void } | null>(null);

const searching = computed(() => query.value.trim().length > 0);

// The custom-model row, appended last to the search results: typing a full model id offers it directly (see
// customEntryFor). It targets the railed provider when one is filtered, else the current one — the same
// provider an ordinary pick would apply to.
const customEntry = computed<PickerEntry | undefined>(() =>
    searching.value ? customEntryFor(pickerEntries.value, query.value, rail.value ?? provider) : undefined,
);

// Which provider groups are showing their full catalog. Browse-only, and reset with the component like query
// and rail — every open starts at the calm, newest-first view rather than inheriting the last session's sprawl.
const expanded = ref<ReadonlySet<AgentProvider>>(new Set());
const toggleExpanded = (target: AgentProvider): void => {
    const next = new Set(expanded.value);
    if (!next.delete(target)) {
        next.add(target);
    }
    expanded.value = next;
};

// The visible list: while searching a single flat ranked section (provider identity rides on every row's
// logo); browsing, one section per provider with the current provider hoisted first, each opening at one row
// per model family. A section renders as BLOCKS — the latest band, then (expanded) each family's older versions
// under its own header. Rows carry their index in visual order — the keyboard highlight's coordinate system.
const sections = computed<
    readonly {
        provider?: AgentProvider;
        blocks: { key: string; label: string | undefined; rows: { entry: PickerEntry; index: number }[] }[];
        rowCount: number;
        hidden: number;
        expanded: boolean;
        collapsible: boolean;
        // What this provider costs, when it isn't connected yet. Undefined while searching (one flat section
        // spanning every provider) — there, each row carries its own lock instead.
        badge: string | undefined;
        // The free trial's remaining allowance. A separate field from `badge` because it is a different kind of
        // statement — a count, not a price — and because it must NOT drag the "Connect" button along with it.
        trial: string | undefined;
    }[]
>(() => {
    let index = 0;
    const withRows = (entries: readonly PickerEntry[]): { entry: PickerEntry; index: number }[] =>
        entries.map((entry) => ({ entry, index: index++ }));
    if (searching.value) {
        const matched = filterEntries(pickerEntries.value, query.value, rail.value, providerReady);
        // Ranked catalog hits first; the escape hatch sits under them so Enter still takes the real match. A
        // search deliberately spans the WHOLE catalog flat: an older version behind a family's disclosure is
        // exactly what someone reaches for the search box to find, so re-grouping it here would defeat both.
        const rows = withRows(customEntry.value === undefined ? matched : [...matched, customEntry.value]);
        return [
            {
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
        const isExpanded = expanded.value.has(section.provider);
        // The selected model survives collapse only for the CURRENT provider — it's the only group whose current
        // model is the one a checkmark would be claiming.
        const blocks = pickerBlocks(section.groups, section.provider === provider ? model : undefined, isExpanded);
        const rowCount = blocks.reduce((count, block) => count + block.entries.length, 0);
        return {
            provider: section.provider,
            blocks: blocks.map((block) => ({ key: block.key, label: block.label, rows: withRows(block.entries) })),
            rowCount,
            hidden: section.total - rowCount,
            expanded: isExpanded,
            // Offered only when it would actually change the list, so a short group never grows a dead control.
            collapsible: isExpanded || section.total > rowCount,
            badge: accessBadge(section.provider),
            trial: trialBadge(section.provider),
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
// A row whose provider has no credential yet. Dimmed and lock-marked, never disabled — see the header comment.
const isLocked = (entry: PickerEntry): boolean => !providerReady(entry.provider);

/* Straight to the handshake, for the user who opened the picker already knowing they need to connect something.
 * The provider rides along as `?connect=<provider>` so the Agent tab opens on that card — the same deep link the
 * composer's connect gate uses, and now a real address on a real link rather than a router push behind a
 * <button>: hovering it shows where it goes, and Ctrl/⌘-click sets the handshake up in another tab while the
 * picker stays where it is. */
const connectTo = (target: AgentProvider) => ({ path: `/sandbox/agent`, query: { connect: target } });

// Closing the picker is what the PLAIN click does. A modified one opens a tab elsewhere and must leave this
// list exactly as the user left it.
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

// Esc clears the query first (restoring the grouped view), then closes. stopPropagation keeps the host
// Popover's own document-level Esc handler from closing it while there's still a query to clear.
const onEsc = (event: KeyboardEvent): void => {
    if (query.value.length > 0) {
        event.stopPropagation();
        query.value = ``;
        return;
    }
    emit(`close`);
};

// Rail clicks (and the no-results escape) re-point the filter without ending the keyboard flow: focus goes
// straight back to the search input so arrows/Enter/Esc keep working. Mobile keeps its keyboard down.
const railTo = (target: AgentProvider | undefined): void => {
    rail.value = target;
    if (!mobile.value) {
        searchInput.value?.focus();
    }
};

const rowAriaLabel = (entry: PickerEntry): string =>
    `${entry.label}${isSelected(entry) ? ` — current model` : ``}${isLocked(entry) ? ` — ${accessBadge(entry.provider)}` : ``}`;

// The provider rail: the native ones, then every configured model endpoint and every installed ACP agent — the
// same order the sections themselves are built in (pickerSections), so the rail and the list agree.
const railProviders = computed<readonly { label: string; value: AgentProvider }[]>(() => [
    ...PROVIDERS,
    ...endpointProviders.value.map((endpoint) => ({ label: endpoint.label, value: endpoint.id })),
    ...acpProviders.value.map((agent) => ({ label: agent.label, value: agent.id })),
]);

// A provider whose (any) connected account can no longer be refreshed — badge it so a broken credential
// doesn't look identical to a healthy one until the user tries to chat.
const providerNeedsReauth = (target: AgentProvider): boolean => accessStateFor(target).needsReauth;

/* Why this provider's RUNTIME can't serve a turn, as the daemon's own background probe found it (see the
 * sandbox's agent/adapter-health.ts). Distinct from the credential badges above, which are about the account:
 * this answers "is the thing that would run the turn even reachable", and it is the one thing the picker used
 * to be unable to say — the answer arrived as the turn's failure, after a prompt had been written.
 *
 * Silent unless the probe is sure. `unknown` and "not probed yet" both render as nothing at all.
 *
 * Asked against the NATIVE harness, because the harness is a separate axis this picker does not carry — and
 * native is the honest one to name: it is what the row would run on unless the user has already moved the
 * other axis, and a provider forced onto the Claude Code loop is served by a runtime this rail is not about. */
const { runtimeIssue } = useSandboxVersion();
const providerRuntimeIssue = (target: AgentProvider): string | undefined => runtimeIssue(capabilitiesOf(target, `native`).runtime);

// The rail tooltip carries what the icon cannot: whether this provider can run at all, and at what price. It is
// the only place the requirement shows while the rail is filtered to a single provider.
const railTooltip = (target: AgentProvider): string =>
    [
        providerDisplayLabel(target),
        ...(target === provider ? [`active`] : []),
        ...(accessBadge(target) !== undefined ? [accessBadge(target)!] : []),
        ...(providerNeedsReauth(target) ? [`needs reconnect`] : []),
        ...(providerRuntimeIssue(target) !== undefined ? [providerRuntimeIssue(target)!] : []),
    ].join(` · `);

// A group with no rows yet gets a state row (loading / error+retry — keyed off section.rowCount in the
// template): the codex/grok catalogs have no static floor, so a pre-load/error would otherwise read as "this
// provider has nothing". Claude's seed floor always renders, so it never qualifies.
const stateFor = (target: AgentProvider) => providerModelsState.value[target];

onMounted(() => {
    // The catalogs are daemon-owned and cached there — refresh on every open so search spans warm lists.
    void loadAllProviderModels();
    /* AND THE CONNECTIONS, on the same seam and for a sharper reason. Everything this panel says about ACCESS
     * is read from them — which providers are locked, which need reconnecting, and (in the footer a chat host
     * gives it) how much of each account's plan is left — and all of it was as old as the last time the daemon
     * became reachable, which for a browser tab left open is the morning. These pools are account-wide, so an
     * afternoon of spending elsewhere, a revoked credential or a downgraded seat all land here as a confident
     * green ring that nothing on screen has any reason to doubt.
     *
     * Opening the picker IS the moment the numbers get read, so it is the moment to take them: the daemon
     * re-measures behind this call (claude.routes.ts) and answers within its own deadline, and the rings
     * redraw as it lands. Unforced — the daemon's freshness bound is what keeps opening a picker twice in a
     * minute off the provider's quota endpoint; the footer's own control is the way past it. */
    void refreshConnections();
    // Desktop only: on mobile the software keyboard would instantly cover half the sheet.
    if (!mobile.value) {
        void nextTick(() => searchInput.value?.focus());
    }
});
</script>

<template>
    <!-- A flex column with a shrinkable middle, so the panel fits whatever height its host gives it: a desktop
         popover caps itself to the room around its trigger, which on a short window is less than the list's
         preferred height. Search and footer hold their size; the list gives. -->
    <div class="flex min-h-0 flex-col" role="combobox" aria-haspopup="listbox" aria-expanded="true" aria-label="Model picker">
        <!-- The keys are bound on the BAR, not inside it: they bubble up from the input, and what they mean
             (Enter picks a model, Esc clears then closes) is this panel's business, not the field's. -->
        <SearchBar
            ref="searchInput"
            v-model="query"
            class="shrink-0"
            placeholder="Search models…"
            aria-controls="model-picker-list"
            :aria-activedescendant="flat.length > 0 ? `model-picker-opt-${activeIndex}` : undefined"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
            @keydown.enter.prevent="pickActive"
            @keydown.esc="onEsc"
        />

        <!-- Fixed height on desktop so the panel's overall size never changes as the rail filters between
             sparse and dense providers — a variable height makes a bottom-anchored popover grow upward and the
             rail icons jump under the cursor. It lives on the row rather than the list so the rail is bounded by
             the same height. Mobile keeps its flexible height inside the sheet.

             THE FLOOR IS WHY THIS IS `min-h-32` AND NOT `min-h-0`. The row gives way when the host is shorter
             than 320px — that part is unchanged and is what lets the panel fit above its own pill on a short
             window — but it may no longer give way to NOTHING. It could: the footer below is a session panel
             whose height belongs to whatever the provider happens to have connected, and a sandbox holding
             thirty-four sign-ins drew them all, took the whole column, and left the model catalog at zero rows.
             A picker with no models in it is not a degraded picker, it is a different panel, so four rows of
             catalog are reserved before the footer gets any of the height at all. -->
        <div class="flex h-80 min-h-32 max-md:h-auto max-md:flex-col">
            <!-- Provider rail: a filter, never a switcher — scoping the list to one provider must stay a
                 safe exploratory glance, so switching only ever happens by picking a model row. -->
            <div
                role="radiogroup"
                aria-label="Filter by provider"
                class="scrollbar-thin flex w-10 shrink-0 flex-col items-center gap-1 border-r border-line py-1.5 md:overflow-y-auto max-md:w-full max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:border-r-0 max-md:px-1.5"
            >
                <button
                    type="button"
                    role="radio"
                    :aria-checked="rail === undefined"
                    class="ui-row-select flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11"
                    :class="{ 'ui-row-select-on': rail === undefined }"
                    v-tooltip.right="'All providers'"
                    aria-label="All providers"
                    @click="railTo(undefined)"
                >
                    <Icon name="th-large" class="text-sm" :class="rail === undefined ? 'text-primary-500' : 'text-subtle'" />
                </button>
                <div class="mx-auto my-0.5 h-px w-5 shrink-0 bg-line max-md:mx-0.5 max-md:my-auto max-md:h-5 max-md:w-px" aria-hidden="true"></div>
                <button
                    v-for="p in railProviders"
                    :key="p.value"
                    type="button"
                    role="radio"
                    :aria-checked="rail === p.value"
                    class="ui-row-select relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11"
                    :class="{ 'ui-row-select-on': rail === p.value }"
                    v-tooltip.right="railTooltip(p.value)"
                    :aria-label="railTooltip(p.value)"
                    @click="railTo(p.value)"
                >
                    <ProviderLogo
                        :provider="p.value"
                        :class="[rail === p.value ? 'text-primary-500' : 'text-subtle', { 'opacity-50': !providerReady(p.value) }]"
                    />
                    <!-- The current provider's dot — independent of the filter selection; both must be legible
                         at once. -->
                    <span v-if="p.value === provider" class="absolute right-1 top-1 h-1 w-1 rounded-full bg-primary-500" aria-hidden="true"></span>
                    <!-- One corner, two mutually exclusive faults: a provider with a broken account has an
                         account, so it is never the locked one. -->
                    <Icon
                        v-if="providerNeedsReauth(p.value)"
                        name="exclamation-triangle"
                        class="absolute bottom-0.5 right-0.5 text-[0.5rem] text-warning"
                        aria-hidden="true"
                    />
                    <Icon
                        v-else-if="!providerReady(p.value)"
                        name="lock"
                        class="absolute bottom-0.5 right-0.5 text-[0.5rem] text-subtle"
                        aria-hidden="true"
                    />
                </button>
            </div>

            <div id="model-picker-list" class="scrollbar-thin min-w-0 flex-1 overflow-y-auto py-1 max-md:max-h-80" role="listbox" aria-label="Models">
                <template v-for="section in sections" :key="section.provider ?? `search`">
                    <!-- The provider header doubles as the access line: what this group costs, and the way out of
                         it. The chip is absent once connected — a usable provider should read as the plain
                         default, not as a state worth annotating. -->
                    <div
                        v-if="section.provider !== undefined"
                        class="flex items-center gap-1.5 px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-subtle"
                        role="presentation"
                    >
                        <span>{{ providerDisplayLabel(section.provider) }}</span>
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
                        <!-- The trial's count. No Connect beside it on purpose: this provider already works, and
                             offering a handshake for it would be offering to fix something that isn't broken. -->
                        <span
                            v-if="section.trial !== undefined"
                            class="rounded bg-primary-500/15 px-1 py-px text-[0.6rem] font-medium normal-case tracking-normal text-primary-500"
                            >{{ section.trial }}</span
                        >
                    </div>
                    <!-- SAID BEFORE THE FIRST MESSAGE, not after. A trial turn is the one kind this product
                         serves that does not go straight from the sandbox to the model vendor, and a user cannot
                         weigh that once they have already typed into it. -->
                    <p v-if="section.trial !== undefined" class="px-3 pb-1 text-2xs normal-case tracking-normal text-muted">
                        {{ TRIAL_NOTICE }}
                    </p>
                    <template v-for="block in section.blocks" :key="block.key">
                        <!-- A family header, shown only for the older-versions blocks a disclosure reveals: the
                         latest band needs none (the provider header above it already names the group). -->
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
                            class="ui-row-select flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-40 max-md:min-h-11"
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
                            <!-- The per-row lock. Redundant with the section chip while browsing, but search is
                                 one flat list across every provider, where the row is all there is to go on. -->
                            <Icon
                                v-if="isLocked(row.entry)"
                                name="lock"
                                class="shrink-0 text-2xs text-subtle"
                                v-tooltip.top="accessBadge(row.entry.provider)"
                            />
                            <Icon v-if="isSelected(row.entry)" name="check" class="shrink-0 text-2xs text-primary-500" aria-hidden="true" />
                        </button>
                    </template>
                    <!-- Group disclosure: the merged Claude catalog is long enough to bury every other provider's
                         group below the fold, so a group opens at one row per family and expands in place. It sits at
                         the truncation boundary — where the list visibly stops — rather than in the footer, which
                         is session controls, or the rail, which owns the provider axis. Deliberately NOT a
                         role=option: it selects nothing, so it stays out of the arrow-key model list, and the
                         keyboard path to a buried version is the search box, which never truncates. -->
                    <button
                        v-if="section.provider !== undefined && section.collapsible"
                        type="button"
                        class="ui-row-select flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-2xs text-subtle max-md:min-h-11"
                        :aria-expanded="section.expanded"
                        :aria-label="
                            section.expanded
                                ? `Show fewer ${providerDisplayLabel(section.provider)} models`
                                : `Show ${section.hidden} older ${providerDisplayLabel(section.provider)} models`
                        "
                        @click="toggleExpanded(section.provider)"
                    >
                        <Icon :name="section.expanded ? `chevron-up` : `chevron-down`" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
                        <span>{{ section.expanded ? `Show fewer` : `Show ${section.hidden} older` }}</span>
                    </button>
                    <!-- Catalog state row (loading / error+retry) — searching hides it. -->
                    <template v-if="!searching && section.provider !== undefined && section.rowCount === 0">
                        <div v-if="stateFor(section.provider) === `error`" class="flex items-center gap-2 px-3 py-1.5 text-2xs text-danger">
                            <span>Couldn't load models.</span>
                            <button type="button" class="text-link" @click="void loadProviderModels(section.provider)">Retry</button>
                        </div>
                        <div v-else-if="stateFor(section.provider) === `loaded`" class="px-3 py-1.5 text-2xs text-subtle">No models discovered.</div>
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
            </div>
        </div>

        <div class="sr-only" aria-live="polite">{{ flat.length }} models</div>

        <!-- Whatever the caller configures BESIDE the model. Empty for a caller that only chooses one. -->
        <slot name="footer" />
    </div>
</template>
