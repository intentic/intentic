<script setup lang="ts">
import { SearchBar, useDevice } from "@intentic/ui";
import { computed, nextTick, type Ref, ref, toRef } from "vue";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import UsageRing from "../components/UsageRing.vue";
import { ACCOUNT_LIST_LIMIT, matchAccounts, usePickerAccounts } from "../composables/chat/pickerAccounts";
import { providerDisplayLabel } from "../composables/chat/providerCatalog";
import { formatAge } from "../composables/chat/usageStatus";
import ProviderLogo from "./ProviderLogo.vue";

/* WHO SERVES THE TURN — the model picker's footer block: which connected account, and which agentic loop.
 *
 * It is a component of its own because there are two pickers, not one. The composer's is bound to a conversation
 * and the shell's (HostModelPicker) to a run an extension is about to start; both ask exactly this pair of
 * questions, and the answer needs a usage ring, a stale-credential mark and a standing-refusal line to be worth
 * asking at all. The extension surfaces that hand-rolled their own asked it with a flat row of chips — which
 * cannot say that the account it is about to pin has no headroom left.
 *
 * IT PICKS, IT DOES NOT APPLY, the same contract as the list above it (ModelPicker): the selection arrives as
 * props and leaves as an event, so the composer can write it to a conversation and the host can resolve it to a
 * promise. `account` is the caller's explicit PIN — absent means the first, which is what the daemon resolves to
 * anyway, so the highlight always names what will actually run rather than nothing.
 *
 * IT IS A FOOTER, AND IT HAS TO KEEP BEING ONE. A sandbox pointed at a pool of thirty-four sign-ins drew
 * thirty-four rows here, and since the block sits under a list that is allowed to shrink, the rows took the whole
 * panel: the model catalog — the reason the panel opens — was squeezed to nothing and the picker became an
 * account list with a search box on top. So past ACCOUNT_LIST_LIMIT each list folds to the one row that answers
 * "who serves the turn", plus a line saying how many others there are and what shape they are in; opening the
 * fold gives a filter and a capped, scrolling column rather than an unbounded one. Short lists are untouched —
 * three accounts are three rows, one click each, which is the case that was never broken. */

const emit = defineEmits<{ selectAccount: [string]; selectHarness: [AgentHarness]; navigate: [] }>();
const { provider, harness, account, disabled } = defineProps<{
    provider: AgentProvider;
    harness: AgentHarness;
    // The explicitly pinned account, if there is one. Absent ⇒ the provider's first, the daemon's own default.
    account?: string | undefined;
    // Choices this caller cannot make right now — the chat's mid-stream rule. The rows still render: what they
    // say about headroom is worth reading while a turn is in flight, it just cannot be acted on.
    disabled?: boolean;
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
);

const { mobile } = useDevice();

// A pin the provider no longer holds resolves the way the DAEMON resolves it — to the first account — rather
// than to nothing: the highlight has to name what will actually run, and a folded list showing the pinned row
// has to have a row to show.
const activeAccountId = computed(() => {
    const pinned = accountRows.value.find((row) => row.id === account);
    return (pinned ?? accountRows.value[0])?.id;
});

/* ---- the fold ---------------------------------------------------------------------------------------------
 *
 * Two lists, one behaviour, deliberately written twice rather than abstracted: they fold for the same reason but
 * around different anchors. The choosable list keeps the ACTIVE row visible while folded — it is the answer to
 * the block's own question and hiding it would leave a header over a disclosure — while the routed list keeps
 * nothing, because nothing in it is chosen and the sentence under it already says so. */

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

/* ESC BACKS OUT OF THE FILTER, NOT OUT OF THE PICKER — one layer per press, the same rule the model search above
 * follows (ModelPicker.onEsc). The host binds Escape in the bubble phase precisely so content that wants it first
 * can stop it (AnchoredOverlay), and without this a keystroke aimed at clearing three characters closed the whole
 * panel and threw away the model the reader had come to keep. */
const escapeFold = (event: KeyboardEvent, open: Ref<boolean>, query: Ref<string>): void => {
    event.stopPropagation();
    if (query.value !== ``) {
        query.value = ``;
        return;
    }
    closeFold(open, query);
};

/* OPENING A FOLD IS A SEARCH GESTURE, so it hands over the keyboard: someone unfolding thirty-four addresses is
 * looking for one of them, and the alternative is scrolling a column where every row differs by a digit. Mobile
 * keeps its keyboard down — the software one would cover the list it was raised to filter. */
const openFold = async (open: Ref<boolean>, filter: Ref<{ focus: (select?: boolean) => void } | null>): Promise<void> => {
    open.value = true;
    await nextTick();
    if (!mobile.value) {
        filter.value?.focus();
    }
};

/* The choosable list also puts the CURRENT account under the reader's eye rather than at whatever offset it
 * happens to sit at: the row that serves the turn is both the one being compared against and the one you would
 * otherwise have to go looking for. `nearest` so the panel around it never moves. */
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

// The two Escapes the template binds, named here so it can stay refs-free (a template unwraps them, which is
// exactly what the shared helpers above need NOT to happen).
const escapeAccounts = (event: KeyboardEvent): void => escapeFold(event, accountsOpen, accountsQuery);
const escapeRouted = (event: KeyboardEvent): void => escapeFold(event, routedOpen, routedQuery);

// A pick answers the block's question, so the fold closes behind it: the row that now serves is the one row left
// on screen, and the model list gets its height back without a second click.
const pickAccount = (id: string): void => {
    emit(`selectAccount`, id);
    closeFold(accountsOpen, accountsQuery);
};
</script>

<template>
    <!-- WHOSE SETTINGS THESE ARE. The list above is a BROWSE surface — the rail filters it across every provider
         without touching the selection — while everything here configures what you picked. The two disagree
         whenever the rail is pointed elsewhere, and unlabelled they read as one screen: a column of Claude
         sign-ins under a list of GPT models looks like ChatGPT's account list. The provider's own mark and name,
         at the head of the block, is what keeps the footer legible as the selection it belongs to. -->
    <div class="flex items-center justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
            <ProviderLogo :provider="provider" class="shrink-0 text-xs" />
            <span class="truncate">{{ providerDisplayLabel(provider) }} session</span>
        </span>
        <span class="flex shrink-0 items-center gap-2">
            <!-- HOW OLD THESE READINGS ARE, and the button that makes them new — one control, because a
                 re-measure with nothing to compare against is a button whose effect is invisible, and an age
                 with no way to act on it is a complaint. The age is the label: pressing it and watching "14m
                 ago" become "just now" is the whole confirmation. It staying put is the other answer, and an
                 honest one — this account cannot be read right now, whatever its ring still says. -->
            <button
                type="button"
                class="flex items-center gap-1 text-2xs text-subtle hover:text-content"
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

    <!-- The refusal that belongs to this selection but to no row in it (see unplacedRefusal). Directly under the
         header, above every control it qualifies: it is the reason the numbers below may be beside the point, so
         a reader who stops here has still been told. -->
    <p v-if="unplacedRefusal" class="flex items-start gap-1.5 text-2xs text-warning" v-tooltip.top="unplacedRefusal">
        <Icon name="exclamation-triangle" class="mt-px shrink-0 text-[0.6rem]" aria-hidden="true" />
        <span class="line-clamp-2">{{ unplacedRefusal }}</span>
    </p>

    <!-- Labelled as a group: the header above names the PROVIDER, which is what a sighted reader needs beside a
         screen of another provider's models, and these rows still have to announce what they are.

         NO FRAME PER ROW. Boxing each account drew three hard rectangles into a panel that already has a border,
         a header rule and a model list above it, and the frames carried no meaning — every row had one, chosen or
         not. What actually needs marking is the one row in effect, and the tint does that alone. Hover is what
         says the rest are choosable.

         These ARE the model list's rows, one panel down, so they are drawn by the same utility at the same
         metrics: `.ui-row-select` full-bleed at `px-3 py-1.5`, square rather than rounded. An inset pill under a
         run of full-width rows reads as a different KIND of list — which is the one thing these are not. -->
    <template v-if="accountRows.length > 1">
        <!-- The filter, only once the list has folded. It sits ABOVE the rows and inside the fold, so it appears
             with the thing it filters and leaves with it — a field standing over a five-row list is a control
             asking to be used on something that can be read at a glance. -->
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

        <!-- Capped and scrolling ONLY while unfolded: the cap is what keeps an open list from doing the very
             thing the fold exists to prevent, and a max-height on a three-row list would be a scrollbar with
             nothing to scroll. -->
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
                class="ui-row-select flex min-h-8 min-w-0 items-center gap-2 px-3 py-1.5 text-xs max-md:min-h-11"
                :class="{ 'ui-row-select-on': activeAccountId === a.id }"
                :disabled="disabled"
                @click="pickAccount(a.id)"
            >
                <!-- Name over identity, both truncating: the row grows by a line only for accounts that need one,
                     so the common single-account case is the same 8-high row it always was.

                     THE REFUSAL TAKES THE SECOND LINE when there is one, rather than adding a third. The line it
                     displaces exists to tell two similar accounts apart, and that is a strictly smaller question
                     than "this one turned your last turn away" — which the name above still answers well enough to
                     pick by. Three lines in a popover row would also push the ring out of the reader's line, and
                     the ring is the thing this line exists to argue with. -->
                <span class="flex min-w-0 flex-col items-start leading-tight">
                    <span class="max-w-full truncate text-content">{{ a.label }}</span>
                    <!-- Truncated on the row and whole on hover: the line leads with the condition and its age,
                         which is what decides the click, and tails into the provider's own sentence, which is the
                         part that says what to do about it. -->
                    <span v-if="a.refused" class="flex max-w-full items-center gap-1 text-2xs text-warning" v-tooltip.top="a.refused">
                        <Icon name="exclamation-triangle" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
                        <span class="truncate">{{ a.refused }}</span>
                    </span>
                    <span v-else-if="a.subtitle" class="max-w-full truncate text-2xs text-subtle">{{ a.subtitle }}</span>
                </span>
                <!-- How much of this account's tightest limit pool is spent, so the switch decision is informed
                     before it costs a turn. Absent ⇒ no reading at all (never measured, and not obtainable for
                     this plan) — which is a different thing from a measured zero. -->
                <UsageRing v-if="a.headroom" :headroom="a.headroom" class="ml-auto" />
                <Icon
                    v-if="a.needsReauth"
                    name="exclamation-triangle"
                    class="shrink-0 text-2xs text-warning"
                    :class="{ 'ml-auto': !a.headroom }"
                    v-tooltip.top="a.detail ?? 'This account needs to be reconnected'"
                />
            </button>
            <!-- A filter that matches nothing still has to say so INSIDE the list, where the rows would have
                 been — the alternative reads as a list that lost its accounts. -->
            <p v-if="accountsOpen && accountsShown.length === 0" class="px-3 py-1.5 text-2xs text-subtle" aria-live="polite">No accounts match.</p>
        </div>

        <!-- THE FOLD'S OWN LINE, at the boundary where the list visibly stops — the same place and the same words
             the model list puts its group disclosure (ModelPicker), because they are the same gesture one panel
             apart. It carries the count AND the shape of what is hidden, so folding costs no information worth
             having: thirty-four arcs answer one question between them — how many of these can I run on — and
             "28 with room · 6 spent" answers it in a line that survives being folded. -->
        <button
            v-if="accountsLong"
            type="button"
            class="ui-row-select -mx-3 flex items-center gap-1.5 px-3 py-1.5 text-left text-2xs text-subtle max-md:min-h-11"
            :aria-expanded="accountsOpen"
            aria-controls="picker-account-list"
            @click="void toggleAccounts()"
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

    <!-- The connections behind a routed provider: shown, not offered. See routedRows. -->
    <template v-if="routedRows.length > 0">
        <!-- Folded first and unfolded on demand, like the choosable list above — and with more reason, since
             there is nothing to decide here: a pool of thirty-four addresses nobody picks between is the purest
             case of rows that cost height and return nothing. -->
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

        <!-- Unframed like the account rows above, and for a second reason on top of the weight: these are not
             controls. A box that looks exactly like the one you can click, but doesn't, is worse than no box.

             Rendered even while folded (it is empty then, and draws nothing): the disclosure below points at it
             with `aria-controls`, and a control naming an element that does not exist is worse for a screen
             reader than one naming an empty list. -->
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
            @click="void toggleRouted()"
        >
            <Icon :name="routedOpen ? `chevron-up` : `chevron-down`" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
            <span>{{ routedOpen ? `Show fewer` : `All ${routedRows.length} accounts` }}</span>
            <span class="ml-auto flex min-w-0 items-center gap-2 truncate">
                <span v-for="count in routedCapacity" :key="count.band" :class="count.tone">
                    <span class="tabular-nums">{{ count.count }}</span> {{ count.label }}
                </span>
            </span>
        </button>

        <p class="text-2xs text-subtle">
            {{ routedRows.length === 1 ? `Signed in through your subscription` : `Turns are spread across these automatically` }}
        </p>
    </template>

    <!-- Harness axis (codex/grok): the provider's own runtime, or its model through the Claude Code harness.
         Separate from the model — the same subscription ids run under either. -->
    <div v-if="harnessChoosable" class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">Harness</span>
        <div class="flex items-center gap-1">
            <button
                v-for="h in harnessOptions"
                :key="h.value"
                type="button"
                class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                :class="{ 'composer-active': harness === h.value }"
                :disabled="disabled"
                :aria-pressed="harness === h.value"
                @click="emit(`selectHarness`, h.value)"
            >
                {{ h.label }}
            </button>
        </div>
    </div>
</template>
