<script setup lang="ts">
import { computed, toRef } from "vue";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import UsageRing from "../components/UsageRing.vue";
import { usePickerAccounts } from "../composables/chat/pickerAccounts";
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
 * anyway, so the highlight always names what will actually run rather than nothing. */

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

const { accountRows, routedRows, unplacedRefusal, harnessOptions, harnessChoosable, measuredAt, measuring, remeasureLabel, remeasure } =
    usePickerAccounts(
        toRef(() => provider),
        toRef(() => harness),
    );

const activeAccountId = computed(() => account ?? accountRows.value[0]?.id);
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
    <div v-if="accountRows.length > 1" class="-mx-3 flex flex-col" role="group" aria-label="Account">
        <button
            v-for="a in accountRows"
            :key="a.id"
            type="button"
            class="ui-row-select flex min-h-8 min-w-0 items-center gap-2 px-3 py-1.5 text-xs max-md:min-h-11"
            :class="{ 'ui-row-select-on': activeAccountId === a.id }"
            :disabled="disabled"
            @click="emit(`selectAccount`, a.id)"
        >
            <!-- Name over identity, both truncating: the row grows by a line only for accounts that need one, so
                 the common single-account case is the same 8-high row it always was.

                 THE REFUSAL TAKES THE SECOND LINE when there is one, rather than adding a third. The line it
                 displaces exists to tell two similar accounts apart, and that is a strictly smaller question than
                 "this one turned your last turn away" — which the name above still answers well enough to pick
                 by. Three lines in a popover row would also push the ring out of the reader's line, and the ring
                 is the thing this line exists to argue with. -->
            <span class="flex min-w-0 flex-col items-start leading-tight">
                <span class="max-w-full truncate text-content">{{ a.label }}</span>
                <!-- Truncated on the row and whole on hover: the line leads with the condition and its age, which
                     is what decides the click, and tails into the provider's own sentence, which is the part that
                     says what to do about it. -->
                <span v-if="a.refused" class="flex max-w-full items-center gap-1 text-2xs text-warning" v-tooltip.top="a.refused">
                    <Icon name="exclamation-triangle" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
                    <span class="truncate">{{ a.refused }}</span>
                </span>
                <span v-else-if="a.subtitle" class="max-w-full truncate text-2xs text-subtle">{{ a.subtitle }}</span>
            </span>
            <!-- How much of this account's tightest limit pool is spent, so the switch decision is informed before
                 it costs a turn. Absent ⇒ no reading at all (never measured, and not obtainable for this plan) —
                 which is a different thing from a measured zero. -->
            <UsageRing v-if="a.headroom" :headroom="a.headroom" class="ml-auto" />
            <Icon
                v-if="a.needsReauth"
                name="exclamation-triangle"
                class="shrink-0 text-2xs text-warning"
                :class="{ 'ml-auto': !a.headroom }"
                v-tooltip.top="a.detail ?? 'This account needs to be reconnected'"
            />
        </button>
    </div>

    <!-- The connections behind a routed provider: shown, not offered. See routedRows. -->
    <template v-if="routedRows.length > 0">
        <!-- Unframed like the account rows above, and for a second reason on top of the weight: these are not
             controls. A box that looks exactly like the one you can click, but doesn't, is worse than no box. -->
        <div class="-mx-3 flex flex-col" role="group" aria-label="Subscription">
            <div v-for="a in routedRows" :key="a.name" class="flex min-h-8 min-w-0 items-center gap-2 px-3 py-1.5 text-xs">
                <span class="min-w-0 truncate text-content">{{ a.label }}</span>
                <UsageRing v-if="a.headroom" :headroom="a.headroom" class="ml-auto" />
            </div>
        </div>
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
