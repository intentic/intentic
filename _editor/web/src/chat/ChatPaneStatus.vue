<script setup lang="ts">
import { formatTokens, Icon, ProgressRing, useDevice } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { creditSummary, formatCredits } from "../composables/membership/creditMeter";
import { useMembership } from "../composables/membership/useMembership";
import { effectiveAccount } from "../composables/chat/providerAccounts";
import { formatReset, formatUtilization, planHeadroom, SPENT_PERCENT, usageStatusFor } from "../composables/chat/usageStatus";
import { usePaneView } from "../composables/chat/useChat";
import { useToolCalls } from "../composables/chat/useToolCalls";
import UsageRing from "../components/UsageRing.vue";

/* THE PANE'S STATUS BAR: the readouts under the composer, and the one part of the footer that stays OUT of the
 * scroller: it is about the pane (how full the context is, how much of the subscription is left, what the send
 * is waiting for), not about the message being written.
 *
 * The left slot is the composer's to fill: a refusal it is holding, or the shortcut worth teaching, so it
 * arrives as words rather than being worked out again here; everything to the right is measured off this pane's
 * own conversation and the signed-in person's allowance. */

const { block, hint } = defineProps<{
    /** Why Send will not go, if it won't: this owns the slot whenever there is one. */
    block?: string;
    /** What the composer would rather say when nothing is refusing. */
    hint: string;
}>();

const { contextUsage, provider, account } = usePaneView();
const { showToolCalls } = useToolCalls();
const { meter: creditMeter } = useMembership();
const { mobile, keyboardInset } = useDevice();

// Per-conversation context-window fill: a ring that warns as the chat approaches auto-compaction.
const contextRing = computed(() => {
    const usage = contextUsage.value;
    if (usage === undefined || usage.contextWindow <= 0) {
        return undefined;
    }
    const pct = Math.min(100, Math.round((usage.tokens / usage.contextWindow) * 100));
    return {
        value: pct,
        label: `${pct}%`,
        warn: pct >= 80,
        tooltip: `Context · ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} (${pct}%)`,
    };
});

// Claude subscription headroom for this conversation's account, pushed from the agent stream at no token cost:
// a small ring once that account's first Claude turn reports its limits, tinted as the binding pool fills. Keyed
// by account so switching accounts shows the right one. The ring tracks the FULLEST pool (the one that will gate
// the next turn); its card lists them all, because which one is binding shifts between turns.
const usageChip = computed(() => {
    // Resolved through effectiveAccount: a conversation that never picked an account runs on the daemon's
    // first, and the usage map is keyed by that real id: looking up `undefined` kept this chip invisible on
    // every single-account setup.
    const headroom = planHeadroom(usageStatusFor(effectiveAccount(provider.value, account.value)));
    // No binding pool ⇒ nothing measured, or everything has reset. Unlike an account ROW, a chat's chip stays
    // out of the way rather than pinning a 0% to the composer for a session that has not asked for anything.
    if (headroom?.binding === undefined) {
        return undefined;
    }
    // Once a pool is effectively spent the question flips from "how much is left" to "when can I go again", so
    // the binding pool's reset joins the VISIBLE label instead of waiting behind a hover: the chat view is
    // where a limit bites.
    const reset = headroom.percent >= SPENT_PERCENT && headroom.binding.resetsAt !== undefined ? ` · ${formatReset(headroom.binding.resetsAt)}` : ``;
    return { headroom, label: `${formatUtilization(headroom.percent, headroom.stale)}${reset}` };
});

/* MEMBERSHIP CREDITS, IN THE ROOM WHERE THEY GET SPENT.
 *
 * The other way a credit leaves is a premium SERVICE run, and it is agreed to here, in chat: the agent quotes a
 * price and waits for a yes. That etiquette is written into the services tool, which means the figure reached the
 * reader only if the model remembered to type it: the interface itself said nothing, and a number the product
 * refuses to vouch for is a number nobody should have to trust. This pill is the app saying it too.
 *
 * IT APPEARS ONCE THE DAY'S ALLOWANCE IS IN PLAY, and not before: the same rule the plan-limit chip beside it
 * follows for the same reason: a composer must not pin an untouched 1,000 to a session that has not asked for
 * anything. Nothing spent, nothing to report. From the first spend on it is the running answer to "how much of
 * today have I used", which is exactly when that question starts being asked.
 *
 * NOT A RING, though it sits between two of them. Those measure a rate limit FILLING UP towards a wall; this is a
 * wallet emptying, and it is scoped to the person rather than to this conversation's provider account. Dressed as
 * a third ring it would read as a third rate limit, so it takes the membership's own star and a plain figure,
 * and cannot be mistaken for its neighbours. */
const creditChip = computed(() => {
    const meter = creditMeter.value;
    if (meter === undefined || !meter.touched) {
        return undefined;
    }
    return { label: formatCredits(meter.remaining), spent: meter.spent, hint: creditSummary(meter) };
});
</script>

<template>
    <!-- It carries the mobile keyboard inset for the whole footer: growing the bottom-most row in the flow
         shortens the scroller, and the composer stuck to its bottom edge rides up with it. Only rendered where
         the composer is, so the inset can never be needed while the row is absent. -->
    <div
        class="mx-auto flex w-full max-w-[51rem] items-center gap-2 px-3 pb-2 text-2xs text-subtle"
        :style="mobile && keyboardInset > 0 ? { paddingBottom: `${keyboardInset + 8}px` } : undefined"
    >
        <!-- The refusal owns this slot whenever there is one: a Send that won't go has to say what it is waiting
             for, and the tooltip alone never reaches a touch device. Every form factor and width, unlike the
             keyboard hint it displaces.
             Keyboard hint is meaningless on a virtual keyboard (Enter is a newline there), and doesn't earn its
             width in a narrow panel. An empty composer is the one moment message recall is available, so the
             slot advertises it instead. -->
        <span v-if="block !== undefined" class="flex min-w-0 items-center gap-1 text-warning">
            <Icon name="exclamation-circle" class="shrink-0 text-2xs" />
            <span class="truncate">{{ block }}</span>
        </span>
        <span v-else-if="!mobile" class="@max-md:hidden">{{ hint }}</span>
        <div class="ml-auto flex items-center gap-3">
            <!-- WHETHER THIS TRANSCRIPT SHOWS ITS TOOL CALLS. It belongs in the chat because that is where the
                 question is asked: you want the calls back at the moment you are staring at a run mark
                 wondering what it did, not two screens away in settings (where it also lives, for the person who
                 wants it decided once). A pane has no header to hang it off, so it joins the readouts under the
                 composer: the strip that already says what this chat is doing.

                 A HAMMER, ALONE, AND STRUCK THROUGH WHEN THE CALLS ARE HIDDEN. The glyph names what is being
                 shown: the work a run did, not an eye's "visible/hidden", and at that it needs no label beside
                 it; the word was the chip's crutch back when the icon was a generic eye. Tilted off upright
                 because a hammer mid-swing is a hammer, where the straight-on one is a capital T at the size
                 this draws at.
                 State is the slash, NOT brightness: the strip is read at a glance and a control that lights up
                 to say "on" is a second bright thing competing with the numbers beside it. So the glyph stays at
                 the strip's own weight in both states and only lifts a tier under the pointer, and the
                 crossed-out reading (the one every mute and hide control in the world already uses) carries
                 the answer. The slash runs across the handle, not along it. -->
            <button
                type="button"
                class="touch-target relative inline-flex cursor-pointer items-center transition-colors hover:text-muted"
                :aria-pressed="showToolCalls"
                :aria-label="showToolCalls ? 'Hide tool calls' : 'Show tool calls'"
                v-tooltip.top="showToolCalls ? 'Hide tool calls' : 'Show tool calls'"
                @click="showToolCalls = !showToolCalls"
            >
                <Icon name="hammer" class="rotate-[35deg] text-xs" />
                <span
                    v-if="!showToolCalls"
                    aria-hidden="true"
                    class="pointer-events-none absolute top-1/2 left-1/2 h-px w-[130%] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current"
                />
            </button>
            <span v-if="contextRing" class="inline-flex items-center gap-1" v-tooltip.top="contextRing.tooltip">
                <ProgressRing :value="contextRing.value" :class="contextRing.warn ? 'text-warning' : 'text-primary-500'" />
                <span class="@max-xs:hidden">{{ contextRing.label }}</span>
            </span>
            <!-- The chip answers "am I about to get rate-limited": hovering it opens the pool-by-pool card
                 beside the composer, and a click goes to the screen that answers "and what has it cost me". -->
            <RouterLink
                v-if="usageChip"
                to="/sandbox/usage"
                class="touch-target inline-flex cursor-pointer items-center transition-colors hover:text-content"
            >
                <UsageRing :headroom="usageChip.headroom"
                    ><span class="@max-xs:hidden">{{ usageChip.label }}</span></UsageRing
                >
            </RouterLink>
            <!-- What is left of today's membership allowance, once any of it has gone. The star is the
                 membership's glyph everywhere else in the app, which is what keeps this from reading as a third
                 rate limit; a click goes to the page that explains what a credit buys. Warning-tinted only when
                 the allowance is gone, and that is a statement, not an alarm: the money went to the people who
                 wrote what was used, which is what the membership is for. -->
            <RouterLink
                v-if="creditChip"
                to="/settings/membership"
                class="touch-target inline-flex cursor-pointer items-center gap-1 transition-colors hover:text-content"
                :class="creditChip.spent ? `text-warning` : ``"
                :aria-label="creditChip.hint"
                v-tooltip.top="creditChip.hint"
            >
                <Icon name="star" class="shrink-0 text-2xs" />
                <span class="tabular-nums @max-xs:hidden">{{ creditChip.label }}</span>
            </RouterLink>
            <!-- Every chip on this line names a page, so every one of them is a link: the address shows on
                 hover, and Ctrl/⌘-click opens it without taking the conversation off screen. -->
            <RouterLink to="/sandbox/agent" class="touch-target inline-flex items-center gap-1 transition-colors hover:text-content">
                <span class="inline-block h-1.5 w-1.5 rounded-full bg-success"></span> Ready · Manage
            </RouterLink>
        </div>
    </div>
</template>
