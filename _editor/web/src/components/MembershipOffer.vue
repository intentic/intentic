<script setup lang="ts">
import { Button, Card, Icon } from "@intentic/ui";
import { computed } from "vue";
import { formatCredits as n, installsFor } from "../composables/membership/creditMeter";
import { useMembership } from "../composables/membership/useMembership";
import { environment } from "../environments/environment";

/* THE OFFER: the one thing this product ever asks anybody for money for, and now the one COMPONENT that
 * asks. It used to live inside the membership settings tab, which was fine while that tab was the only
 * buying surface. It stopped being the only one the moment a coding agent outside a sandbox could need a
 * membership: those people never reach settings (the workspace shell would bounce them to setup, which is
 * the exact wrong thing to show somebody who came to pay), so they get /join instead.
 *
 * Two surfaces, one pitch. A second copy of the price, the split and the four reassurances is how the two
 * start disagreeing about what a membership is, and this is the page where being wrong costs trust rather
 * than a rerender.
 *
 * EVERY NUMBER IS THE PLATFORM'S. The price, the share and the daily allowance arrive on the membership
 * state; what a day's credits COME TO is arithmetic here rather than a sentence somebody typed, because a
 * written "five installs a day" survives the config change that makes it false and a division cannot. */

const props = defineProps<{
    // Which lane the checkout should return to. The two buying surfaces are not the same journey home.
    returnTo: `settings` | `join`;
    // The action's own name: "Join" or "Rejoin". The button is the last thing read before a decision.
    joinLabel: string;
    working?: boolean;
    // Whether to offer the in-product "see what's premium first" escape. Meaningless outside the shell.
    browsable?: boolean;
}>();

const emit = defineEmits<{ checkout: [] }>();

const { state: membership, donationCredits, dailyCredits } = useMembership();

const priceUsd = computed(() => membership.value?.priceUsd ?? 0);
const sharePercent = computed(() => Math.round((membership.value?.creatorShare ?? 0) * 100));
const platformPercent = computed(() => 100 - sharePercent.value);

// What a day's allowance buys, in the one unit every reader of this page already understands.
const installsPerDay = computed(() => installsFor(dailyCredits.value, donationCredits.value));

// The public ledger, served by the platform for anyone: a prospective member is exactly who should read it.
const transparencyUrl = `${environment.api.url}/pool/transparency`;

/* The reassurances, as data. All four answer questions a reader asks silently at the button, and they are
 * the same four wherever the button is. */
const assurances = computed(() => [
    { icon: `eye-slash` as const, title: `Nothing is metered`, body: `No usage counting anywhere in the product, and none asked for.` },
    {
        icon: `shield` as const,
        title: `You can't overspend`,
        body: `${n(dailyCredits.value)} credits a day is the ceiling, not a starting balance. Nothing bills on top of the membership.`,
    },
    { icon: `undo` as const, title: `A failed run costs nothing`, body: `If a service doesn't answer, its credits come straight back to you.` },
    {
        icon: `credit-card` as const,
        title: `Cancel any time`,
        body: `One click in Stripe's own portal. Card details never touch this platform.`,
    },
]);
</script>

<template>
    <!-- The hero. Accent-tinted rather than another plain card: this is the one thing a first-time reader
         must land on. The price is its own box, on the side the eye finishes on: laid out down the card
         instead, the money read as a footnote to the sentence above it. -->
    <Card class="border-primary-fill/25 bg-primary-fill/[0.07]">
        <div class="flex flex-col gap-5 @2xl:flex-row @2xl:items-center @2xl:gap-8">
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <Icon name="star" class="text-base text-link" />
                    <span class="text-2xs font-semibold uppercase tracking-wider text-link">Membership</span>
                </div>
                <h2 class="mt-3 text-2xl font-semibold leading-tight text-content"><slot name="headline">Unlock every premium extension.</slot></h2>
                <p class="mt-2 text-sm text-muted">
                    <slot name="promise">
                        One membership, {{ n(dailyCredits) }} credits a day, and {{ sharePercent }}% of every credit you spend paid straight to
                        whoever built the thing you used.
                    </slot>
                </p>
            </div>

            <div class="shrink-0 rounded-lg border border-line bg-card p-4 @2xl:w-64">
                <div class="flex items-baseline gap-1.5">
                    <span class="text-4xl font-semibold leading-none tracking-tight text-content">${{ n(priceUsd) }}</span>
                    <span class="text-sm text-muted">/month</span>
                </div>
                <Button :label="props.joinLabel" :loading="props.working" class="ui-button-loud mt-3 w-full" @click="emit(`checkout`)" />
                <p class="mt-2 text-center text-2xs text-subtle">Paid through Stripe · cancel any time</p>
            </div>
        </div>
    </Card>

    <!-- What the money actually buys, in figures rather than adjectives. Three, because there are exactly
         three things a credit can be: an install, a run, and somebody's income. -->
    <div class="grid grid-cols-1 gap-3 @xl:grid-cols-3">
        <Card class="flex flex-col gap-1">
            <span class="flex size-7 items-center justify-center rounded-md bg-primary-fill/12 text-link"><Icon name="box" /></span>
            <p class="mt-1.5 text-lg font-semibold leading-tight text-content">
                {{ n(installsPerDay) }} premium {{ installsPerDay === 1 ? `install` : `installs` }} a day
            </p>
            <p class="text-xs text-muted">
                {{ n(donationCredits) }} credits each, the same figure for every extension in the catalogue. Once it's installed, using it is free
                forever.
            </p>
        </Card>

        <Card class="flex flex-col gap-1">
            <span class="flex size-7 items-center justify-center rounded-md bg-primary-fill/12 text-link"><Icon name="bolt" /></span>
            <p class="mt-1.5 text-lg font-semibold leading-tight text-content">{{ n(dailyCredits) }} service credits a day</p>
            <p class="text-xs text-muted">
                For the runs that cost real money: paid data, real compute. Your agent quotes the price before each one and waits for your yes.
            </p>
        </Card>

        <Card class="flex flex-col gap-1">
            <span class="flex size-7 items-center justify-center rounded-md bg-primary-fill/12 text-link"><Icon name="users" /></span>
            <p class="mt-1.5 text-lg font-semibold leading-tight text-content">{{ sharePercent }}% reaches the creator</p>
            <!-- The split, drawn. It is the one claim on this page a reader is entitled to disbelieve, so it
                 gets a picture and a link to the ledger it is settled on. -->
            <div class="mt-1 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
                <div class="h-full rounded-full bg-primary-fill" :style="{ width: `${sharePercent}%` }" />
                <div class="h-full rounded-full bg-content/15" :style="{ width: `${platformPercent}%` }" />
            </div>
            <p class="text-xs text-muted">
                Of every credit you spend. The other {{ platformPercent }}% runs the platform, and every split is published on a
                <a :href="transparencyUrl" target="_blank" rel="noopener" class="text-link hover:underline">public ledger</a>.
            </p>
        </Card>
    </div>

    <!-- The four questions asked at the button. Answered here, next to it, rather than in a help page the
         reader would have to leave the decision to find. -->
    <Card>
        <div class="grid grid-cols-1 gap-x-6 gap-y-3 @lg:grid-cols-2">
            <div v-for="item in assurances" :key="item.title" class="flex gap-2.5">
                <Icon :name="item.icon" class="mt-0.5 shrink-0 text-sm text-success" />
                <div class="min-w-0">
                    <p class="text-xs font-semibold text-content">{{ item.title }}</p>
                    <p class="text-xs text-muted">{{ item.body }}</p>
                </div>
            </div>
        </div>

        <div class="mt-7 flex flex-wrap items-center gap-x-4 gap-y-3">
            <Button :label="props.joinLabel" :loading="props.working" class="ui-button-loud" @click="emit(`checkout`)" />
            <!-- The one way out that is not "leave", for a reader who wants to see behind the gate before
                 paying. Only offered inside the product: the extensions catalogue is a shell route, and sending
                 somebody with no sandbox there would bounce them into setup. -->
            <RouterLink
                v-if="props.browsable"
                :to="{ name: `sandbox`, params: { tab: `extensions` }, query: { view: `browse` } }"
                class="text-xs text-link hover:underline"
            >
                See what's premium first
            </RouterLink>
        </div>
    </Card>
</template>
