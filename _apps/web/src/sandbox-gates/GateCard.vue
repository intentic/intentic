<script setup lang="ts">
import { Icon, type IconName } from "@intentic-app/ui";

/* THE FULL-SCREEN NOTICE — what stands in the workspace outlet when there is no workspace to show: the daemon
 * is unreachable, or still booting, or reachable but refusing this account.
 *
 * All three gates had drawn this themselves, identically: centred card, 48px icon tile, title, muted body,
 * one action. Which is the right shape — a gate is a full screen saying one thing — but three copies of it
 * meant three chances for the fade-in, the tile radius or the max-width to drift apart, on the exact screens a
 * user sees when something is already wrong. A gate should never be the thing that looks broken.
 *
 * `spinner` is the difference between waiting and refusing, and it belongs in the chrome rather than in each
 * gate's title: the connecting and warming screens resolve BY THEMSELVES, and the spinner beside the title is
 * the whole promise that nothing is being asked of the reader. The unauthorized gate has no spinner for the
 * same reason — waiting will not fix an account mismatch, so pretending to wait would be a lie.
 *
 * Three slots, because a gate has three registers. The default one is the sentence, centred with the title.
 * #actions is the single button, absent on a gate with nothing to offer. #below is FULL WIDTH and left-aligned
 * — the boot chain's step list, the only thing here that is a table rather than a message. */

defineProps<{ icon: IconName; title: string; spinner?: boolean }>();
</script>

<template>
    <div class="flex h-full w-full items-center justify-center p-8">
        <div class="animate-fade-in flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-line bg-card p-8 text-center">
            <span class="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-canvas text-muted">
                <Icon :name="icon" class="text-xl" />
            </span>
            <div class="flex flex-col gap-1.5">
                <h2 class="flex items-center justify-center gap-2 text-lg font-semibold text-content">
                    <Icon v-if="spinner" name="spinner" class="text-info" spin />
                    {{ title }}
                </h2>
                <slot />
            </div>
            <slot name="actions" />
            <!-- `w-full` is what lets this opt out of the card's own centring without a second card. -->
            <div v-if="$slots['below']" class="flex w-full flex-col gap-4"><slot name="below" /></div>
        </div>
    </div>
</template>
