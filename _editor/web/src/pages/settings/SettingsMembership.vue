<script setup lang="ts">
import type { MembershipState } from "@intentic-app/api-contract";
import { Card, Icon, Notice } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import { apiClient } from "../../composables/useApi";
import { environment } from "../../environments/environment";

/* Membership: the one paid thing on the platform, bought and managed on Stripe's pages. The card only ever
 * states where things stand and opens the right door — but WHICH card is a different question before and
 * after the money, and the two used to be one paragraph apart.
 *
 * THIS IS A BUYING PAGE, and it is the only one in the product. A member arrives to check a number; a
 * non-member arrives to decide, and the decision is the whole event: nothing else in the app asks anyone for
 * twenty dollars a month. So the offer branch is laid out like an offer — what you get in figures, the price
 * as a price, one action, and the objections answered where they occur — and the member branch is laid out
 * like a meter, because "how much have I got left today" is the only question it is ever opened with.
 *
 * EVERY NUMBER ON SCREEN IS THE PLATFORM'S. The price, the share, the daily allowance and what an install
 * donates all arrive on the membership state, and what a day's credits COME TO — five installs — is
 * arithmetic done here rather than a sentence somebody typed. A written "five installs a day" survives the
 * config change that makes it false, and nothing fails to warn anybody; a division cannot.
 *
 * The economics are said out loud on purpose (the price, the creators' share, the public ledger link): the
 * pool's promise is transparency, and the buying surface is the cheapest place in the product to keep it. */

const membership = ref<MembershipState | null>(null);
const loadError = ref<string | undefined>(undefined);
const working = ref(false);
const actionError = ref<string | undefined>(undefined);

const load = async (): Promise<void> => {
    try {
        membership.value = await apiClient.pool.membership();
        loadError.value = undefined;
    } catch (err) {
        loadError.value = errorMessage(err, `Couldn't load the membership state.`);
    }
};

/* THE POST-CHECKOUT GAP. Stripe sends the browser back with ?membership=welcome, but the webhook that makes
 * the membership real can land seconds later — so the first read after a completed payment often still says
 * "not a member". This used to be a sentence asking the reader to reload, which is the app handing its own
 * race back to the person who just paid. It polls instead, and gives up after a bounded wait rather than
 * spinning forever: a webhook that has not arrived in half a minute is a problem a refresh will not fix. */
const route = useRoute();
const justJoined = computed(() => route.query[`membership`] === `welcome`);
const activating = ref(false);

const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 40_000;
let poll: ReturnType<typeof setInterval> | undefined;

const stopPolling = (): void => {
    if (poll !== undefined) {
        clearInterval(poll);
        poll = undefined;
    }
    activating.value = false;
};

onUnmounted(stopPolling);

onMounted(async () => {
    await load();
    if (!justJoined.value || membership.value?.member === true) {
        return;
    }
    activating.value = true;
    const until = Date.now() + POLL_FOR_MS;
    poll = setInterval(() => {
        void load().then(() => {
            if (membership.value?.member === true || Date.now() > until) {
                stopPolling();
            }
        });
    }, POLL_EVERY_MS);
});

// ---- the published figures, and what they come to -------------------------------------------------------

const n = (value: number): string => value.toLocaleString();

const priceUsd = computed(() => membership.value?.priceUsd ?? 0);
const sharePercent = computed(() => Math.round((membership.value?.creatorShare ?? 0) * 100));
const platformPercent = computed(() => 100 - sharePercent.value);
const dailyCredits = computed(() => membership.value?.dailyCredits ?? 0);
const donationCredits = computed(() => membership.value?.donationCredits ?? 0);

// What a day's allowance buys, in the one unit every reader of this page already understands. Guarded
// against a zero donation price, which is a configuration a self-hosted platform is allowed to have.
const installsPerDay = computed(() => (donationCredits.value > 0 ? Math.floor(dailyCredits.value / donationCredits.value) : 0));

const renewsOn = computed(() => {
    const stamp = membership.value?.renewsAt;
    return stamp === undefined ? undefined : new Date(stamp).toLocaleDateString(undefined, { year: `numeric`, month: `long`, day: `numeric` });
});

// ---- the member's meter ---------------------------------------------------------------------------------

const credits = computed(() => membership.value?.credits);

// Reset is UTC midnight; rendered as the reader's local time so "resets at" is a clock they own.
const resetsAt = computed(() => {
    const at = credits.value?.resetsAt;
    return at === undefined ? undefined : new Date(at).toLocaleTimeString(undefined, { hour: `numeric`, minute: `2-digit` });
});

const remainingPercent = computed(() => {
    const meter = credits.value;
    if (meter === undefined || meter.allowance <= 0) {
        return 0;
    }
    return Math.round((meter.remaining / meter.allowance) * 100);
});

// What is LEFT, in installs — the same arithmetic as the offer, against today's remainder rather than the
// allowance. A member reading a meter wants to know what they can still do, not what they could have done.
const installsLeft = computed(() => (donationCredits.value > 0 ? Math.floor((credits.value?.remaining ?? 0) / donationCredits.value) : 0));

/* ---- LAPSED IS NOT THE SAME AS NEVER ------------------------------------------------------------------
 *
 * The platform's premium rule (pool-membership.ts) counts `active` and `trialing` and nothing else, so a
 * member whose card was declined arrives here with `member: false` — the same answer as somebody who has
 * never paid. Rendered as one branch, that put the cold sales pitch in front of the person who is already
 * paying and whose card merely expired, under a button that would have opened a SECOND subscription beside
 * the one Stripe is still retrying.
 *
 * So the two are told apart by whether a payment can still rescue what exists. `past_due` and `unpaid` are
 * Stripe retrying a live subscription, and `incomplete` is a first charge that never confirmed: all three
 * want the card fixed, not the product sold. Anything else that is not premium — `canceled`,
 * `incomplete_expired` — really is over, and its reader is a prospect again, greeted rather than lectured. */
const RECOVERABLE = new Set([`past_due`, `unpaid`, `incomplete`]);

const lapsed = computed(() => {
    const status = membership.value?.status;
    return membership.value?.member === false && status !== undefined && RECOVERABLE.has(status) ? status : undefined;
});

// A previous membership that ended. Only changes the offer's greeting — the reasons to join are the same
// ones, and someone deciding a second time deserves to read them rather than a shorter version.
const returning = computed(() => membership.value?.member === false && membership.value.status !== undefined && lapsed.value === undefined);

// A trial is a membership with an end date rather than a renewal date, and calling it "renews" would be the
// one word that costs somebody money they didn't expect to spend.
const onTrial = computed(() => membership.value?.status === `trialing`);

// The action's own name. "Rejoin" for somebody who has been here before — the button is the last thing read
// before a decision, and it should know which decision it is.
const joinLabel = computed(() => `${returning.value ? `Rejoin` : `Join`} for $${n(priceUsd.value)}/month`);

// The public ledger, served by the platform for anyone — members are exactly who should read it.
const transparencyUrl = `${environment.api.url}/pool/transparency`;

const open = async (door: `checkout` | `portal`): Promise<void> => {
    if (working.value) {
        return;
    }
    working.value = true;
    actionError.value = undefined;
    try {
        const { url } = await (door === `checkout` ? apiClient.pool.checkout() : apiClient.pool.portal());
        window.location.href = url;
    } catch (err) {
        actionError.value = errorMessage(err, `Couldn't open the payment page.`);
        working.value = false;
    }
};

/* The reassurances, as data. All four are answers to questions a reader asks silently at the button, and
 * they are the same four whether they are read before joining or after — so they are declared once and
 * rendered in both branches rather than written twice and allowed to drift. */
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
    <div class="@container flex flex-col gap-4">
        <Notice v-if="loadError" :of="{ tone: `danger`, title: `Couldn't load your membership.`, detail: loadError }" />

        <Card v-else-if="membership && !membership.enabled">
            <div class="flex items-center gap-2.5">
                <Icon name="star" class="text-lg text-muted" />
                <div>
                    <h2 class="font-semibold leading-tight">Membership</h2>
                    <p class="text-xs text-muted">This platform doesn't offer memberships.</p>
                </div>
            </div>
        </Card>

        <!-- ══ MEMBER ══════════════════════════════════════════════════════════════════════════════════════
             A meter first, because that is the question this page gets asked. Everything the offer spends its
             room arguing is settled: what is left today, when it comes back, and where the money went. -->
        <template v-else-if="membership && membership.member">
            <Card>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Icon name="check-circle" class="text-lg text-success" />
                    <h2 class="font-semibold leading-tight">{{ onTrial ? `You're on trial` : `You're a member` }}</h2>
                    <span v-if="renewsOn" class="ml-auto text-xs text-subtle">{{ onTrial ? `trial ends` : `renews` }} {{ renewsOn }}</span>
                </div>

                <!-- The meter. The number is the headline because it is the answer; the bar exists to make
                     "a lot left" and "nearly out" readable without reading, and carries no colour meaning of
                     its own — a low meter is not a fault, it is a day's work done. -->
                <div v-if="credits" class="mt-4 flex flex-col gap-2">
                    <div class="flex flex-wrap items-baseline gap-x-2">
                        <span class="text-3xl font-semibold leading-none tabular-nums text-content">{{ n(credits.remaining) }}</span>
                        <span class="text-sm text-muted">of {{ n(credits.allowance) }} credits left today</span>
                        <span v-if="resetsAt" class="ml-auto text-xs text-subtle">resets at {{ resetsAt }}</span>
                    </div>
                    <div class="h-1.5 overflow-hidden rounded-full bg-content/10">
                        <div class="h-full rounded-full bg-primary-fill transition-[width]" :style="{ width: `${remainingPercent}%` }" />
                    </div>
                    <!-- What is left, and where to put it. An unspent allowance pays nobody and reads, a month
                         later, as a membership that bought nothing — so the meter names the next step instead
                         of leaving the reader to go and find it. Withheld when there is nothing left to spend:
                         an invitation to buy what today cannot afford is not a helpful one. -->
                    <p class="text-xs text-muted">
                        <template v-if="installsLeft > 0">
                            Enough for {{ n(installsLeft) }} more premium {{ installsLeft === 1 ? `install` : `installs` }} today, or any service run
                            you approve. ·
                            <RouterLink :to="{ name: `sandbox`, params: { tab: `discover` } }" class="text-link hover:underline">
                                Find something to spend them on
                            </RouterLink>
                        </template>
                        <template v-else
                            >Spent for today. The allowance comes back in full at the reset — nothing rolls over, nothing is owed.</template
                        >
                    </p>
                </div>

                <div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
                    <p class="min-w-0 flex-1 text-xs text-muted">
                        {{ sharePercent }}% of every credit you spend reaches the creator of what you installed or ran, on a
                        <a :href="transparencyUrl" target="_blank" rel="noopener" class="text-link hover:underline">public ledger</a>.
                    </p>
                    <Button label="Manage on Stripe" severity="secondary" :outlined="true" size="small" :loading="working" @click="open(`portal`)" />
                </div>
            </Card>
        </template>

        <!-- ══ LAPSED ══════════════════════════════════════════════════════════════════════════════════════
             A member whose card stopped working. One thing to do, said warmly and without a sales pitch: this
             reader has already decided, and the only question left is a payment method. -->
        <Card v-else-if="membership && lapsed" class="border-warning/40 bg-warning/[0.07]">
            <div class="flex gap-3">
                <Icon name="exclamation-circle" class="mt-0.5 shrink-0 text-lg text-warning" />
                <div class="min-w-0 flex-1">
                    <h2 class="font-semibold leading-tight">Your membership needs a working card</h2>
                    <p class="mt-1.5 text-sm text-muted">
                        Stripe couldn't take the last payment, so premium extensions are switched off until one goes through. Nothing else has changed
                        — what you've installed stays installed, and your allowance comes back the moment the charge clears.
                    </p>
                    <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Button
                            label="Update payment on Stripe"
                            :loading="working"
                            class="border-primary-fill! bg-primary-fill! px-5! font-semibold! text-fill-content! hover:bg-primary-fill-hover!"
                            @click="open(`portal`)"
                        />
                        <p class="text-2xs text-subtle">Stripe reports this membership as “{{ lapsed }}”.</p>
                    </div>
                </div>
            </div>
        </Card>

        <!-- ══ ACTIVATING ══════════════════════════════════════════════════════════════════════════════════
             The webhook's few seconds, owned by the app rather than handed back to the person who just paid. -->
        <Card v-else-if="membership && justJoined && activating" class="border-primary-fill/25 bg-primary-fill/5">
            <div class="flex items-center gap-3">
                <Icon name="spinner" class="animate-spin text-lg text-link" />
                <div class="min-w-0">
                    <h2 class="font-semibold leading-tight">Payment received — activating your membership</h2>
                    <p class="mt-0.5 text-xs text-muted">This takes a few seconds. The page updates itself; there's nothing to click.</p>
                </div>
            </div>
        </Card>

        <!-- ══ THE OFFER ═══════════════════════════════════════════════════════════════════════════════════
             The one buying surface in the product, laid out as one: the promise, the figures behind it, the
             price, one action, then the four objections answered in the order they get asked. -->
        <template v-else-if="membership">
            <Notice
                v-if="justJoined && !activating"
                :of="{
                    tone: `info`,
                    title: `Your payment went through, but the membership hasn't come back from Stripe yet.`,
                    detail: `This is unusual. Reload in a minute — if it still isn't here, get in touch and nothing will be charged twice.`,
                }"
            />

            <Notice
                v-if="returning"
                :of="{
                    tone: `info`,
                    title: `Your previous membership has ended.`,
                    detail: `Joining again starts a fresh month. Nothing was carried over, and nothing is owed.`,
                }"
            />

            <!-- The hero. Accent-tinted rather than another plain card: this is the one thing on the page a
                 first-time reader must land on, and a settings hub is a stack of identical rectangles.

                 THE PRICE IS ITS OWN BOX, on the side the eye finishes on. Laid out down the card instead, the
                 promise and the price were the same column and the money read as a footnote to the sentence
                 above it — and the right half of a 60rem card was empty while it did. -->
            <Card class="border-primary-fill/25 bg-primary-fill/[0.07]">
                <div class="flex flex-col gap-5 @2xl:flex-row @2xl:items-center @2xl:gap-8">
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                            <Icon name="star" class="text-base text-link" />
                            <span class="text-2xs font-semibold uppercase tracking-wider text-link">Membership</span>
                        </div>
                        <h2 class="mt-3 text-2xl font-semibold leading-tight text-content">Unlock every premium extension.</h2>
                        <p class="mt-2 text-sm text-muted">
                            One membership, {{ n(dailyCredits) }} credits a day, and {{ sharePercent }}% of every credit you spend paid straight to
                            whoever built the thing you used.
                        </p>
                    </div>

                    <div class="shrink-0 rounded-lg border border-line bg-card p-4 @2xl:w-64">
                        <div class="flex items-baseline gap-1.5">
                            <span class="text-4xl font-semibold leading-none tracking-tight text-content">${{ n(priceUsd) }}</span>
                            <span class="text-sm text-muted">/month</span>
                        </div>
                        <Button
                            :label="joinLabel"
                            :loading="working"
                            class="mt-3 w-full! border-primary-fill! bg-primary-fill! font-semibold! text-fill-content! hover:bg-primary-fill-hover!"
                            @click="open(`checkout`)"
                        />
                        <p class="mt-2 text-center text-2xs text-subtle">Paid through Stripe · cancel any time</p>
                    </div>
                </div>
            </Card>

            <!-- What the money actually buys, in figures rather than adjectives. Three, because there are
                 exactly three things a credit can be: an install, a run, and somebody's income. -->
            <div class="grid grid-cols-1 gap-3 @xl:grid-cols-3">
                <Card class="flex flex-col gap-1">
                    <span class="flex size-7 items-center justify-center rounded-md bg-primary-fill/12 text-link"><Icon name="box" /></span>
                    <p class="mt-1.5 text-lg font-semibold leading-tight text-content">
                        {{ n(installsPerDay) }} premium {{ installsPerDay === 1 ? `install` : `installs` }} a day
                    </p>
                    <p class="text-xs text-muted">
                        {{ n(donationCredits) }} credits each, the same figure for every extension in the catalogue. Once it's installed, using it is
                        free forever.
                    </p>
                </Card>

                <Card class="flex flex-col gap-1">
                    <span class="flex size-7 items-center justify-center rounded-md bg-primary-fill/12 text-link"><Icon name="bolt" /></span>
                    <p class="mt-1.5 text-lg font-semibold leading-tight text-content">{{ n(dailyCredits) }} service credits a day</p>
                    <p class="text-xs text-muted">
                        For the runs that cost real money — paid data, real compute. Your agent quotes the price before each one and waits for your
                        yes.
                    </p>
                </Card>

                <Card class="flex flex-col gap-1">
                    <span class="flex size-7 items-center justify-center rounded-md bg-primary-fill/12 text-link"><Icon name="users" /></span>
                    <p class="mt-1.5 text-lg font-semibold leading-tight text-content">{{ sharePercent }}% reaches the creator</p>
                    <!-- The split, drawn. It is the one claim on this page a reader is entitled to disbelieve,
                         so it gets a picture and a link to the ledger it is settled on. -->
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

            <!-- The four questions asked at the button. Answered here, next to it, rather than in a help page
                 the reader would have to leave the decision to find. -->
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

                <!-- The action, and the one way out that is not "leave". A reader who wants to see what is
                     behind the gate before paying for it should be sent to look, not talked past: Discover
                     badges every premium listing, and a catalogue nobody can see is not a reason to buy. -->
                <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-4">
                    <Button
                        :label="joinLabel"
                        :loading="working"
                        class="border-primary-fill! bg-primary-fill! px-5! font-semibold! text-fill-content! hover:bg-primary-fill-hover!"
                        @click="open(`checkout`)"
                    />
                    <RouterLink :to="{ name: `sandbox`, params: { tab: `discover` } }" class="text-xs text-link hover:underline">
                        See what's premium first
                    </RouterLink>
                    <p class="w-full text-xs text-muted">
                        Credits you never spend pay nobody — the membership is what you'd like to give, not a bill for what you took.
                    </p>
                </div>
            </Card>
        </template>

        <Notice v-if="actionError" :of="{ tone: `danger`, title: `Couldn't open the payment page.`, detail: actionError }" />
    </div>
</template>
