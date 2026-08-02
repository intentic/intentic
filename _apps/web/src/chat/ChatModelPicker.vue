<script setup lang="ts">
import { ProgressRing, SearchBar, useDevice, useListNavigation } from "@intentic-app/ui";
import { computed, nextTick, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { type AgentHarness, type AgentProvider, type KeyedProvider, limitationsOf, PROVIDERS } from "@intentic/sandbox-contract";
import { accessBadge, accessStateFor, providerReady } from "../composables/chat/access";
import { BADGE_META, relativeTime } from "../composables/chat/catalog";
import type { Conversation } from "../composables/chat/conversation";
import { acpProviders, endpointProviders, providerDisplayLabel, providerModelsState } from "../composables/chat/providerCatalog";
import { customEntryFor, filterEntries, type PickerEntry, pickerBlocks, pickerEntries, pickerSections } from "../composables/chat/modelPicker";
import { translatorAccounts } from "../composables/chat/providerAccounts";
import { liveUsage, usageRing } from "../composables/chat/usageStatus";
import { accountsOf, loadAllProviderModels, loadProviderModels, subscriptionOnly } from "../composables/chat/useChat";
import ProviderLogo from "./ProviderLogo.vue";

/* The unified model picker (search + provider rail + one grouped list + session-control footer) — width-
 * agnostic so the desktop panel hosts it in a Popover and the mobile panel in a BottomSheet. Rows span every
 * provider and are MODELS ONLY: picking one applies provider+model (Conversation.selectModel), keeping the
 * current harness.
 *
 * IT EDITS THE CONVERSATION IT IS GIVEN, not "the active tab". The composer hands it the active one; the
 * suggested-session dialog hands it a DRAFT that has no tab yet (SuggestedSessionBox.vue), so that a session
 * being proposed can be re-pointed at a different model before it is ever started. Binding to the active tab
 * instead would have made the dialog's picker silently edit whatever chat happened to be open behind it.
 *
 * ACCESS IS THE FIRST THING A ROW STATES. Every provider's catalog is non-empty whether or not its credential is
 * connected (the daemon serves a seed floor so a turn always resolves a model), so the list used to offer models
 * that could not run, indistinguishable from ones that could. Connected providers now lead, the rest follow
 * dimmed under a chip naming what they'd cost — "Free · Google sign-in" against "Needs ChatGPT subscription",
 * because which of those it is decides whether the row is worth a click. A locked row stays PICKABLE on purpose:
 * selecting it points the conversation there and the composer's connect gate (ChatAccountPanel) takes over with
 * the handshake, so choosing a model and connecting for it stay one continuous move.
 *
 * The harness (the provider's own / Claude Code) is a separate axis, chosen via the footer chips — codex/grok run
 * the same subscription model ids under either harness. A mid-chat cross-provider pick just re-points the
 * selection — the fresh session starts lazily at the next send. The rail is a FILTER, never a switcher. Both
 * hosts remount the body per open, so the query/rail reset and the catalogs refresh on every open. */

const emit = defineEmits<{ selected: [] }>();
const { conversation } = defineProps<{ conversation: Conversation }>();

/* Destructured ONCE, which is sound only because every host remounts this body per open — AnchoredOverlay
 * teleports behind a `v-if="open"` and BottomSheet does the same, in both ChatPanel and SuggestedSessionBox.
 * These are the refs of the conversation as it was at mount, so a host that swapped the prop in place would go
 * on editing the previous one. Remount, don't rebind. */
const { provider, harness, model, thinking, fast, fastOffered, fastMode, streaming, messages, account, capabilities } = conversation;
// The active provider's connected accounts. Module state rather than the conversation's, because an account
// list belongs to the sandbox — the conversation only picks WHICH of them its next turn runs on.
const accounts = computed(() => accountsOf(provider.value));
const { mobile } = useDevice();
const router = useRouter();

// The harness axis, shown as footer chips for codex/grok (claude is always its own loop). Both chips NAME the
// runtime they select — the native one is labelled for the provider whose loop it actually is ("ChatGPT", "Grok"),
// never "Default", which would say nothing about what runs while sitting opposite a chip that does.
const harnessOptions = computed<readonly { label: string; value: AgentHarness }[]>(() => [
    { label: providerDisplayLabel(provider.value), value: `native` },
    { label: `Claude Code`, value: `claude-code` },
]);
const harnessChoosable = computed(() => provider.value === `codex` || provider.value === `grok`);

const query = ref(``);
const rail = ref<AgentProvider | undefined>();
const searchInput = ref<{ focus: () => void } | null>(null);

const searching = computed(() => query.value.trim().length > 0);

// The custom-model row, appended last to the search results: typing a full model id offers it directly (see
// customEntryFor). It targets the railed provider when one is filtered, else the active provider — the same
// provider an ordinary pick would apply to.
const customEntry = computed<PickerEntry | undefined>(() =>
    searching.value ? customEntryFor(pickerEntries.value, query.value, rail.value ?? provider.value) : undefined,
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
// logo); browsing, one section per provider with the active provider hoisted first, each opening at one row per
// model family. A section renders as BLOCKS — the latest band, then (expanded) each family's older versions
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
            },
        ];
    }
    return pickerSections(pickerEntries.value, provider.value, rail.value, providerReady).map((section) => {
        const isExpanded = expanded.value.has(section.provider);
        // The selected model survives collapse only for the ACTIVE provider — it's the only group whose current
        // model is the one a checkmark would be claiming.
        const blocks = pickerBlocks(section.groups, section.provider === provider.value ? model.value : undefined, isExpanded);
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
        };
    });
});
const flat = computed<readonly PickerEntry[]>(() =>
    sections.value.flatMap((section) => section.blocks.flatMap((block) => block.rows.map((row) => row.entry))),
);

const { activeIndex, activeRow, move, setRowEl } = useListNavigation(flat, (entry) => entry.key);

// The selected row: the active provider's current model (harness is a separate axis — the footer chips).
const isSelected = (entry: PickerEntry): boolean => entry.provider === provider.value && entry.value === model.value;
// Mid-stream, only a same-provider model swap is allowed (a provider switch retires the session).
const isDisabled = (entry: PickerEntry): boolean => streaming.value && entry.provider !== provider.value;
// A row whose provider has no credential yet. Dimmed and lock-marked, never disabled — see the header comment.
const isLocked = (entry: PickerEntry): boolean => !providerReady(entry.provider);

// Straight to the handshake, for the user who opened the picker already knowing they need to connect something.
// The provider rides along as `?connect=<provider>` so the Agent tab opens on that card — the same deep link the
// composer's connect gate uses.
const connect = (target: AgentProvider): void => {
    emit(`selected`);
    void router.push({ path: `/sandbox/agent`, query: { connect: target } });
};

const pick = (entry: PickerEntry): void => {
    if (isDisabled(entry)) {
        return;
    }
    conversation.selectModel(entry);
    emit(`selected`);
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
    emit(`selected`);
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

// The rail tooltip carries what the icon cannot: whether this provider can run at all, and at what price. It is
// the only place the requirement shows while the rail is filtered to a single provider.
const railTooltip = (target: AgentProvider): string =>
    [
        providerDisplayLabel(target),
        ...(target === provider.value ? [`active`] : []),
        ...(accessBadge(target) !== undefined ? [accessBadge(target)!] : []),
        ...(providerNeedsReauth(target) ? [`needs reconnect`] : []),
    ].join(` · `);

// A group with no rows yet gets a state row (loading / error+retry — keyed off section.rowCount in the
// template): the codex/grok catalogs have no static floor, so a pre-load/error would otherwise read as "this
// provider has nothing". Claude's seed floor always renders, so it never qualifies.
const stateFor = (target: AgentProvider) => providerModelsState.value[target];

// The account the turn will use: the explicit pick, else the first (the daemon's default) — so the picker
// always highlights the one in effect, even before the user touches it.
const activeAccountId = computed(() => account.value ?? accounts.value[0]?.id);

/* What the selected provider/harness pair does NOT do, straight off its declared record. The picker is where
 * the choice is made, so it is where the trade-off belongs: picking Grok gives up mid-turn steering and per-tool
 * approvals, and nothing else in the app was ever going to say so — the controls simply stopped working. An
 * empty list (the Claude Code loop, which is the ceiling) renders nothing at all. */
const limitations = computed(() => limitationsOf(capabilities.value));

/* WHY THE FAST TOGGLE DIDN'T DO WHAT IT SAYS — the sentence for each reason the harness can give (its own
 * FastModeDisabledReason vocabulary, forwarded verbatim on the `fast_mode` frame).
 *
 * Every one of these is a state the user can be in with the control switched on and nothing visibly different
 * about the turn except the speed, so each needs to say what happened AND whether they can do anything about
 * it. An unrecognized reason is not swallowed: a newer harness may report something this build hasn't heard
 * of, and the raw word beats silence — it is at least searchable. */
const FAST_MODE_REASONS: Record<string, string> = {
    free: `Fast speed needs a paid plan.`,
    preference: `Fast speed is switched off in this account's Claude settings.`,
    extra_usage_disabled: `Fast speed needs extra usage enabled on this account.`,
    model_not_allowed: `This model doesn't offer fast speed.`,
    not_first_party: `Fast speed isn't available on a routed endpoint.`,
    disabled_by_env: `Fast speed is disabled by this sandbox's environment.`,
    sdk_opt_in_required: `The harness declined the fast-speed request.`,
    network_error: `Couldn't reach Anthropic to confirm fast speed.`,
    pending: `Still confirming fast speed.`,
};

/* The one line under the toggle, and only when the answer DISAGREES with the ask. Three cases, in the order
 * they matter: cooldown (asked, had it, spent the separate fast-mode pool — it comes back by itself), refused
 * (asked, never got it — the reason says whether that is fixable), and served-anyway (didn't ask but got it,
 * which happens when the account's own Claude settings turn fast mode on, and is worth saying because it is
 * being billed). Agreement renders nothing: a notice confirming that a control did what it says is noise. */
const fastSpeedNotice = computed<string | undefined>(() => {
    const state = fastMode.value;
    if (state === undefined) {
        return undefined;
    }
    if (state.state === `cooldown`) {
        return `Fast speed is rate-limited right now — turns run at standard speed until it resets.`;
    }
    if (state.state === `on`) {
        return fast.value ? undefined : `Ran at fast speed — this account has fast mode switched on by default.`;
    }
    if (!fast.value) {
        return undefined;
    }
    return state.reason === undefined
        ? `The last turn ran at standard speed.`
        : (FAST_MODE_REASONS[state.reason] ?? `The last turn ran at standard speed (${state.reason}).`);
});

/* THE SUBSCRIPTIONS THIS CONVERSATION WOULD RUN ON INSTEAD, for the three providers that own no account and for
 * Grok under the Claude Code harness. They are not a picker: CLIProxyAPI holds every auth file and balances
 * turns across them, so there is nothing here to choose and these rows are read-only.
 *
 * They are listed anyway, because the alternative was silence. This footer showed an account list for Claude
 * and nothing whatsoever for ChatGPT, Kimi or Google — which reads as "this provider has no connections", one
 * step from "why is my ChatGPT not signed in", rather than as "they are held somewhere else and there is
 * nothing to pick". Same rings, same meaning, one line saying who chooses. */
const routedProvider = computed<KeyedProvider | undefined>(() => {
    const target = provider.value;
    if (subscriptionOnly(target)) {
        return target;
    }
    // Grok is the one provider served BOTH ways: its own account runs its own loop, and the subscription runs
    // its models under the Claude Code harness. Which of the two is on screen follows the harness chip below.
    return target === `grok` && harness.value === `claude-code` ? `grok` : undefined;
});

const routedRows = computed(() =>
    routedProvider.value === undefined
        ? []
        : translatorAccounts.value[routedProvider.value].map((entry) => ({
              name: entry.name,
              label: entry.label,
              ring: usageRing(liveUsage(entry.name, entry.usage)),
          })),
);

const footerVisible = computed(
    () =>
        accounts.value.length > 1 ||
        routedRows.value.length > 0 ||
        provider.value === `claude` ||
        harnessChoosable.value ||
        limitations.value.length > 0 ||
        messages.value.length > 0,
);

// Names shared by more than one connected account — the rows a name alone cannot tell apart.
const ambiguousLabels = computed(() => {
    const seen = new Map<string, number>();
    for (const entry of accounts.value) {
        seen.set(entry.label, (seen.get(entry.label) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
});

/* The account rows, each decorated with the two things a switch decision actually turns on.
 *
 * WHICH ONE THIS IS — the identity the provider reported (Claude returns the email + organization with the
 * token), under the name, because the name is the user's to change and two of them can read the same. Failing
 * that, and only when two rows DO read the same, the date it was connected: a weak difference, but picking
 * between two lines that both say "Claude" is not a choice, it's a coin flip. Quiet otherwise — a single
 * self-explaining account earns no second line.
 *
 * HOW MUCH IS LEFT — how much of its TIGHTEST limit pool is spent, which is the whole point of the account list
 * being a list and used to cost a turn to find out. Drawn as the same ring the connection list and the composer
 * chip use for this number, rather than as the bare percentage it was: three percentages down a column are read
 * one at a time and compared by arithmetic, where three arcs are compared at a glance — which is the only
 * question being asked here (which of these has the most room?). The exact figure, its per-pool breakdown and
 * how old the reading is stay one hover away, and a row with no ring at all means no reading, never "empty". */
const accountRows = computed(() =>
    accounts.value.map((entry) => {
        const identity = [entry.email, entry.organization].filter((part) => part !== undefined && part !== entry.label);
        return Object.assign({}, entry, {
            subtitle:
                identity.length > 0
                    ? identity.join(` · `)
                    : ambiguousLabels.value.has(entry.label)
                      ? `connected ${relativeTime(entry.connectedAt)}`
                      : undefined,
            // liveUsage, not the streamed map alone: the daemon's reading rides the row itself and is the newer
            // of the two whenever no turn has ended in this tab since — which is most of the time.
            ring: usageRing(liveUsage(entry.id, entry.usage)),
        });
    }),
);

onMounted(() => {
    // The catalogs are daemon-owned and cached there — refresh on every open so search spans warm lists.
    void loadAllProviderModels();
    // Desktop only: on mobile the software keyboard would instantly cover half the sheet.
    if (!mobile.value) {
        void nextTick(() => searchInput.value?.focus());
    }
});
</script>

<template>
    <!-- A flex column with a shrinkable middle, so the panel fits whatever height its host gives it: the
         desktop popover caps itself to the room above the composer pill (ChatPanel), which on a short window is
         less than the list's preferred height. Search and footer hold their size; the list gives. -->
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
             sparse and dense providers — a variable height makes the bottom-anchored popover grow upward and the
             rail icons jump under the cursor. It lives on the row rather than the list so the rail is bounded by
             the same height, and `min-h-0` lets the row give way when the host is shorter than that. Mobile
             keeps its flexible height inside the sheet. -->
        <div class="flex h-80 min-h-0 max-md:h-auto max-md:flex-col">
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
                    class="qopt flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11"
                    :class="{ 'qopt-on': rail === undefined }"
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
                    class="qopt relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11"
                    :class="{ 'qopt-on': rail === p.value }"
                    v-tooltip.right="railTooltip(p.value)"
                    :aria-label="railTooltip(p.value)"
                    @click="railTo(p.value)"
                >
                    <ProviderLogo
                        :provider="p.value"
                        :class="[rail === p.value ? 'text-primary-500' : 'text-subtle', { 'opacity-50': !providerReady(p.value) }]"
                    />
                    <!-- The session-active provider's dot — independent of the filter selection; both must be
                         legible at once. -->
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
                            <button type="button" class="ml-auto text-2xs normal-case tracking-normal text-link" @click="connect(section.provider)">
                                Connect
                            </button>
                        </template>
                    </div>
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

        <!-- Session controls that have no T3Chat analogue: which connected account serves the next turn, the
             harness axis (codex/grok), Claude's extended-thinking knob, and the mid-chat switch hint. -->
        <div v-if="footerVisible" class="flex shrink-0 flex-col gap-2 border-t border-line p-2">
            <!-- WHOSE SETTINGS THESE ARE. The list above is a BROWSE surface — the rail filters it across every
                 provider without touching the conversation — while everything below configures the conversation
                 you are in. The two disagree whenever the rail is pointed elsewhere, and unlabelled they read as
                 one screen: a column of Claude sign-ins under a list of GPT models looks like ChatGPT's account
                 list. The provider's own mark and name, at the head of the block, is what keeps the footer
                 legible as the session it belongs to. -->
            <div class="flex items-center justify-between gap-2">
                <span class="flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
                    <ProviderLogo :provider="provider" class="shrink-0 text-xs" />
                    <span class="truncate">{{ providerDisplayLabel(provider) }} session</span>
                </span>
                <!-- A ring is a glance; the Usage tab is where the windows, their reset times, and what has been
                     spent against them actually live. -->
                <RouterLink to="/sandbox/usage#accounts" class="shrink-0 text-2xs text-link hover:underline" @click="emit(`selected`)"
                    >Headroom</RouterLink
                >
            </div>
            <template v-if="accounts.length > 1">
                <!-- Labelled as a group: the header above names the PROVIDER, which is what a sighted reader
                     needs beside a screen of another provider's models, and these rows still have to announce
                     what they are. -->
                <div class="flex flex-col gap-1" role="group" aria-label="Account">
                    <button
                        v-for="a in accountRows"
                        :key="a.id"
                        type="button"
                        class="qopt flex min-h-8 min-w-0 items-center gap-2 rounded-lg border px-2 py-1 text-xs max-md:min-h-11"
                        :class="{ 'qopt-on': activeAccountId === a.id }"
                        :disabled="streaming"
                        @click="conversation.selectAccount(a.id)"
                    >
                        <!-- Name over identity, both truncating: the row grows by a line only for accounts that
                             need one, so the common single-account case is the same 8-high row it always was. -->
                        <span class="flex min-w-0 flex-col items-start leading-tight">
                            <span class="max-w-full truncate text-content">{{ a.label }}</span>
                            <span v-if="a.subtitle" class="max-w-full truncate text-2xs text-subtle">{{ a.subtitle }}</span>
                        </span>
                        <!-- How much of this account's tightest limit pool is spent, so the switch decision is
                             informed before it costs a turn. Absent ⇒ no reading at all (never measured, and not
                             obtainable for this plan) — which is a different thing from a measured zero. -->
                        <template v-if="a.ring">
                            <ProgressRing :value="a.ring.percent" :size="14" class="ml-auto" :class="a.ring.tone" v-tooltip.top="a.ring.tooltip" />
                            <!-- The arc is aria-hidden, so the figure it draws is spoken here instead. -->
                            <span class="sr-only">{{ a.ring.percent }}% used</span>
                        </template>
                        <Icon
                            v-if="a.needsReauth"
                            name="exclamation-triangle"
                            class="shrink-0 text-2xs text-warning"
                            :class="{ 'ml-auto': !a.ring }"
                            v-tooltip.top="a.detail ?? 'This account needs to be reconnected'"
                        />
                    </button>
                </div>
            </template>

            <!-- The connections behind a routed provider: shown, not offered. See routedRows. -->
            <template v-if="routedRows.length > 0">
                <div class="flex flex-col gap-1" role="group" aria-label="Subscription">
                    <div
                        v-for="a in routedRows"
                        :key="a.name"
                        class="flex min-h-8 min-w-0 items-center gap-2 rounded-lg border border-line px-2 py-1 text-xs"
                    >
                        <span class="min-w-0 truncate text-content">{{ a.label }}</span>
                        <template v-if="a.ring">
                            <ProgressRing :value="a.ring.percent" :size="14" class="ml-auto" :class="a.ring.tone" v-tooltip.top="a.ring.tooltip" />
                            <span class="sr-only">{{ a.ring.percent }}% used</span>
                        </template>
                    </div>
                </div>
                <p class="text-2xs text-subtle">
                    {{ routedRows.length === 1 ? `Signed in through your subscription` : `Turns are spread across these automatically` }}
                </p>
            </template>

            <!-- Harness axis (codex/grok): the provider's own runtime, or its model through the Claude Code
                 harness. Separate from the model — the same subscription ids run under either. -->
            <div v-if="harnessChoosable" class="flex items-center justify-between gap-2">
                <span class="text-2xs font-medium uppercase tracking-wide text-muted">Harness</span>
                <div class="flex items-center gap-1">
                    <button
                        v-for="h in harnessOptions"
                        :key="h.value"
                        type="button"
                        class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                        :class="{ 'composer-active': harness === h.value }"
                        :disabled="streaming"
                        :aria-pressed="harness === h.value"
                        @click="conversation.selectHarness(h.value)"
                    >
                        {{ h.label }}
                    </button>
                </div>
            </div>

            <!-- Codex reasoning is always on (no toggle); extended thinking is a Claude knob. -->
            <div v-if="provider === `claude`" class="flex items-center justify-between gap-2">
                <span class="text-2xs font-medium uppercase tracking-wide text-muted">Extended thinking</span>
                <button
                    type="button"
                    class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                    :class="{ 'composer-active': thinking }"
                    @click="conversation.setThinking(!thinking)"
                    :aria-pressed="thinking"
                    aria-label="Toggle extended thinking"
                >
                    <Icon name="bolt" class="text-2xs" />
                    <span>{{ thinking ? "On" : "Off" }}</span>
                </button>
            </div>

            <!-- FAST SPEED. Offered only where all three conditions hold (fastAllowed: the Claude Code loop, a
                 first-party route, a model whose catalog row publishes the `fast` badge) — so it appears and
                 disappears with the model rather than sitting greyed out with an explanation nobody reads. The
                 price is stated on the control itself: it is the one composer toggle that changes what a turn
                 costs per token, and a user who flips it should not have to go looking for that. -->
            <div v-if="fastOffered" class="flex flex-col gap-1">
                <div class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Fast speed</span>
                    <button
                        type="button"
                        class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                        :class="{ 'composer-active': fast }"
                        @click="conversation.setFast(!fast)"
                        :aria-pressed="fast"
                        aria-label="Toggle fast speed"
                    >
                        <Icon name="bolt" class="text-2xs" />
                        <span>{{ fast ? "On" : "Off" }}</span>
                    </button>
                </div>
                <span class="text-2xs text-subtle">Same model, up to ~2.5x faster output, at roughly double the per-token price.</span>
                <!-- What the harness actually did with the ask. Only ever shown when it DIFFERS from what was
                     asked for: agreeing with the toggle is what the toggle already says, and a notice under a
                     working control trains people to ignore notices. -->
                <span v-if="fastSpeedNotice !== undefined" class="text-2xs text-subtle">{{ fastSpeedNotice }}</span>
            </div>

            <!-- The honest half of the choice: what this runtime can't do, named before the user relies on it.
                 Chips rather than prose — the list is short, unordered, and each item is a control that would
                 otherwise appear to work. -->
            <div v-if="limitations.length > 0" class="flex flex-col gap-1">
                <span class="text-2xs font-medium uppercase tracking-wide text-muted">Not available here</span>
                <div class="flex flex-wrap gap-1">
                    <span v-for="limit in limitations" :key="limit" class="rounded border border-line px-1.5 py-0.5 text-2xs text-subtle">{{
                        limit
                    }}</span>
                </div>
            </div>

            <!-- A session resumes only on its own runtime, so a mid-chat switch starts a fresh one seeded
                 with the transcript so far (see Conversation.send). -->
            <p v-if="messages.length > 0" class="text-2xs text-subtle">switching starts a fresh session — context carries over</p>
        </div>
    </div>
</template>
