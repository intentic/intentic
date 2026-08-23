<script setup lang="ts">
import { Button, Card, Icon, Notice, Row, useLoadingReveal } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import MembershipOffer from "../../components/MembershipOffer.vue";
import { formatCredits as n, installsFor, joinLabel, resetsAtLocal } from "../../composables/membership/creditMeter";
import { useMembership } from "../../composables/membership/useMembership";
import { apiClient } from "../../composables/useApi";
import { environment } from "../../environments/environment";

/* Membership: the one paid thing on the platform, bought and managed on Stripe's pages. The card only ever
 * states where things stand and opens the right door, but WHICH card is a different question before and
 * after the money, and the two used to be one paragraph apart.
 *
 * THIS IS A BUYING PAGE, and it is the only one in the product. A member arrives to check a number; a
 * non-member arrives to decide, and the decision is the whole event: nothing else in the app asks anyone for
 * twenty dollars a month. So the offer branch is laid out like an offer: what you get in figures, the price
 * as a price, one action, and the objections answered where they occur, and the member branch is laid out
 * like a meter, because "how much have I got left today" is the only question it is ever opened with.
 *
 * EVERY NUMBER ON SCREEN IS THE PLATFORM'S. The price, the share, the daily allowance and what an install
 * donates all arrive on the membership state, and what a day's credits COME TO (five installs) is
 * arithmetic done here rather than a sentence somebody typed. A written "five installs a day" survives the
 * config change that makes it false, and nothing fails to warn anybody; a division cannot.
 *
 * The economics are said out loud on purpose (the price, the creators' share, the public ledger link): the
 * pool's promise is transparency, and the buying surface is the cheapest place in the product to keep it. */

/* The state, and the credit meter's arithmetic, both come from the app's ONE membership read
 * (composables/membership), the same entry the account menu, the premium install dialog and the chat composer
 * observe. This card is no longer the only place credits appear, so it must not be the place they are computed:
 * a second copy of "what percent is left" is how four surfaces start disagreeing. */
const { state: membership, meter: credits, donationCredits, dailyCredits, error, refetch } = useMembership();

const working = ref(false);
const actionError = ref<string | undefined>(undefined);

const loadError = computed(() => (error.value === null ? undefined : errorMessage(error.value, `Couldn't load the membership state.`)));

/* The membership read is SHARED (the account menu is usually already holding its answer by the time this tab
 * opens), so the common case here is no wait at all, which is exactly the case an ungated outline would ruin
 * with a flash of grey where the meter belongs. */
const outline = useLoadingReveal(
    computed(() => membership.value === undefined && error.value === null),
    computed(() => `membership`),
);

/* THE POST-CHECKOUT GAP. Stripe sends the browser back with ?membership=welcome, but the webhook that makes
 * the membership real can land seconds later, so the first read after a completed payment often still says
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

onMounted(() => {
    if (!justJoined.value || membership.value?.member === true) {
        return;
    }
    activating.value = true;
    const until = Date.now() + POLL_FOR_MS;
    poll = setInterval(() => {
        void refetch().then(() => {
            if (membership.value?.member === true || Date.now() > until) {
                stopPolling();
            }
        });
    }, POLL_EVERY_MS);
});

// ---- the published figures, and what they come to -------------------------------------------------------
// The OFFER's figures (price, share, what a day buys) live in MembershipOffer.vue with the pitch that quotes
// them. What stays here is what only the member branch reads.

const sharePercent = computed(() => Math.round((membership.value?.creatorShare ?? 0) * 100));

const renewsOn = computed(() => {
    const stamp = membership.value?.renewsAt;
    return stamp === undefined ? undefined : new Date(stamp).toLocaleDateString(undefined, { year: `numeric`, month: `long`, day: `numeric` });
});

// ---- the member's meter ---------------------------------------------------------------------------------

const resetsAt = computed(() => resetsAtLocal(credits.value));

// What is LEFT, in installs: the same arithmetic as the offer, against today's remainder rather than the
// allowance. A member reading a meter wants to know what they can still do, not what they could have done.
const installsLeft = computed(() => installsFor(credits.value?.remaining ?? 0, donationCredits.value));

/* ---- LAPSED IS NOT THE SAME AS NEVER ------------------------------------------------------------------
 *
 * The platform's premium rule (pool-membership.ts) counts `active` and `trialing` and nothing else, so a
 * member whose card was declined arrives here with `member: false`, the same answer as somebody who has
 * never paid. Rendered as one branch, that put the cold sales pitch in front of the person who is already
 * paying and whose card merely expired, under a button that would have opened a SECOND subscription beside
 * the one Stripe is still retrying.
 *
 * So the two are told apart by whether a payment can still rescue what exists. `past_due` and `unpaid` are
 * Stripe retrying a live subscription, and `incomplete` is a first charge that never confirmed: all three
 * want the card fixed, not the product sold. Anything else that is not premium (`canceled`,
 * `incomplete_expired`) really is over, and its reader is a prospect again, greeted rather than lectured. */
const RECOVERABLE = new Set([`past_due`, `unpaid`, `incomplete`]);

const lapsed = computed(() => {
    const status = membership.value?.status;
    return membership.value?.member === false && status !== undefined && RECOVERABLE.has(status) ? status : undefined;
});

// A previous membership that ended. Only changes the offer's greeting. The reasons to join are the same
// ones, and someone deciding a second time deserves to read them rather than a shorter version.
const returning = computed(() => membership.value?.member === false && membership.value.status !== undefined && lapsed.value === undefined);

// A trial is a membership with an end date rather than a renewal date, and calling it "renews" would be the
// one word that costs somebody money they didn't expect to spend.
const onTrial = computed(() => membership.value?.status === `trialing`);

// The action's own name, phrased in creditMeter.ts so /join says it identically.
const buyLabel = computed(() => joinLabel(membership.value, returning.value));

// The public ledger, served by the platform for anyone. Members are exactly who should read it.
const transparencyUrl = `${environment.api.url}/pool/transparency`;

const open = async (door: `checkout` | `portal`): Promise<void> => {
    if (working.value) {
        return;
    }
    working.value = true;
    actionError.value = undefined;
    try {
        const { url } = await (door === `checkout` ? apiClient.pool.checkout({ returnTo: `settings` }) : apiClient.pool.portal());
        window.location.href = url;
    } catch (err) {
        actionError.value = errorMessage(err, `Couldn't open the payment page.`);
        working.value = false;
    }
};
</script>

<template>
    <div class="@container flex flex-col gap-4">
        <Notice v-if="loadError" :of="{ tone: `danger`, title: `Couldn't load your membership.`, detail: loadError }" />

        <Card v-else-if="membership && !membership.enabled">
            <Row flush :heading="2" icon="star" title="Membership" description="This platform doesn't offer memberships." />
        </Card>

        <!-- ══ MEMBER ══════════════════════════════════════════════════════════════════════════════════════
             A meter first, because that is the question this page gets asked. Everything the offer spends its
             room arguing is settled: what is left today, when it comes back, and where the money went. -->
        <template v-else-if="membership && membership.member">
            <Card>
                <Row flush :heading="2" icon="check-circle" tone="success" :title="onTrial ? `You're on trial` : `You're a member`">
                    <template #meta>
                        <span v-if="renewsOn">{{ onTrial ? `trial ends` : `renews` }} {{ renewsOn }}</span>
                    </template>
                </Row>

                <!-- The meter. The number is the headline because it is the answer; the bar exists to make
                     "a lot left" and "nearly out" readable without reading, and carries no colour meaning of
                     its own: a low meter is not a fault, it is a day's work done. -->
                <div v-if="credits" class="mt-4 flex flex-col gap-2">
                    <div class="flex flex-wrap items-baseline gap-x-2">
                        <span class="text-3xl font-semibold leading-none tabular-nums text-content">{{ n(credits.remaining) }}</span>
                        <span class="text-sm text-muted">of {{ n(credits.allowance) }} credits left today</span>
                        <span v-if="resetsAt" class="ml-auto text-xs text-subtle">resets at {{ resetsAt }}</span>
                    </div>
                    <div class="h-1.5 overflow-hidden rounded-full bg-content/10">
                        <div class="h-full rounded-full bg-primary-fill transition-[width]" :style="{ width: `${credits.remainingPercent}%` }" />
                    </div>
                    <!-- What is left, and where to put it. An unspent allowance pays nobody and reads, a month
                         later, as a membership that bought nothing, so the meter names the next step instead
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
                            >Spent for today. The allowance comes back in full at the reset. Nothing rolls over, nothing is owed.</template
                        >
                    </p>
                </div>

                <div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <p class="min-w-0 flex-1 text-xs text-muted">
                        {{ sharePercent }}% of every credit you spend reaches the creator of what you installed or ran, on a
                        <a :href="transparencyUrl" target="_blank" rel="noopener" class="text-link hover:underline">public ledger</a>.
                    </p>
                    <!-- The money tier, not the neutral one. It is the only action on a member's page, and what
                         it opens is the subscription itself — the same door as "join", from the other side. A
                         quiet fill here left the one page in the product that is about money with nothing on it
                         that looked like money. -->
                    <Button label="Manage on Stripe" size="small" class="ui-button-loud" :loading="working" @click="open(`portal`)" />
                </div>
            </Card>
        </template>

        <!-- ══ LAPSED ══════════════════════════════════════════════════════════════════════════════════════
             A member whose card stopped working. One thing to do, said warmly and without a sales pitch: this
             reader has already decided, and the only question left is a payment method. -->
        <Card v-else-if="membership && lapsed" class="border-warning/40 bg-warning/[0.07]">
            <Row
                flush
                :heading="2"
                icon="exclamation-circle"
                tone="warning"
                title="Your membership needs a working card"
                description="Payment failed. Update your card to restore access."
            >
                <template #below>
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Button label="Update payment on Stripe" :loading="working" class="ui-button-loud" @click="open(`portal`)" />
                        <p class="text-2xs text-subtle">Stripe reports this membership as "{{ lapsed }}".</p>
                    </div>
                </template>
            </Row>
        </Card>

        <!-- ══ ACTIVATING ══════════════════════════════════════════════════════════════════════════════════
             The webhook's few seconds, owned by the app rather than handed back to the person who just paid. -->
        <Card v-else-if="membership && justJoined && activating" class="border-primary-fill/25 bg-primary-fill/5">
            <Row
                flush
                :heading="2"
                icon="spinner"
                spin
                tone="info"
                title="Payment received, activating your membership"
                description="Activating membership…"
            />
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
                    detail: `This is unusual. Reload in a minute. If it still isn't here, get in touch and nothing will be charged twice.`,
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

            <!-- The pitch itself lives in components/MembershipOffer.vue, shared with /join. The buying
                 surface for somebody who arrived from a terminal and has no sandbox to put a settings tab in.
                 One copy, because two would drift about what a membership is, on the one page where being
                 wrong costs trust rather than a rerender. -->
            <MembershipOffer :return-to="`settings`" :join-label="buyLabel" :working="working" browsable @checkout="open(`checkout`)" />
        </template>

        <!-- ══ THE WAIT ════════════════════════════════════════════════════════════════════════════════════
             Every branch above needs the membership state, so before it lands this tab is an empty column,
             and this is the tab reached by a member who came to check one number, which makes the blank beat
             the most conspicuous one in the hub.

             ONE MODEST CARD, NOT EITHER REAL ONE. The two outcomes are a compact meter and a full sales page,
             and there is no way to know which is coming: outlining the offer would flash a hero at a paying
             member, and outlining the meter would promise a number to somebody about to be sold to. So this
             promises only what BOTH open with: a masthead row, one large figure or headline, and a couple of
             supporting lines, and stops there rather than guessing at the half that differs. -->
        <Card v-else-if="outline" role="status" aria-busy="true">
            <span class="sr-only">Reading your membership…</span>
            <Row flush :heading="2" aria-hidden="true">
                <template #lead><span class="skeleton block h-4.5 w-4.5 shrink-0" /></template>
                <template #title>
                    <span class="flex min-h-[1lh] items-center"><span class="skeleton block h-4 w-44" /></span>
                </template>
                <template #meta><span class="skeleton block h-2.5 w-28" /></template>
            </Row>
            <div class="mt-4 flex flex-col gap-2" aria-hidden="true">
                <!-- The large figure both branches lead with: the meter's remaining-credits number and the
                     offer's headline are the same size on screen, so one bar stands in for either. -->
                <span class="skeleton block h-8 w-56" />
                <span class="skeleton block h-2.5 w-full max-w-md" />
                <span class="skeleton block h-2.5 w-2/3 max-w-sm" />
            </div>
        </Card>

        <Notice v-if="actionError" :of="{ tone: `danger`, title: `Couldn't open the payment page.`, detail: actionError }" />
    </div>
</template>
