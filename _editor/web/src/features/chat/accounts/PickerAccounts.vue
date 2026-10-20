<script setup lang="ts">
import { SearchBar, useDevice, vAction } from "@intentic/ui";
import { computed, nextTick, type Ref, ref, toRef } from "vue";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import UsageMeter from "../session/UsageMeter.vue";
import { ACCOUNT_LIST_LIMIT, matchAccounts, pickerOrder, usePickerAccounts } from "./pickerAccounts";
import { servingAccount } from "../../../models/conversations/accounts/servingAccount";
import SandboxOutdatedNotice from "../../../parts/sandbox/SandboxOutdatedNotice.vue";
import { accountsOutdated } from "../../../models/providers/accountsOutdated";
import { useT } from "@intentic/ui/i18n";

// The model picker footer's account rows: which connected account serves the turn. Its status line is PickerStatus and its
// toolbar PickerRunBar, both the host's to compose around it. Used by both the composer's and shell's pickers; it picks
// (selection is prop in, event out), never applies. Past
// ACCOUNT_LIST_LIMIT each list folds to the active row plus a count, so the account list can't swallow the panel.

const t = useT();

const emit = defineEmits<{ selectAccount: [string] }>();
const {
    provider,
    harness,
    model,
    account,
    named = true,
    accountsLocked,
} = defineProps<{
    provider: AgentProvider;
    // The loop the turn runs on: which accounts can serve it (a CLI loop has sign-ins of its own).
    harness: AgentHarness;
    // Model the headroom rings measure against; absent means the account's tightest pool.
    model?: string | undefined;
    // The account the selection holds: a pick, or the conversation's own as the daemon records it. Absent ⇒ auto, the
    // account the runtime places a turn naming none on (servingAccount), which is the row ticked, never the first one.
    account?: string | undefined;
    // Whether the next turn names `account` (turnRequest.ts accountIntent); false leaves it to the daemon's record,
    // which moves a turn off a seat an organisation took. A pick handed in by a caller is always named.
    named?: boolean;
    // The account may switch mid-turn (an allowance refusal is answered by switching), so this locks only while the
    // turn is generating. Disabled styling follows it via `.ui-off`.
    accountsLocked?: boolean;
}>();

const { accountRows, accountCapacity, routedRows, routedCapacity } = usePickerAccounts(
    toRef(() => provider),
    toRef(() => harness),
    toRef(() => model),
);

const { mobile } = useDevice();

// The row ticked is the one the next turn runs on, by the rule the daemon places it with, read off the provider's own
// order. None where it runs on none (an account gone from the list, whose turn is refused), rather than a guess.
const serving = computed(() => servingAccount(provider, accountRows.value, { account, named }));
const activeAccountId = computed(() => serving.value?.id);
const autoPickedId = computed(() => (serving.value?.byAllowance === true ? serving.value.id : undefined));

// Two folds, one behaviour, written separately: the choosable list keeps its active row visible while
// folded, the routed list keeps none.

const accountsOpen = ref(false);
const accountsQuery = ref(``);
const accountsLong = computed(() => accountRows.value.length > ACCOUNT_LIST_LIMIT);
const accountsOrdered = computed(() => pickerOrder(provider, accountRows.value));
const accountsShown = computed(() => {
    if (!accountsLong.value) {
        return accountsOrdered.value;
    }
    return accountsOpen.value
        ? matchAccounts(accountsOrdered.value, accountsQuery.value)
        : accountsOrdered.value.filter((row) => row.id === activeAccountId.value);
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
    <!-- The list above browses across providers; this footer configures what's selected. Nothing here but rows: what the
         footer has to SAY (a refusal, a live turn, how fresh the meters are) is PickerStatus's one line above. -->
    <!-- A sandbox too old to judge its accounts: every row reads unknown, and this says why and how to update. -->
    <SandboxOutdatedNotice v-if="accountsOutdated" :missing="t(`chat.pickerAccounts.outdatedMissing`)" />

    <!-- No frame per row: only the tint marks the active one, hover shows the rest are choosable. -->
    <template v-if="accountRows.length > 1">
        <!-- Shown only once the list is folded and long; a filter over a short, readable list would be a control looking for a reason to exist. -->
        <SearchBar
            v-if="accountsLong && accountsOpen"
            ref="accountsFilter"
            v-model="accountsQuery"
            variant="field"
            :placeholder="t(`chat.words.filterAccounts`)"
            :aria-label="t(`chat.words.filterAccounts2`)"
            aria-controls="picker-account-list"
            @keydown.esc="escapeAccounts"
        />

        <!-- Capped and scrolling only while unfolded; a max-height on a short, unfolded list would be a scrollbar with nothing to scroll. -->
        <div
            id="picker-account-list"
            ref="accountsList"
            class="-mx-3 flex flex-col"
            :class="{ 'max-h-44 overflow-y-auto': accountsOpen }"
            role="group"
            :aria-label="t(`shared.account`)"
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
                <!-- Row grows a line only when there's a refusal, a spent pool or a subtitle to show; the condition takes that second line over the subtitle. -->
                <span class="flex min-w-0 flex-col items-start leading-tight">
                    <span class="flex max-w-full items-baseline gap-1.5">
                        <!-- A row that can take no turn dims its name and ring, never the line saying why. -->
                        <span class="truncate text-content" :class="{ 'opacity-50': a.demoted }">{{ a.label }}</span>
                        <!-- The tick nobody chose says who chose it: the runtime, by allowance left. -->
                        <span
                            v-if="autoPickedId === a.id"
                            class="shrink-0 text-2xs text-subtle"
                            v-tooltip.top="{ title: t(`chat.pickerAccounts.autoPicked`), note: t(`chat.pickerAccounts.byAllowanceLeft`) }"
                            >{{ t(`chat.words.autoLabel`) }}</span
                        >
                    </span>
                    <!-- Truncated on the row, full text on hover; leads with the condition that decides the click. -->
                    <span v-if="a.refused" class="flex max-w-full items-start gap-1 text-2xs text-warning" v-tooltip.top="a.refused">
                        <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs" aria-hidden="true" />
                        <span class="truncate">{{ a.refused }}</span>
                    </span>
                    <span v-else-if="a.waiting" class="max-w-full truncate text-2xs text-subtle">{{ a.waiting }}</span>
                    <span v-else-if="a.subtitle" class="max-w-full truncate text-2xs text-subtle" :class="{ 'opacity-50': a.demoted }">{{
                        a.subtitle
                    }}</span>
                </span>
                <!-- Spend against this account's tightest limit; absent means unmeasured or unavailable, distinct from a measured zero. -->
                <UsageMeter v-if="a.headroom" :headroom="a.headroom" class="ml-auto" :class="{ 'opacity-50': a.demoted }" />
                <Icon
                    v-if="a.needsReauth"
                    name="exclamation-triangle"
                    class="shrink-0 text-2xs text-warning"
                    :class="{ 'ml-auto': !a.headroom }"
                    v-tooltip.top="a.detail ?? t(`chat.words.reconnectNeeded`)"
                />
            </button>
            <!-- Says so inside the list, where the rows would be; otherwise it reads as a list that lost its accounts. -->
            <p v-if="accountsOpen && accountsShown.length === 0" class="px-3 py-1.5 text-2xs text-subtle" aria-live="polite">
                {{ t(`chat.pickerAccounts.noAccountsMatch`) }}
            </p>
        </div>

        <!-- The collapsed group preserves the count and shape of hidden accounts. -->
        <button
            v-if="accountsLong"
            type="button"
            class="ui-row-select -mx-3 flex items-center gap-1.5 px-3 py-1.5 text-left text-2xs text-subtle max-md:min-h-11"
            :aria-expanded="accountsOpen"
            aria-controls="picker-account-list"
            v-action="toggleAccounts"
        >
            <Icon :name="accountsOpen ? `chevron-up` : `chevron-down`" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
            <span>{{ accountsOpen ? t(`ui.action.showFewer`) : t(`chat.pickerAccounts.allAccounts`, { count: accountRows.length }) }}</span>
            <span class="ml-auto flex min-w-0 items-center gap-2 truncate">
                <span v-for="count in accountCapacity" :key="count.band" :class="count.tone">
                    <span class="tabular-nums">{{ count.count }}</span> {{ count.label }}
                </span>
            </span>
        </button>
    </template>

    <!-- The connections behind a routed provider: shown, not offered. -->
    <template v-if="routedRows.length > 0">
        <!-- Folded like the choosable list above, with more reason: nobody picks between these, so open rows cost height for nothing. -->
        <SearchBar
            v-if="routedLong && routedOpen"
            ref="routedFilter"
            v-model="routedQuery"
            variant="field"
            :placeholder="t(`chat.words.filterAccounts`)"
            :aria-label="t(`chat.pickerAccounts.filterSubscriptionAccounts`)"
            aria-controls="picker-routed-list"
            @keydown.esc="escapeRouted"
        />

        <!-- Unframed since these aren't clickable controls. -->
        <div
            id="picker-routed-list"
            class="-mx-3 flex flex-col"
            :class="{ 'max-h-44 overflow-y-auto': routedOpen }"
            role="group"
            :aria-label="t(`chat.pickerAccounts.subscription`)"
        >
            <div v-for="a in routedShown" :key="a.name" class="flex min-h-8 min-w-0 items-center gap-2 px-3 py-1.5 text-xs">
                <span class="min-w-0 truncate text-content">{{ a.label }}</span>
                <UsageMeter v-if="a.headroom" :headroom="a.headroom" class="ml-auto" />
            </div>
            <p v-if="routedOpen && routedShown.length === 0" class="px-3 py-1.5 text-2xs text-subtle" aria-live="polite">
                {{ t(`chat.pickerAccounts.noAccountsMatch`) }}
            </p>
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
            <span>{{ routedOpen ? t(`ui.action.showFewer`) : t(`chat.pickerAccounts.allAccounts`, { count: routedRows.length }) }}</span>
            <span class="ml-auto flex min-w-0 items-center gap-2 truncate">
                <span v-for="count in routedCapacity" :key="count.band" :class="count.tone">
                    <span class="tabular-nums">{{ count.count }}</span> {{ count.label }}
                </span>
            </span>
        </button>
    </template>
</template>
