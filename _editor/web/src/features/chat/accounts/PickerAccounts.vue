<script setup lang="ts">
import { SearchBar, useDevice, vAction } from "@intentic/ui";
import { computed, nextTick, type Ref, ref, toRef } from "vue";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { TurnPick } from "../../../models/conversations/run/turnDefaults";
import UsageMeter from "../session/UsageMeter.vue";
import KeyBalanceFigure from "./KeyBalanceFigure.vue";
import { ACCOUNT_LIST_LIMIT, matchAccounts, pickerOrder, sameModelOn, usePickerAccounts } from "./pickerAccounts";
import { runServing } from "../../../models/conversations/accounts/runServing";
import { remainingFigure } from "../../../models/providers/usageStatus";
import SandboxOutdatedNotice from "../../../parts/sandbox/SandboxOutdatedNotice.vue";
import { accountsOutdated } from "../../../models/providers/accountsOutdated";
import { useT } from "@intentic/ui/i18n";

// The model picker footer's account rows: which connected account serves the turn. Its status line is PickerStatus and its
// toolbar PickerRunBar, both the host's to compose around it. Used by both the composer's and shell's pickers; it picks
// (selection is prop in, event out), never applies. Past
// ACCOUNT_LIST_LIMIT each list folds to the active row plus a count, so the account list can't swallow the panel.
//
// A vendor's API key filed under the provider (an Anthropic key under Claude) is a row here too, picked as an account is
// (the owner, 2026-11-05). It is a provider of its own to the daemon, so a pick between it and an account is a provider
// switch onto the same model (`selectCredential`, sameModelOn), and the list above then draws what that credential serves.

const t = useT();

const emit = defineEmits<{
    selectAccount: [string];
    // A credential of another provider than the selection's: a key, or from a key, an account (or the subscriptions).
    selectCredential: [pick: TurnPick, account: string | undefined];
}>();
const {
    provider,
    harness,
    model,
    account,
    named = true,
    accountsLocked,
    providerLocked = false,
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
    // A switch between a key and an account is a provider switch, which waits for a live turn to end.
    providerLocked?: boolean;
}>();

const { family, onKey, accountRows, accountCapacity, keyRows, choosable, routedRows, routedCapacity, modelName } = usePickerAccounts(
    toRef(() => provider),
    toRef(() => harness),
    toRef(() => model),
);

const { mobile } = useDevice();

// The hover on a row whose plan does not include the model: which model, and that its plan is why.
const offPlanTip = computed(() => ({ title: modelName.value ?? ``, note: t(`chat.pickerAccounts.notOnPlanNote`) }));
// The hover on a row the translator is resting: its own words for why.
const restTip = (reason: string | undefined) => (reason === undefined ? undefined : { title: t(`chat.accountFix.wait`), quote: reason });

// The row ticked is the one the next turn runs on: the window's one reading of it (runServing), which the composer's
// Send and the account a chat's first turn names read too, so the tick can never name another account than the turn's.
// None where it runs on none (an account gone from the list, whose turn is refused), rather than a guess.
const serving = computed(() =>
    onKey.value ? undefined : runServing({ provider: family.value, harness, model: model ?? ``, account, named }).account,
);
const activeAccountId = computed(() => serving.value?.id);
const autoPickedId = computed(() => (serving.value?.byAllowance === true ? serving.value.id : undefined));

// Two folds, one behaviour, written separately: the choosable list keeps its active row visible while
// folded, the routed list keeps none.

const accountsOpen = ref(false);
const accountsQuery = ref(``);
const accountsLong = computed(() => accountRows.value.length > ACCOUNT_LIST_LIMIT);
const accountsOrdered = computed(() => pickerOrder(family.value, accountRows.value));
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
// regains its height. From a key, an account is the provider it belongs to as well.
const pickAccount = (id: string): void => {
    if (onKey.value) {
        emit(`selectCredential`, { provider: family.value, value: sameModelOn(family.value, model) }, id);
    } else {
        emit(`selectAccount`, id);
    }
    closeFold(accountsOpen, accountsQuery);
};

// A key, or from a key the provider's own sign-ins (a subscription the translator balances, named by none of its rows).
const pickProvider = (target: AgentProvider): void => {
    if (target !== provider) {
        emit(`selectCredential`, { provider: target, value: sameModelOn(target, model) }, undefined);
    }
};
</script>

<template>
    <!-- The list above browses across providers; this footer configures what's selected. Nothing here but rows: what the
         footer has to SAY (a refusal, a live turn) is PickerStatus's line above, which is also these rows' group header. -->
    <!-- A sandbox too old to judge its accounts: every row reads unknown, and this says why and how to update. -->
    <SandboxOutdatedNotice v-if="accountsOutdated" :missing="t(`chat.pickerAccounts.outdatedMissing`)" />

    <!-- EVERY ROW HERE IS A MODEL ROW'S SHAPE (ModelPicker): one line, the name in the list's type, a quiet description
         beside it, what it has left at the end. The account the next turn runs on wears the app's picked row
         (`ui-row-select-on`: the wash and the skin's leading mark, as the model list's cursor resting on its pick does)
         and its name in the pick's ink. Never a tick at the row's end (2026-11-24): it was the only picked mark of its
         kind among the app's rows, and it pushed that row's meter out of the column the others read down. So the end
         of a row holds its meter and nothing after it; what is wrong with an account is said in its description slot. -->

    <template v-if="choosable">
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
                :aria-current="activeAccountId === a.id ? `true` : undefined"
                class="ui-row-select ui-off flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left max-md:min-h-11"
                :class="{ 'ui-row-select-on': activeAccountId === a.id }"
                :disabled="accountsLocked || (onKey && providerLocked)"
                @click="pickAccount(a.id)"
            >
                <!-- A row that can take no turn dims its name and meter, never the words saying why. -->
                <span
                    data-account-name
                    class="max-w-[60%] shrink-0 truncate text-sm md:text-xs"
                    :class="[activeAccountId === a.id ? `text-link` : `text-content`, { 'opacity-50': a.demoted }]"
                    >{{ a.label }}</span
                >
                <!-- The pick nobody made says who made it: the runtime, by allowance left. -->
                <span
                    v-if="autoPickedId === a.id"
                    class="shrink-0 text-2xs text-subtle"
                    v-tooltip.top="{ title: t(`chat.pickerAccounts.autoPicked`), note: t(`chat.pickerAccounts.byAllowanceLeft`) }"
                    >{{ t(`chat.words.autoLabel`) }}</span
                >
                <!-- THE DESCRIPTION SLOT, as a model row's: why it can take no turn (a refusal, a lost sign-in), else when it
                     can again, else who it is. Truncated on the row, whole on hover. -->
                <span v-if="a.refused" class="flex min-w-0 flex-1 items-center gap-1 text-2xs text-warning" v-tooltip.top="a.refused">
                    <Icon name="exclamation-triangle" class="shrink-0" aria-hidden="true" />
                    <span class="truncate">{{ a.refused }}</span>
                </span>
                <span
                    v-else-if="a.needsReauth"
                    class="flex min-w-0 flex-1 items-center gap-1 text-2xs text-warning"
                    v-tooltip.top="a.detail ?? t(`chat.words.reconnectNeeded`)"
                >
                    <Icon name="exclamation-triangle" class="shrink-0" aria-hidden="true" />
                    <span class="truncate">{{ t(`chat.words.reconnectNeeded`) }}</span>
                </span>
                <span v-else-if="a.waiting" class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ a.waiting }}</span>
                <span v-else class="min-w-0 flex-1 truncate text-2xs text-subtle" :class="{ 'opacity-50': a.demoted }">{{ a.subtitle }}</span>
                <!-- What it has left, as a figure beside its meter: the question a reader picks an account by, answered without a hover.
                     The figure keeps a width of its own, right-aligned, so the bars stand in one column whatever the number. -->
                <UsageMeter v-if="a.headroom" :headroom="a.headroom" class="shrink-0" :class="{ 'opacity-50': a.demoted }">
                    <span class="min-w-9 text-right text-2xs tabular-nums text-subtle">{{ remainingFigure(a.headroom.percent, a.headroom.stale) }}</span>
                </UsageMeter>
                <!-- A plan without the model has no room for it to show: it says so where the meter would be, quietly, since nothing is wrong. -->
                <span v-else-if="a.offPlan" class="shrink-0 text-2xs text-subtle" v-tooltip.top="offPlanTip">{{ t(`chat.accountFix.plan`) }}</span>
            </button>
            <!-- Says so inside the list, where the rows would be; otherwise it reads as a list that lost its accounts. -->
            <p v-if="accountsOpen && accountsShown.length === 0" class="px-3 py-1.5 text-2xs text-subtle" aria-live="polite">
                {{ t(`chat.pickerAccounts.noAccountsMatch`) }}
            </p>
            <!-- The vendor's keys after the accounts, never folded: there is one, rarely two, and who bills it is the point. -->
            <button
                v-for="k in keyRows"
                :key="k.provider"
                type="button"
                :data-current="provider === k.provider"
                :aria-current="provider === k.provider ? `true` : undefined"
                class="ui-row-select ui-off flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left max-md:min-h-11"
                :class="{ 'ui-row-select-on': provider === k.provider }"
                :disabled="provider !== k.provider && providerLocked"
                @click="pickProvider(k.provider)"
            >
                <span data-account-name class="max-w-[60%] shrink-0 truncate text-sm md:text-xs" :class="provider === k.provider ? `text-link` : `text-content`">{{
                    k.label
                }}</span>
                <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ k.subtitle }}</span>
                <KeyBalanceFigure :provider="k.provider" />
            </button>
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

        <!-- Unframed since these aren't clickable controls; on a key they are the way back to the subscription, so they press. -->
        <div
            id="picker-routed-list"
            class="-mx-3 flex flex-col"
            :class="{ 'max-h-44 overflow-y-auto': routedOpen }"
            role="group"
            :aria-label="t(`chat.pickerAccounts.subscription`)"
        >
            <component
                :is="onKey ? `button` : `div`"
                v-for="a in routedShown"
                :key="a.name"
                :type="onKey ? `button` : undefined"
                :disabled="onKey ? providerLocked : undefined"
                class="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left"
                :class="{ 'ui-row-select ui-off max-md:min-h-11': onKey }"
                @click="onKey && pickProvider(family)"
            >
                <!-- The same reading as the choosable rows: dimmed when it takes no turn on this model, and words saying why or until when. -->
                <span data-account-name class="max-w-[60%] shrink-0 truncate text-sm text-content md:text-xs" :class="{ 'opacity-50': a.demoted }">{{
                    a.label
                }}</span>
                <span v-if="a.refused" class="flex min-w-0 flex-1 items-center gap-1 text-2xs text-warning" v-tooltip.top="a.refused">
                    <Icon name="exclamation-triangle" class="shrink-0" aria-hidden="true" />
                    <span class="truncate">{{ a.refused }}</span>
                </span>
                <span v-else-if="a.waiting" class="min-w-0 flex-1 truncate text-2xs text-subtle" v-tooltip.top="restTip(a.rests)">{{ a.waiting }}</span>
                <span v-else class="min-w-0 flex-1" />
                <UsageMeter v-if="a.headroom" :headroom="a.headroom" class="shrink-0" :class="{ 'opacity-50': a.demoted }">
                    <span class="text-2xs tabular-nums text-subtle">{{ remainingFigure(a.headroom.percent, a.headroom.stale) }}</span>
                </UsageMeter>
                <span v-else-if="a.offPlan" class="shrink-0 text-2xs text-subtle" v-tooltip.top="offPlanTip">{{ t(`chat.accountFix.plan`) }}</span>
            </component>
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
