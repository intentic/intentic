<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { formatReset, formatWait } from "../../../../models/providers/usageStatus";
import type { HoldReason } from "./heldQueue";
import type { QueuedTrialRetry } from "@intentic/sandbox-contract/schemas/queued-trial-retry";
import { memoryTip } from "../../../../models/agent-status/memoryTip";

/* The one line under a message that did not go out: that it did not, why in a few words, and the way on (the slot). A
   scheduled send reads as what it is instead, a message booked for later with the time it goes.
   It runs across what it stands under (the messages over it, or the quick bar's card): the why from the left edge, the
   presses to the right one, so a line that must break leaves both of its parts on an edge. Before 2026-11-25 it hung off
   the right edge and wrapped there, and the question after it was a second row of its own, so no two left edges met. */

const props = defineProps<{
    reason: HoldReason;
    // What the sandbox measured (its first sentence), drawn as a hover card of figures rather than three lines of the
    // transcript.
    detail?: string | undefined;
    // When a scheduled send goes by itself (ms).
    until?: number | undefined;
    // Or the agent whose landed work it waits for: its title, or undefined for one no card names any more, and the
    // press that opens it.
    after?: { readonly title: string | undefined; readonly turn?: boolean; readonly open: () => void } | undefined;
    // A Continue booked for later rather than words: it says the conversation continues then, not that something sends.
    continues?: boolean;
    // A booking the sandbox made itself, sending words the busy free trial turned away again: said as the retry it is,
    // with which try, never as a time the reader chose.
    retry?: QueuedTrialRetry | undefined;
    // Refused because the free trial could not answer it: said as that, since "refused" alone reads as the reader's fault.
    trial?: boolean | undefined;
}>();

const t = useT();

const figures = computed(() => memoryTip(props.detail));

// Ticks only while a scheduled send counts down, so "in about 40 min" stays true.
const now = useNow(() => props.reason === `scheduled` && props.until !== undefined);

// Past this, the clock it goes at reads better than a countdown; under it, the wait alone (pickUpWhen's threshold).
const CLOCK_FROM_MS = 90 * 60 * 1_000;
const sendsWhen = (until: number, at: number): string => {
    const seconds = Math.round(until / 1_000);
    const wait = formatWait(seconds, at);
    if (props.continues === true) {
        return until - at >= CLOCK_FROM_MS ? t(`chat.chatHeld.continuesAtClock`, { clock: formatReset(seconds, at), wait }) : t(`chat.chatHeld.continuesIn`, { wait });
    }
    return until - at >= CLOCK_FROM_MS ? t(`chat.chatHeld.sendsAtClock`, { clock: formatReset(seconds, at), wait }) : t(`chat.chatHeld.sendsIn`, { wait });
};
const shortly = (): string => (props.continues === true ? t(`chat.chatHeld.continuesShortly`) : t(`chat.chatHeld.sendsShortly`));

// The sandbox's own retry of words the busy trial turned away: when, and which try of how many.
const retryWhen = (retry: QueuedTrialRetry, until: number | undefined, at: number): string => {
    const tries = { made: retry.made, max: retry.max };
    return until === undefined || until <= at
        ? t(`chat.chatHeld.retriesShortly`, tries)
        : t(`chat.chatHeld.retriesIn`, { ...tries, wait: formatWait(Math.round(until / 1_000), at) });
};

// One key per reason, spelled out so every word here is one the catalog check can find.
const why = computed(() => {
    switch (props.reason) {
        case `memory`:
            return t(`chat.chatHeld.memoryLow`);
        case `stopped`:
            return t(`chat.chatHeld.stopped`);
        case `scheduled`:
            // Waiting on another agent's land: said with that agent's name, which is a link to it (the template's).
            if (props.after !== undefined) {
                return props.after.title === undefined ? t(`chat.chatHeld.waitsForGone`) : ``;
            }
            if (props.retry !== undefined) {
                return retryWhen(props.retry, props.until, now.value);
            }
            // Past its instant, the sandbox is letting it go on its next pass (every few seconds).
            return props.until === undefined || props.until <= now.value ? shortly() : sendsWhen(props.until, now.value);
        default:
            return props.trial === true ? t(`chat.chatHeld.trialRefused`) : t(`chat.chatHeld.refused`);
    }
});
</script>

<template>
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 self-stretch text-2xs text-subtle">
        <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <!-- Said once when it appears, which is the moment a message the reader just sent did not go out. -->
            <span role="status" class="flex min-w-0 items-center gap-1.5">
                <!-- A scheduled send is the reader's own booking, said as one: a clock, no alarm. -->
                <!-- The sandbox's retry is not the reader's booking: it says the trial was busy, in the warning ink a refusal has. -->
                <span v-if="reason === `scheduled` && retry !== undefined" class="flex shrink-0 items-center gap-1.5 font-medium text-warning">
                    <Icon name="refresh" class="shrink-0 text-2xs" />{{ t(`chat.chatHeld.trialBusy`) }}
                </span>
                <span v-else-if="reason === `scheduled`" class="flex shrink-0 items-center gap-1.5 font-medium text-muted">
                    <Icon name="clock" class="shrink-0 text-2xs" />{{ t(`chat.chatHeld.scheduled`) }}
                </span>
                <!-- Toned only when the sandbox or a provider held it: a stop is the reader's own doing, and needs no flag. -->
                <span v-else class="flex shrink-0 items-center gap-1.5 font-medium" :class="reason === `stopped` ? `text-muted` : `text-warning`">
                    <Icon name="pause" class="shrink-0 text-2xs" />{{ t(`chat.chatHeld.notSent`) }}
                </span>
                <span aria-hidden="true">·</span>
                <!-- The agent it waits for, by name, opening its chat: "sends after <Fix the login> lands", or, for a review
                     booked on its work, "sends after <Fix the login>'s turn ends". -->
                <template v-if="reason === `scheduled` && after?.title !== undefined">
                    <i18n-t v-if="after.turn === true" keypath="chat.chatHeld.sendsAfterTurn" tag="span" class="min-w-0" scope="global">
                        <template #title
                            ><button
                                type="button"
                                class="max-w-48 truncate align-bottom font-medium text-link hover:underline pointer-coarse:-my-2.5 pointer-coarse:py-2.5"
                                @click="after.open()"
                            >
                                {{ after.title }}
                            </button></template
                        >
                    </i18n-t>
                    <i18n-t v-else keypath="chat.chatHeld.sendsAfter" tag="span" class="min-w-0" scope="global">
                        <template #title
                            ><button
                                type="button"
                                class="max-w-48 truncate align-bottom font-medium text-link hover:underline pointer-coarse:-my-2.5 pointer-coarse:py-2.5"
                                @click="after.open()"
                            >
                                {{ after.title }}
                            </button></template
                        >
                    </i18n-t>
                </template>
                <span
                    v-else
                    class="min-w-0 tabular-nums"
                    :class="[figures !== undefined && `cursor-help`, after !== undefined && `text-warning`]"
                    v-tooltip.top="figures"
                    >{{ why }}</span
                >
            </span>
            <!-- What would clear the cause, said as a clause of it ("Low memory · Raise to 21 GiB") rather than among the presses. -->
            <slot name="cause" />
        </span>
        <!-- Kept to the right edge, on the why's line or, once that is full, on a line of their own. -->
        <span v-if="$slots[`default`]" class="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1"><slot /></span>
    </div>
</template>
