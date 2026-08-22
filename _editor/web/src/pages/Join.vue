<script setup lang="ts">
import { Button, Card, Icon, Notice, type NoticeModel, Row } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import MembershipOffer from "../components/MembershipOffer.vue";
import { formatCredits as n, hasReturned, joinLabel, resetsAtLocal } from "../composables/membership/creditMeter";
import { useMembership } from "../composables/membership/useMembership";
import { apiClient } from "../composables/useApi";
import { useAuth } from "../composables/useAuth";

/* BUYING A MEMBERSHIP WITHOUT THE PRODUCT: the door for somebody whose agent asked for a paid run and who
 * has never opened this app in their life.
 *
 * The membership was always an ACCOUNT's, never a machine's: the credit meter is per account, the catalogue is
 * the platform's, and the ledger pays creators out of what accounts spend. But the only place to buy one was a
 * tab inside the workspace shell, and the shell's guard bounces anybody without a sandbox to /setup. So
 * "owns a machine" had quietly become a precondition for paying us, which it never was, and which is exactly
 * the wrong toll to charge somebody who arrived from a terminal thirty seconds ago holding a link.
 *
 * THIS PAGE IS OUTSIDE THE SHELL for that reason and no other. Same offer, same figures, same Stripe: the
 * pitch is one shared component (components/MembershipOffer.vue) precisely so the two cannot drift, but no
 * rail, no sandbox switcher, no setup redirect, and a finish line that says "go back to your terminal" rather
 * than dropping somebody into a workspace they did not ask for and cannot use.
 *
 * THE POST-CHECKOUT GAP is the settings tab's problem too, and gets the same answer: Stripe returns the
 * browser before the webhook that makes the membership real has necessarily landed, so this polls for a
 * bounded while rather than asking the person who just paid to reload. */

const route = useRoute();
const { user, refresh, signInWithGoogle } = useAuth();
const { state: membership, meter: credits, error, refetch } = useMembership();

const resolving = ref(true);
const working = ref(false);
const actionError = ref<string | undefined>();

const loadError = computed<NoticeModel | undefined>(() =>
    error.value === null ? undefined : { tone: `danger`, title: `Couldn't load the membership.`, detail: errorMessage(error.value, ``) },
);

onMounted(async () => {
    await refresh().catch(() => undefined);
    resolving.value = false;
});

const signIn = (): Promise<void> => signInWithGoogle(route.fullPath);

// ---- the post-checkout wait ------------------------------------------------------------------------------

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

const watchForActivation = (): void => {
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
};

onMounted(watchForActivation);

// ---- the offer -------------------------------------------------------------------------------------------

const returning = computed(() => hasReturned(membership.value));
const buyLabel = computed(() => joinLabel(membership.value, returning.value));
const resetsAt = computed(() => resetsAtLocal(credits.value));

const checkout = async (): Promise<void> => {
    if (working.value) {
        return;
    }
    working.value = true;
    actionError.value = undefined;
    try {
        // `join` is the lane: Stripe returns HERE, not to a settings tab this reader cannot reach.
        const { url } = await apiClient.pool.checkout({ returnTo: `join` });
        window.location.href = url;
    } catch (err) {
        actionError.value = errorMessage(err, `Couldn't open the payment page.`);
        working.value = false;
    }
};

/* WHICH SCREEN THIS IS. Five states, and the ordering matters: a member who just paid must see the finish
 * line rather than the offer they already accepted, and somebody signed out must not read a price behind a
 * button that would only ask them to sign in. */
const view = computed(() => {
    if (resolving.value || membership.value === undefined) {
        return `loading`;
    }
    if (membership.value.enabled === false) {
        return `unavailable`;
    }
    if (user.value === null) {
        return `signin`;
    }
    if (membership.value.member) {
        return `member`;
    }
    return activating.value ? `activating` : `offer`;
});
</script>

<template>
    <div class="min-h-screen w-full bg-canvas p-6 text-content @container">
        <div class="animate-fade-in mx-auto flex w-full max-w-4xl flex-col gap-4">
            <img src="/assets/intentic-full.png" alt="intentic platform" class="mb-4 h-8 w-auto" />

            <div v-if="view === 'loading'" class="flex items-center gap-3 text-sm text-muted">
                <Icon name="spinner" spin />
                <span>Loading…</span>
            </div>

            <Card v-else-if="view === 'unavailable'">
                <Row flush :heading="2" icon="star" title="Membership" description="This platform doesn't offer memberships." />
            </Card>

            <!-- ══ SIGN IN ══════════════════════════════════════════════════════════════════════════════════
                 An account first, because a membership belongs to one. Deliberately not a wall of pitch: this
                 reader was sent here by their own agent and already knows why they came. -->
            <template v-else-if="view === 'signin'">
                <Card class="border-primary-fill/25 bg-primary-fill/[0.07]">
                    <h1 class="text-2xl font-semibold leading-tight tracking-tight">Join intentic</h1>
                    <p class="mt-2 max-w-prose text-sm text-muted">
                        A membership lets your coding agent run the platform's paid services: priced in credits, approved by you one run at a time,
                        and refunded whenever a service doesn't answer. No sandbox and no install needed.
                    </p>
                    <Button label="Continue with Google" severity="secondary" class="mt-5 justify-center" @click="signIn">
                        <template #icon><Icon name="google" /></template>
                    </Button>
                    <p class="mt-3 text-2xs text-subtle">You'll see the price before anything is charged.</p>
                </Card>
            </template>

            <!-- ══ ACTIVATING ═══════════════════════════════════════════════════════════════════════════════
                 The webhook's few seconds, owned by the app rather than handed back to the person who paid. -->
            <Card v-else-if="view === 'activating'" class="border-primary-fill/25 bg-primary-fill/5">
                <Row
                    flush
                    :heading="2"
                    icon="spinner"
                    spin
                    tone="info"
                    title="Payment received: activating your membership"
                    description="This takes a few seconds. The page updates itself; there's nothing to click."
                />
            </Card>

            <!-- ══ DONE ═════════════════════════════════════════════════════════════════════════════════════
                 THE FINISH LINE, and the one screen this page exists to get right. Somebody who came from a
                 terminal must be sent back to it, not dropped into a workspace shell they never asked for,
                 which is what every other "you're a member" surface in this product does. -->
            <template v-else-if="view === 'member'">
                <Card class="border-success/40 bg-success/[0.07]">
                    <Row
                        flush
                        :heading="2"
                        icon="check-circle"
                        tone="success"
                        :title="justJoined ? `You're in.` : `You're a member.`"
                        description="Head back to your terminal: your agent can use the services catalogue now."
                    />
                    <div v-if="credits" class="mt-4 flex flex-col gap-2">
                        <div class="flex flex-wrap items-baseline gap-x-2">
                            <span class="text-3xl font-semibold leading-none tabular-nums text-content">{{ n(credits.remaining) }}</span>
                            <span class="text-sm text-muted">of {{ n(credits.allowance) }} credits left today</span>
                            <span v-if="resetsAt" class="ml-auto text-xs text-subtle">resets at {{ resetsAt }}</span>
                        </div>
                        <div class="h-1.5 overflow-hidden rounded-full bg-content/10">
                            <div class="h-full rounded-full bg-primary-fill transition-[width]" :style="{ width: `${credits.remainingPercent}%` }" />
                        </div>
                    </div>
                </Card>

                <!-- What to actually do next, in the words of the place they came from. A "you're a member"
                     screen with no next step is where a new member goes quiet. -->
                <Card>
                    <p class="text-xs font-semibold uppercase tracking-wider text-subtle">Back in your terminal</p>
                    <ol class="mt-3 flex flex-col gap-3">
                        <li class="flex gap-3 text-sm text-muted">
                            <span class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold"
                                >1</span
                            >
                            <span>Ask your agent to try the run again. It will find the membership on its next call.</span>
                        </li>
                        <li class="flex gap-3 text-sm text-muted">
                            <span class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold"
                                >2</span
                            >
                            <span>It sends you one approval link per run. Nothing is charged until you click it.</span>
                        </li>
                        <li class="flex gap-3 text-sm text-muted">
                            <span class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold"
                                >3</span
                            >
                            <span>Manage or cancel the membership any time from Stripe's own portal.</span>
                        </li>
                    </ol>
                </Card>
            </template>

            <!-- ══ THE OFFER ════════════════════════════════════════════════════════════════════════════════ -->
            <template v-else>
                <Notice
                    v-if="justJoined"
                    :of="{
                        tone: `info`,
                        title: `Your payment went through, but the membership hasn't come back from Stripe yet.`,
                        detail: `This is unusual. Reload in a minute, if it still isn't here, get in touch and nothing will be charged twice.`,
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
                <MembershipOffer :return-to="`join`" :join-label="buyLabel" :working="working" @checkout="checkout">
                    <template #headline>Let your agent run paid services.</template>
                    <template #promise>
                        One membership, a day's credits, and an approval link for every run, so your agent can ask for paid research, data and compute
                        without ever being able to spend on its own.
                    </template>
                </MembershipOffer>
            </template>

            <Notice v-if="loadError" :of="loadError" />
            <Notice v-if="actionError" :of="{ tone: `danger`, title: `Couldn't open the payment page.`, detail: actionError }" />
        </div>
    </div>
</template>
