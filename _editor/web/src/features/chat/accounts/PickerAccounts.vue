<script setup lang="ts">
import { SearchBar, useDevice, vAction, ui } from "@intentic/ui";
import { computed, nextTick, type Ref, ref, toRef } from "vue";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import UsageRing from "../../../components/UsageRing.vue";
import { ACCOUNT_LIST_LIMIT, matchAccounts, usePickerAccounts } from "./pickerAccounts";
import { providerDisplayLabel } from "./providerCatalog";
import { formatAge } from "../session/usageStatus";
import ProviderLogo from "./ProviderLogo.vue";

// Footer of the model picker: which connected account, and which agentic loop. Used by both the
// composer's and shell's pickers; it picks (selection is prop in, event out), never applies. Past
// ACCOUNT_LIST_LIMIT each list folds to the active row plus a count, so the account list can't swallow the panel.

const emit = defineEmits<{ selectAccount: [string]; selectHarness: [AgentHarness]; navigate: [] }>();
const { provider, harness, model, account, accountsLocked, harnessLocked } = defineProps<{
    provider: AgentProvider;
    harness: AgentHarness;
    // Model the headroom rings measure against; absent means the account's tightest pool.
    model?: string | undefined;
    // The explicitly pinned account, if there is one. Absent ⇒ the provider's first, the daemon's own default.
    account?: string | undefined;
    // The two axes lock independently: the account may switch mid-turn (an allowance refusal is answered
    // by switching), the harness only between turns. Disabled styling always follows these props via
    // `.ui-off`.
    accountsLocked?: boolean;
    harnessLocked?: boolean;
}>();

const {
    accountRows,
    accountCapacity,
    routedRows,
    routedCapacity,
    unplacedRefusal,
    harnessOptions,
    harnessChoosable,
    measuredAt,
    measuring,
    remeasureLabel,
    remeasure,
} = usePickerAccounts(
    toRef(() => provider),
    toRef(() => harness),
    toRef(() => model),
);

const { mobile } = useDevice();

// An unheld pin falls back to the first row; the highlight must always name something.
const activeAccountId = computed(() => {
    const pinned = accountRows.value.find((row) => row.id === account);
    return (pinned ?? accountRows.value[0])?.id;
});

// Two folds, one behaviour, written separately: the choosable list keeps its active row visible while
// folded, the routed list keeps none.

const accountsOpen = ref(false);
const accountsQuery = ref(``);
const accountsLong = computed(() => accountRows.value.length > ACCOUNT_LIST_LIMIT);
const accountsShown = computed(() => {
    if (!accountsLong.value) {
        return accountRows.value;
    }
    return accountsOpen.value
        ? matchAccounts(accountRows.value, accountsQuery.value)
        : accountRows.value.filter((row) => row.id === activeAccountId.value);
});

const routedOpen = ref(false);
const routedQuery = ref(``);
const routedLong = computed(() => routedRows.value.length > ACCOUNT_LIST_LIMIT);
const routedShown = computed(() => {
    if (!routedLong.value) {
        return routedRows.value;
    }
    return routedOpen.value ? matchAccounts(routedRows.value, routedQuery.value) : [];
});

const accountsList = ref<HTMLElement>();
const accountsFilter = ref<{ focus: (select?: boolean) => void } | null>(null);
const routedFilter = ref<{ focus: (select?: boolean) => void } | null>(null);

// Closing takes the query with it: a fold reopened onto someone else's stale filter looks like a list that lost
// its accounts.
const closeFold = (open: Ref<boolean>, query: Ref<string>): void => {
    open.value = false;
    query.value = ``;
};

// Escape backs out of the filter first, not the whole picker: one layer per press. The host binds it
// in the bubble phase so content can claim it first.
const escapeFold = (event: KeyboardEvent, open: Ref<boolean>, query: Ref<string>): void => {
    event.stopPropagation();
    if (query.value !== ``) {
        query.value = ``;
        return;
    }
    closeFold(open, query);
};

// Opening a fold hands over the keyboard: unfolding a long list means searching it, not scrolling.
// Mobile skips the focus, since its keyboard would cover the list.
const openFold = async (open: Ref<boolean>, filter: Ref<{ focus: (select?: boolean) => void } | null>): Promise<void> => {
    open.value = true;
    await nextTick();
    if (!mobile.value) {
        filter.value?.focus();
    }
};

// Scrolls the current account into view on open, since it's both the row being compared against and
// the one worth finding first. `nearest` keeps the panel from moving.
const toggleAccounts = async (): Promise<void> => {
    if (accountsOpen.value) {
        closeFold(accountsOpen, accountsQuery);
        return;
    }
    await openFold(accountsOpen, accountsFilter);
    accountsList.value?.querySelector(`[data-current="true"]`)?.scrollIntoView({ block: `nearest` });
};

const toggleRouted = async (): Promise<void> => {
    if (routedOpen.value) {
        closeFold(routedOpen, routedQuery);
        return;
    }
    await openFold(routedOpen, routedFilter);
};

// Named bindings so the template stays refs-free; the shared helpers need the raw refs, not unwrapped values.
const escapeAccounts = (event: KeyboardEvent): void => escapeFold(event, accountsOpen, accountsQuery);
const escapeRouted = (event: KeyboardEvent): void => escapeFold(event, routedOpen, routedQuery);

// A pick closes the fold behind it, so the chosen row is what's left on screen and the model list
// regains its height.
const pickAccount = (id: string): void => {
    emit(`selectAccount`, id);
    closeFold(accountsOpen, accountsQuery);
};
</script>

<template>
    <!--
        The list above browses across providers; this footer configures what's selected. Labelled with the
        provider's own mark so the two don't read as one screen when they disagree.
    -->
    <div class="flex items-center justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
            <ProviderLogo :provider="provider" class="shrink-0 text-xs" />
            <span class="truncate">{{ providerDisplayLabel(provider) }} session</span>
        </span>
        <span class="flex shrink-0 items-center gap-2">
            <!--
                One control for age and re-measure: the age is the label, and watching it reset to "just now" is
                the confirmation that the press worked.
            -->
            <button
                type="button"
                :class="ui.textAction(`gap-1 text-2xs text-subtle`)"
                :disabled="measuring"
                v-tooltip.top="`Re-measure every account's plan limits now`"
                :aria-label="remeasureLabel"
                @click="remeasure"
            >
                <Icon name="refresh" class="text-[0.6rem]" :spin="measuring" />
                <span v-if="measuredAt !== undefined">{{ formatAge(measuredAt) }}</span>
            </button>
            <!-- A ring is a glance; the Usage tab is where the windows, their reset times, and what has been
                 spent against them actually live. -->
            <RouterLink to="/sandbox/usage#accounts" class="text-2xs text-link hover:underline" @click="emit(`navigate`)">Headroom</RouterLink>
        </span>
    </div>

    <!--
        The refusal belonging to this selection but no single row (`unplacedRefusal`); shown above every
        control it qualifies.
    -->
    <p v-if="unplacedRefusal" class="flex items-start gap-1.5 text-2xs text-warning" v-tooltip.top="unplacedRefusal">
        <Icon name="exclamation-triangle" class="mt-px shrink-0 text-[0.6rem]" aria-hidden="true" />
        <span class="line-clamp-2">{{ unplacedRefusal }}</span>
    </p>

    <!--
        No frame per row: only the tint marks the active one, hover shows the rest are choosable. Same row
        style as the model list above (`.ui-row-select`, square not rounded) so they read as one list.
    -->
    <template v-if="accountRows.length > 1">
        <!--
            Shown only once the list is folded and long; a filter over a short, readable list would be a
            control looking for a reason to exist.
        -->
        <SearchBar
            v-if="accountsLong && accountsOpen"
            ref="accountsFilter"
            v-model="accountsQuery"
            variant="field"
            placeholder="Filter accounts…"
            aria-label="Filter accounts"
            aria-controls="picker-account-list"
            @keydown.esc="escapeAccounts"
        />

        <!--
            Capped and scrolling only while unfolded; a max-height on a short, unfolded list would be a
            scrollbar with nothing to scroll.
        -->
        <div
            id="picker-account-list"
            ref="accountsList"
            class="-mx-3 flex flex-col"
            :class="{ 'scrollbar-thin max-h-44 overflow-y-auto': accountsOpen }"
            role="group"
            aria-label="Account"
        >
            <button
                v-for="a in accountsShown"
                :key="a.id"
                type="button"
                :data-current="activeAccountId === a.id"
                class="ui-row-select ui-off flex min-h-8 min-w-0 items-center gap-2 px-3 py-1.5 text-xs max-md:min-h-11"
                :class="{ 'ui-row-select-on': activeAccountId === a.id }"
                :disabled="accountsLocked"
                @click="pickAccount(a.id)"
            >
                <!--
                    Row grows a line only when there's a refusal or subtitle to show; a refusal takes that second line
                    over the subtitle, since telling a turn-refusing account apart matters more.
                -->
                <span class="flex min-w-0 flex-col items-start leading-tight">
                    <span class="max-w-full truncate text-content">{{ a.label }}</span>
                    <!-- Truncated on the row, full text on hover; leads with the condition that decides the click. -->
                    <span v-if="a.refused" class="flex max-w-full items-center gap-1 text-2xs text-warning" v-tooltip.top="a.refused">
                        <Icon name="exclamation-triangle" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
                        <span class="truncate">{{ a.refused }}</span>
                    </span>
                    <span v-else-if="a.subtitle" class="max-w-full truncate text-2xs text-subtle">{{ a.subtitle }}</span>
                </span>
                <!--
                    Spend against this account's tightest limit; absent means unmeasured or unavailable, distinct from
                    a measured zero.
                -->
                <UsageRing v-if="a.headroom" :headroom="a.headroom" class="ml-auto" />
                <Icon
                    v-if="a.needsReauth"
                    name="exclamation-triangle"
                    class="shrink-0 text-2xs text-warning"
                    :class="{ 'ml-auto': !a.headroom }"
                    v-tooltip.top="a.detail ?? 'This account needs to be reconnected'"
                />
            </button>
            <!-- Says so inside the list, where the rows would be; otherwise it reads as a list that lost its accounts. -->
            <p v-if="accountsOpen && accountsShown.length === 0" class="px-3 py-1.5 text-2xs text-subtle" aria-live="polite">No accounts match.</p>
        </div>

        <!--
            Carries the count and shape of what's hidden (e.g. "28 with room · 6 spent"), so folding costs no
            information worth having.
        -->
        <button
            v-if="accountsLong"
            type="button"
            class="ui-row-select -mx-3 flex items-center gap-1.5 px-3 py-1.5 text-left text-2xs text-subtle max-md:min-h-11"
            :aria-expanded="accountsOpen"
            aria-controls="picker-account-list"
            v-action="toggleAccounts"
        >
            <Icon :name="accountsOpen ? `chevron-up` : `chevron-down`" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
            <span>{{ accountsOpen ? `Show fewer` : `All ${accountRows.length} accounts` }}</span>
            <span class="ml-auto flex min-w-0 items-center gap-2 truncate">
                <span v-for="count in accountCapacity" :key="count.band" :class="count.tone">
                    <span class="tabular-nums">{{ count.count }}</span> {{ count.label }}
                </span>
            </span>
        </button>
    </template>

    <!-- The connections behind a routed provider: shown, not offered. -->
    <template v-if="routedRows.length > 0">
        <!--
            Folded like the choosable list above, with more reason: nobody picks between these, so open rows
            cost height for nothing.
        -->
        <SearchBar
            v-if="routedLong && routedOpen"
            ref="routedFilter"
            v-model="routedQuery"
            variant="field"
            placeholder="Filter accounts…"
            aria-label="Filter subscription accounts"
            aria-controls="picker-routed-list"
            @keydown.esc="escapeRouted"
        />

        <!--
            Unframed since these aren't clickable controls. Rendered even while folded (empty then) so
            `aria-controls` below always names a real element.
        -->
        <div
            id="picker-routed-list"
            class="-mx-3 flex flex-col"
            :class="{ 'scrollbar-thin max-h-44 overflow-y-auto': routedOpen }"
            role="group"
            aria-label="Subscription"
        >
            <div v-for="a in routedShown" :key="a.name" class="flex min-h-8 min-w-0 items-center gap-2 px-3 py-1.5 text-xs">
                <span class="min-w-0 truncate text-content">{{ a.label }}</span>
                <UsageRing v-if="a.headroom" :headroom="a.headroom" class="ml-auto" />
            </div>
            <p v-if="routedOpen && routedShown.length === 0" class="px-3 py-1.5 text-2xs text-subtle" aria-live="polite">No accounts match.</p>
        </div>

        <button
            v-if="routedLong"
            type="button"
            class="ui-row-select -mx-3 flex items-center gap-1.5 px-3 py-1.5 text-left text-2xs text-subtle max-md:min-h-11"
            :aria-expanded="routedOpen"
            aria-controls="picker-routed-list"
            v-action="toggleRouted"
        >
            <Icon :name="routedOpen ? `chevron-up` : `chevron-down`" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
            <span>{{ routedOpen ? `Show fewer` : `All ${routedRows.length} accounts` }}</span>
            <span class="ml-auto flex min-w-0 items-center gap-2 truncate">
                <span v-for="count in routedCapacity" :key="count.band" :class="count.tone">
                    <span class="tabular-nums">{{ count.count }}</span> {{ count.label }}
                </span>
            </span>
        </button>

        <!-- Shown only past one connection; with a single one there's nothing to explain. -->
        <p v-if="routedRows.length > 1" class="text-2xs text-subtle">Turns are spread across these automatically</p>
    </template>

    <!--
        Harness axis (codex/grok): the provider's runtime, or its model through Claude Code; same
        subscription ids run under either.
    -->
    <div v-if="harnessChoosable" class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">Harness</span>
        <div class="flex items-center gap-1">
            <button
                v-for="h in harnessOptions"
                :key="h.value"
                type="button"
                class="composer-ghost ui-off h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                :class="{ 'composer-active': harness === h.value }"
                :disabled="harnessLocked"
                :aria-pressed="harness === h.value"
                @click="emit(`selectHarness`, h.value)"
            >
                {{ h.label }}
            </button>
        </div>
    </div>
</template>
